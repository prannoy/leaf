# Dew (cc-mem) Sync Integration

Leaf syncs reading state (progress and notes/annotations) to [cc-mem](https://github.com/prannoyp/cc-mem) (Dew), a local-first personal knowledge/memory system. The integration is **unidirectional** (Leaf -> Dew) and uses cc-mem's REST API directly with no npm dependency.

## Architecture

```
Leaf Reader                         cc-mem (Dew)
+------------------+                +---------------------------+
| useDewSync hook  |---HTTP/REST--> | REST API                  |
| (Annotator.tsx)  |                |                           |
|                  |  search -----> | POST /documents/search    |
|  book opened     |  upload -----> | POST /documents/upload    |
|  progress change |  progress ---> | POST /documents/progress  |
|  note created    |  note -------> | POST /documents/notes     |
|                  |  get --------> | GET  /documents/:id       |
+------------------+                +---------------------------+
```

## API Endpoints Used

All endpoints are existing cc-mem APIs (no changes to cc-mem required except adding `LEAF = 'leaf'` to `SourceConnector` enum and CORS headers).

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/v1/documents/search` | POST | Find existing document by title (dedup) |
| `/api/v1/documents/upload` | POST | Multipart upload of book file + metadata |
| `/api/v1/documents/progress` | POST | Update reading progress |
| `/api/v1/documents/notes` | POST | Add a note/annotation |
| `/api/v1/documents/:id` | GET | Verify a document still exists |
| `/api/v1/health` | GET | Health check |

## Files Changed

### New Files

| File | Purpose |
|---|---|
| `src/services/dewsync/DewSyncClient.ts` | HTTP client for cc-mem API |
| `src/services/dewsync/mappers.ts` | Data transformation (Leaf types -> cc-mem types) |
| `src/services/dewsync/index.ts` | Barrel export |
| `src/app/reader/hooks/useDewSync.ts` | React hook orchestrating upload, progress, and notes sync |

### Modified Files

| File | Change |
|---|---|
| `src/types/settings.ts` | Added `DewSyncSettings` interface and `dewSync` field to `SystemSettings` |
| `src/types/book.ts` | Added `dewDocumentId` and `dewSyncedNoteIds` fields to `BookConfig` |
| `src/services/constants.ts` | Added `DEFAULT_DEW_SYNC_SETTINGS` |
| `src/app/reader/components/annotator/Annotator.tsx` | Wired `useDewSync(bookKey)` alongside existing sync hooks |

### Configuration Files

| File | Purpose |
|---|---|
| `.env.local` (gitignored) | `NEXT_PUBLIC_DEW_API_KEY` and `NEXT_PUBLIC_DEW_API_URL` |

## Configuration

### Via Environment Variables (current approach)

Add to `apps/readest-app/.env.local`:

```env
NEXT_PUBLIC_DEW_API_KEY=your-dew-api-key
NEXT_PUBLIC_DEW_API_URL=https://your-cc-mem-instance.example.com
```

When `NEXT_PUBLIC_DEW_API_KEY` is set and no API key exists in the settings store, DewSync auto-enables with these env var values. This works for both web (`pnpm dev-web`) and Tauri/iOS builds since Next.js inlines `NEXT_PUBLIC_*` vars at build time.

### Via Settings Store (future)

The `DewSyncSettings` interface supports full configuration:

```typescript
interface DewSyncSettings {
  enabled: boolean;
  apiUrl: string;      // default: 'http://localhost:8080'
  apiKey: string;      // Bearer token
  syncProgress: boolean;
  syncNotes: boolean;
}
```

A settings UI dialog (following the `ReadwiseSettings.tsx` pattern) can be added later.

## How It Works

### 1. Upload on First Open

When a book is opened in the reader:

1. Check if `dewDocumentId` is already stored in the book's config
2. If yes, verify it still exists via `GET /documents/:id`
3. If no stored ID, **search by title** via `POST /documents/search` to find an existing document (prevents duplicates across platforms)
4. If no document found, upload the book file via `POST /documents/upload` with `sourceConnector: 'leaf'`
5. Store the returned document ID in `BookConfig.dewDocumentId`

The file is converted from Tauri's `NativeFile` to a standard `Blob` via `arrayBuffer()` before upload, which ensures `FormData` works correctly on all platforms (web, macOS, iOS).

### 2. Progress Sync (debounced, 5s)

When `progress.location` changes in the reader:

- Maps Leaf's `book.progress` (1-based `[currentPage, totalPages]`) to cc-mem's `{ documentId, currentPage, status }`
- Leaf's `readingStatus: 'finished'` maps to cc-mem's `status: 'completed'`
- Debounced at 5 seconds to avoid excessive API calls during rapid page turns

### 3. Notes Sync (debounced, 5s)

When `config.booknotes` changes:

- Filters to `annotation` and `excerpt` types with non-empty `text` and no `deletedAt`
- Skips notes already tracked in `dewSyncedNoteIds`
- Builds rich content string:
  ```
  > [highlighted text]
  Note: [user's annotation]
  [style:highlight, color:yellow, type:annotation]
  ```
- Calls `POST /documents/notes` for each new note
- Tracks synced note IDs in `BookConfig.dewSyncedNoteIds`

### 4. Error Handling

- **Network errors**: Silently ignored (console.log only, no user-facing toasts)
- **Document not found**: Clears `dewDocumentId` and re-uploads on next open
- **Empty file**: Skips upload with a console warning
- **Cleanup**: Flushes pending debounced calls on component unmount

## Data Model Mapping

| Leaf | cc-mem | Notes |
|---|---|---|
| `book.title` / `book.author` | upload `title` / `author` | Direct mapping |
| `book.format` (EPUB/PDF/...) | inferred from file | cc-mem computes hash + mime |
| `book.progress[0]` (1-based) | `currentPage` | Subtract 1 for 0-based |
| `book.progress[1]` | `totalPages` | Sent at upload time |
| `book.readingStatus` | `reading_status` | `'finished'` -> `'completed'` |
| `BookNote.text` | `document_notes.content` | Enriched with metadata |
| `BookNote.note` | embedded in content | User's annotation text |
| `BookNote.style/color` | embedded in content | Preserved as metadata |

## Testing

### Web

```bash
cd apps/readest-app
pnpm dev-web
```

Open a book -> check browser console for `[DewSync]` logs.

### iOS Simulator

```bash
cd apps/readest-app
NEXT_PUBLIC_APP_PLATFORM=tauri pnpm tauri ios dev "iPhone 16"
```

Use Safari Web Inspector (Develop -> Simulator -> localhost) to see `[DewSync]` console logs.

Note: Xcode 16.4 requires adding `-Wl,-U,_swift_coroFrameAlloc` to `OTHER_LDFLAGS` in the generated `src-tauri/gen/apple/Readest.xcodeproj/project.pbxproj` due to a Swift 6.2 compatibility issue.

### Verify in cc-mem

```bash
# Search for uploaded documents
curl -H "Authorization: Bearer $DEW_API_KEY" \
  "$DEW_API_URL/api/v1/documents/search" \
  -X POST -H "Content-Type: application/json" \
  -d '{"query": "BOOK_TITLE"}'

# Check a specific document's progress
curl -H "Authorization: Bearer $DEW_API_KEY" \
  "$DEW_API_URL/api/v1/documents/DOCUMENT_ID"
```

## Commits

1. `14b4ec4e` - feat: add cc-mem (Dew) sync integration for reading state
2. `e0bb33ed` - fix(dewsync): env var fallback for settings and unwrap cc-mem response
3. `6f29feec` - fix(dewsync): fix env var inlining, dedup, and NativeFile upload

## Future Work

- Settings UI dialog (following `ReadwiseSettings.tsx` pattern)
- Bulk library sync (upload all books at once)
- Bidirectional sync (pull notes from cc-mem back to Leaf)
- Search cc-mem memories from within Leaf
