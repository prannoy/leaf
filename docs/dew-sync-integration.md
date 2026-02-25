# Dew (cc-mem) Sync Integration

Leaf syncs reading state (library, progress, and notes/annotations) to [cc-mem](https://github.com/prannoyp/cc-mem) (Dew), a local-first personal knowledge/memory system. The integration is **bidirectional** and uses cc-mem's REST API directly with no npm dependency.

## Architecture

```
Leaf Instance A (web)                cc-mem (Dew)               Leaf Instance B (iOS)
+------------------+                +---------------+           +------------------+
| useDewLibrarySync|--push books--> |               | <--pull---| useDewLibrarySync|
| useDewSync       |--push progress>|  REST API     | <--pull---| useDewSync       |
|                  |--push notes--> |  + SQLite     | <--pull---|                  |
|                  |<--pull books-- |  + file store  |--push--> |                  |
|                  |<--pull progress|               |--push--> |                  |
|                  |<--pull notes-- |               |--push--> |                  |
+------------------+                +---------------+           +------------------+
```

## API Endpoints Used

| Endpoint | Method | Purpose | Direction |
|---|---|---|---|
| `/api/v1/documents` | GET | List documents (with `?since=` incremental sync) | Pull |
| `/api/v1/documents/:id` | GET | Get document details + progress | Pull |
| `/api/v1/documents/:id/file` | GET | Download book file | Pull |
| `/api/v1/documents/:id/notes` | GET | Get document notes (with `?since=`) | Pull |
| `/api/v1/documents/search` | POST | Find existing document by title (dedup) | Push |
| `/api/v1/documents/upload` | POST | Multipart upload of book file + metadata | Push |
| `/api/v1/documents/progress` | POST | Update reading progress | Push |
| `/api/v1/documents/notes` | POST | Add a note/annotation (with metadata) | Push |
| `/api/v1/documents/notes/:id` | PUT | Update existing note | Push |
| `/api/v1/health` | GET | Health check | - |

## Files

### DewSync Service (`src/services/dewsync/`)

| File | Purpose |
|---|---|
| `DewSyncClient.ts` | HTTP client for cc-mem API (all endpoints) |
| `mappers.ts` | Bidirectional data transformation (Leaf <-> cc-mem types) |
| `index.ts` | Barrel export |

### Hooks

| File | Purpose |
|---|---|
| `src/app/reader/hooks/useDewSync.ts` | Per-book sync: upload on open, bidirectional progress + notes |
| `src/app/library/hooks/useDewLibrarySync.ts` | Library-level sync: pull/push book list + file download |

### Types

| File | Fields |
|---|---|
| `src/types/settings.ts` | `DewSyncSettings.syncLibrary`, `DewSyncSettings.lastLibrarySyncAt` |
| `src/types/book.ts` | `BookConfig.dewDocumentId`, `dewSyncedNoteIds`, `dewLastProgressSyncAt`, `dewLastNotesSyncAt` |

## Configuration

### Via Environment Variables (current approach)

Add to `apps/readest-app/.env.local`:

```env
NEXT_PUBLIC_DEW_API_KEY=your-dew-api-key
NEXT_PUBLIC_DEW_API_URL=https://your-cc-mem-instance.example.com
```

When `NEXT_PUBLIC_DEW_API_KEY` is set and no API key exists in the settings store, DewSync auto-enables with these env var values. This works for both web (`pnpm dev-web`) and Tauri/iOS builds since Next.js inlines `NEXT_PUBLIC_*` vars at build time.

### Via Settings Store (future)

```typescript
interface DewSyncSettings {
  enabled: boolean;
  apiUrl: string;           // default: 'http://localhost:8080'
  apiKey: string;           // Bearer token
  syncProgress: boolean;    // default: true
  syncNotes: boolean;       // default: true
  syncLibrary: boolean;     // default: true
  lastLibrarySyncAt: string; // ISO8601 timestamp
}
```

## How It Works

### Phase 1: Library Sync (`useDewLibrarySync`)

**Pull flow (Dew -> Leaf):**
1. `client.listDocuments(lastLibrarySyncAt)` to get changed documents
2. For each document:
   - Search by title+author in local library -> skip if found
   - Truly new -> `client.downloadFile(id)` -> `appService.importBook()` -> add to library
3. Update `lastLibrarySyncAt` in settings

**Push flow (Leaf -> Dew):**
1. For each book: search by title on server
2. If not found: `appService.loadBookContent()` -> `client.uploadDocument()`

**Polling:** Every 60 seconds

### Phase 2: Bidirectional Progress Sync (`useDewSync`)

**Push (Leaf -> Dew):** Debounced 5s on `progress.location` change (existing behavior).

**Pull (Dew -> Leaf) on book open:**
1. `client.getDocument(dewDocumentId)` to get remote state
2. Compare remote `updated_at` vs local `dewLastProgressSyncAt`
3. "Furthest progress wins": if remote is newer AND remote page is further ahead, apply remote progress
4. Update `dewLastProgressSyncAt`

### Phase 3: Bidirectional Notes Sync (`useDewSync`)

**Push (Leaf -> Dew):** Debounced 5s on `config.booknotes` change. Now sends structured metadata:
```json
{ "cfi": "...", "style": "highlight", "color": "yellow", "type": "annotation",
  "text": "highlighted text", "leafNoteId": "...", "updatedAt": 1234 }
```

**Pull (Dew -> Leaf) on book open:**
1. `client.getDocumentNotes(dewDocumentId, dewLastNotesSyncAt)`
2. For each remote note with `metadata.leafNoteId` -> LWW merge with local
3. Notes without metadata (created externally) -> add as annotations without CFI
4. Soft-delete: `deletedAt` set -> treat as deleted; local un-deletion wins if newer
5. Update `dewLastNotesSyncAt`

### Conflict Resolution

- **Library:** Dew is source of truth for *what exists*; no deletion sync (avoids accidental data loss)
- **Progress:** "Furthest progress wins" heuristic
- **Notes:** Last-Writer-Wins (LWW) on `updatedAt` per individual note
- **Identity bridge:** `BookConfig.dewDocumentId` <-> `documents.id`

## Data Model Mapping

| Leaf | cc-mem | Direction | Notes |
|---|---|---|---|
| `book.title` / `book.author` | `title` / `author` | Bidi | Direct mapping |
| `book.format` (EPUB/PDF/...) | `mime_type` | Bidi | MIME <-> BookFormat |
| `book.progress[0]` (1-based) | `current_page` (0-based) | Bidi | +/- 1 conversion |
| `book.progress[1]` | `total_pages` | Bidi | Direct |
| `book.readingStatus` | `reading_status` | Bidi | `'finished'` <-> `'completed'` |
| `BookNote.*` | `document_notes.content` + `metadata` | Bidi | Structured JSON metadata |
| `BookConfig.dewDocumentId` | `documents.id` | Bidi | Cross-reference UUID |

## Testing

### Web

```bash
cd apps/readest-app
pnpm dev-web
```

Open a book -> check browser console for `[DewSync]` and `[DewLibrarySync]` logs.

### Cross-Platform Sync Verification

1. Start cc-mem locally, configure Leaf `.env.local` with API key/URL
2. Open Leaf on web -> add a book -> verify it uploads to Dew
3. Open Leaf on iOS -> verify the book appears in library (downloaded from Dew)
4. Read on web (advance pages) -> reopen on iOS -> verify progress is further
5. Create a highlight on iOS -> reopen on web -> verify highlight appears

### Verify in cc-mem

```bash
# List all documents
curl -H "Authorization: Bearer $DEW_API_KEY" \
  "$DEW_API_URL/api/v1/documents"

# List documents updated since a date
curl -H "Authorization: Bearer $DEW_API_KEY" \
  "$DEW_API_URL/api/v1/documents?since=2024-01-01T00:00:00Z"

# Download a book file
curl -H "Authorization: Bearer $DEW_API_KEY" \
  "$DEW_API_URL/api/v1/documents/DOCUMENT_ID/file" -o book.epub

# Get notes for a document
curl -H "Authorization: Bearer $DEW_API_KEY" \
  "$DEW_API_URL/api/v1/documents/DOCUMENT_ID/notes"
```

## cc-mem Requirements

The following cc-mem endpoints/features are needed for full bidirectional sync:

1. `GET /api/v1/documents` - Structured document list with `?since=` filtering
2. `GET /api/v1/documents/:id/file` - File download
3. `GET /api/v1/documents/:id/notes` - Notes list with `?since=` filtering
4. `PUT /api/v1/documents/notes/:id` - Note update
5. `metadata` column on `document_notes` table - JSON field for Leaf-specific data
6. `updated_at` column on `document_notes` table - For incremental sync
7. EPUB mime type support in upload handler (`application/epub+zip`)

## Future Work

- Settings UI dialog (following `ReadwiseSettings.tsx` pattern)
- Deletion sync (currently no deletion propagation to avoid data loss)
- Search cc-mem memories from within Leaf
