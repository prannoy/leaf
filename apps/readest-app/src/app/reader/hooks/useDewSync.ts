import { useEffect, useMemo, useRef } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useSettingsStore } from '@/store/settingsStore';
import { useReaderStore } from '@/store/readerStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { debounce } from '@/utils/debounce';
import { DewSyncSettings } from '@/types/settings';
import { DEFAULT_DEW_SYNC_SETTINGS } from '@/services/constants';
import {
  DewSyncClient,
  bookToUploadOptions,
  progressToUpdate,
  bookNoteToStructuredInput,
  dewNoteToBookNote,
} from '@/services/dewsync';

const DEW_SYNC_DEBOUNCE_MS = 5000;

/**
 * Resolve effective DewSync settings by merging store settings with env var fallbacks.
 * This allows configuring via NEXT_PUBLIC_DEW_API_KEY / NEXT_PUBLIC_DEW_API_URL env vars
 * without needing a settings UI.
 */
// Next.js inlines NEXT_PUBLIC_* only with dot notation — bracket notation won't be replaced.
// @ts-expect-error TS4111: index signature access required, but dot notation needed for Next.js inlining
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const DEW_ENV_API_KEY = process.env.NEXT_PUBLIC_DEW_API_KEY;
// @ts-expect-error TS4111: index signature access required, but dot notation needed for Next.js inlining
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const DEW_ENV_API_URL = process.env.NEXT_PUBLIC_DEW_API_URL;

function resolveDewSyncSettings(stored: DewSyncSettings | undefined): DewSyncSettings {
  const envApiKey = DEW_ENV_API_KEY ?? '';
  const envApiUrl = DEW_ENV_API_URL ?? '';

  console.log('[DewSync] Env vars:', { envApiKey: envApiKey ? 'set' : 'empty', envApiUrl });

  // Merge stored on top of defaults to fill in any missing fields
  const base = { ...DEFAULT_DEW_SYNC_SETTINGS, ...(stored ?? {}) };

  // If an env API key is provided, treat DewSync as enabled
  if (envApiKey && !base.apiKey) {
    return {
      ...base,
      enabled: true,
      apiKey: envApiKey,
      apiUrl: envApiUrl || base.apiUrl,
    };
  }

  return base;
}

export const useDewSync = (bookKey: string) => {
  const { appService } = useEnv();
  const { getProgress } = useReaderStore();
  const { getConfig, setConfig, getBookData } = useBookDataStore();

  const uploadingRef = useRef(false);
  const hasUploadedRef = useRef(false);
  const hasPulledProgressRef = useRef(false);
  const hasPulledNotesRef = useRef(false);

  const progress = getProgress(bookKey);
  const config = getConfig(bookKey);

  // -- Upload on first open + pull remote state --
  useEffect(() => {
    if (!appService || hasUploadedRef.current || uploadingRef.current) return;
    const { settings } = useSettingsStore.getState();
    const dewSync = resolveDewSyncSettings(settings.dewSync);
    console.log('[DewSync] Resolved settings:', {
      enabled: dewSync.enabled,
      hasApiKey: !!dewSync.apiKey,
      apiUrl: dewSync.apiUrl,
      syncProgress: dewSync.syncProgress,
      syncNotes: dewSync.syncNotes,
    });
    if (!dewSync.enabled || !dewSync.apiKey) return;

    const bookData = getBookData(bookKey);
    const book = bookData?.book;
    const currentConfig = getConfig(bookKey);
    if (!book) return;

    const client = new DewSyncClient(dewSync);

    console.log('[DewSync] Starting upload flow for book:', book.title);

    const doUpload = async () => {
      // If we already have a dewDocumentId, verify it still exists
      if (currentConfig?.dewDocumentId) {
        const check = await client.getDocument(currentConfig.dewDocumentId);
        if (check.success) {
          hasUploadedRef.current = true;

          // Pull remote progress on open
          if (dewSync.syncProgress && check.data) {
            pullProgressOnOpen(client, currentConfig.dewDocumentId, check.data);
          }

          // Pull remote notes on open
          if (dewSync.syncNotes) {
            pullNotesOnOpen(client, currentConfig.dewDocumentId);
          }

          return;
        }
        // Document not found — clear and re-upload
        setConfig(bookKey, { dewDocumentId: undefined });
      }

      uploadingRef.current = true;
      try {
        // Search by title first to avoid duplicates
        const searchResult = await client.searchDocument(book.title);
        if (searchResult.success && searchResult.data?.id) {
          console.log('[DewSync] Found existing document by title:', searchResult.data.id);
          setConfig(bookKey, { dewDocumentId: searchResult.data.id });
          hasUploadedRef.current = true;
          return;
        }

        const { file } = await appService.loadBookContent(book);
        // Convert NativeFile to a real Blob so FormData works correctly
        const arrayBuffer = await file.arrayBuffer();
        const blob = new Blob([arrayBuffer], { type: file.type || 'application/octet-stream' });
        console.log('[DewSync] Uploading file:', {
          name: file.name,
          size: blob.size,
          type: blob.type,
        });

        if (blob.size === 0) {
          console.log('[DewSync] Skipping upload: file is empty');
          return;
        }

        const uploadOpts = bookToUploadOptions(book);
        const result = await client.uploadDocument(blob, uploadOpts);
        if (result.success && result.data?.id) {
          setConfig(bookKey, { dewDocumentId: result.data.id });
          hasUploadedRef.current = true;
        } else if (!result.isNetworkError) {
          console.log('[DewSync] Upload failed:', result.message);
        }
      } catch (e) {
        console.log('[DewSync] Upload error:', e);
      } finally {
        uploadingRef.current = false;
      }
    };

    doUpload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appService, bookKey]);

  // -- Pull progress on open (Phase 2) --
  const pullProgressOnOpen = async (
    _client: DewSyncClient,
    dewDocumentId: string,
    remoteDoc: Record<string, unknown>,
  ) => {
    if (hasPulledProgressRef.current) return;
    hasPulledProgressRef.current = true;

    try {
      const currentConfig = getConfig(bookKey);
      const book = getBookData(bookKey)?.book;
      if (!book) return;

      const remoteUpdatedAt = remoteDoc['updatedAt']
        ? new Date(remoteDoc['updatedAt'] as string).getTime()
        : 0;
      const localLastSync = currentConfig?.dewLastProgressSyncAt || 0;

      const remoteCurrentPage = (remoteDoc['currentPage'] as number) ?? null;
      const remoteTotalPages = (remoteDoc['totalPages'] as number) ?? null;

      if (remoteCurrentPage == null || remoteTotalPages == null) return;

      // cc-mem is 0-based, Leaf is 1-based
      const remotePageOneBased = remoteCurrentPage + 1;
      const localCurrentPage = book.progress?.[0] ?? 0;

      // "Furthest progress wins": only apply if remote is newer AND further ahead
      if (remoteUpdatedAt > localLastSync && remotePageOneBased > localCurrentPage) {
        console.log(
          '[DewSync] Applying remote progress:',
          remotePageOneBased,
          '/',
          remoteTotalPages,
        );
        setConfig(bookKey, {
          progress: [remotePageOneBased, remoteTotalPages],
          dewLastProgressSyncAt: Date.now(),
        });

        // Map remote reading status
        const remoteStatus = remoteDoc['readingStatus'] as string | undefined;
        if (remoteStatus === 'completed' && book.readingStatus !== 'finished') {
          // Update book reading status through the book data
          const bookData = getBookData(bookKey);
          if (bookData?.book) {
            bookData.book.readingStatus = 'finished';
          }
        }
      } else {
        // Just update the sync timestamp
        setConfig(bookKey, { dewLastProgressSyncAt: Date.now() });
      }

      console.log('[DewSync] Progress pull complete for:', dewDocumentId);
    } catch (e) {
      console.log('[DewSync] Pull progress error:', e);
    }
  };

  // -- Pull notes on open (Phase 3) --
  const pullNotesOnOpen = async (client: DewSyncClient, dewDocumentId: string) => {
    if (hasPulledNotesRef.current) return;
    hasPulledNotesRef.current = true;

    try {
      const currentConfig = getConfig(bookKey);
      const book = getBookData(bookKey)?.book;
      if (!book) return;

      const lastNotesSyncAt = currentConfig?.dewLastNotesSyncAt;
      const sinceStr = lastNotesSyncAt ? new Date(lastNotesSyncAt).toISOString() : undefined;

      console.log('[DewSync] Pulling notes since:', sinceStr || 'beginning');
      const result = await client.getDocumentNotes(dewDocumentId, sinceStr);
      if (!result.success || !result.data) {
        if (!result.isNetworkError) {
          console.log('[DewSync] Notes pull failed:', result.message);
        }
        return;
      }

      const remoteNotes = result.data;
      if (remoteNotes.length === 0) {
        console.log('[DewSync] No new remote notes');
        setConfig(bookKey, { dewLastNotesSyncAt: Date.now() });
        return;
      }

      console.log('[DewSync] Got', remoteNotes.length, 'remote notes');

      const booknotes = [...(currentConfig?.booknotes ?? [])];
      const syncedIds = { ...(currentConfig?.dewSyncedNoteIds ?? {}) };
      let changed = false;

      for (const remoteNote of remoteNotes) {
        const remoteBookNote = dewNoteToBookNote(remoteNote, book.hash);

        // metadata is already a parsed object from the API
        const metadata = remoteNote.metadata as
          | { leafNoteId?: string; updatedAt?: number; deletedAt?: number | null }
          | null;

        if (metadata?.leafNoteId) {
          // Note originated from Leaf — LWW merge
          const localIdx = booknotes.findIndex((n) => n.id === metadata!.leafNoteId);
          if (localIdx !== -1) {
            const localNote = booknotes[localIdx]!;
            const remoteUpdatedAt = metadata.updatedAt || new Date(remoteNote.updatedAt).getTime();

            // Soft-delete handling
            if (metadata.deletedAt) {
              if (localNote.updatedAt > metadata.deletedAt) {
                // Local un-deletion wins — skip
                continue;
              }
              // Apply remote deletion
              booknotes[localIdx] = { ...localNote, deletedAt: metadata.deletedAt };
              changed = true;
              continue;
            }

            // LWW: remote wins if it's newer
            if (remoteUpdatedAt > localNote.updatedAt) {
              booknotes[localIdx] = remoteBookNote;
              changed = true;
            }
          } else {
            // Note not found locally — add it
            booknotes.push(remoteBookNote);
            changed = true;
          }
          // Track the mapping
          syncedIds[metadata.leafNoteId] = remoteNote.id;
        } else {
          // External note (created outside Leaf)
          const existingIdx = booknotes.findIndex((n) => n.id === remoteBookNote.id);
          if (existingIdx === -1) {
            booknotes.push(remoteBookNote);
            syncedIds[remoteBookNote.id] = remoteNote.id;
            changed = true;
          }
        }
      }

      if (changed) {
        setConfig(bookKey, {
          booknotes,
          dewSyncedNoteIds: syncedIds,
          dewLastNotesSyncAt: Date.now(),
        });
        console.log('[DewSync] Notes merged, updated local booknotes');
      } else {
        setConfig(bookKey, { dewLastNotesSyncAt: Date.now() });
      }
    } catch (e) {
      console.log('[DewSync] Pull notes error:', e);
    }
  };

  // -- Progress sync (debounced, push) --
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const debouncedProgressSync = useMemo(
    () =>
      debounce(async () => {
        const { settings } = useSettingsStore.getState();
        const dewSync = resolveDewSyncSettings(settings.dewSync);
        if (!dewSync.enabled || !dewSync.syncProgress) return;

        const currentConfig = getConfig(bookKey);
        const book = getBookData(bookKey)?.book;
        if (!currentConfig?.dewDocumentId || !book?.progress) return;

        const client = new DewSyncClient(dewSync);
        const update = progressToUpdate(currentConfig.dewDocumentId, book);
        if (!update) return;

        console.log('[DewSync] Syncing progress:', update);
        const result = await client.updateProgress(update);
        if (result.success) {
          console.log('[DewSync] Progress synced successfully');
          setConfig(bookKey, { dewLastProgressSyncAt: Date.now() });
        } else if (!result.isNetworkError) {
          console.log('[DewSync] Progress sync failed:', result.message);
        } else {
          console.log('[DewSync] Progress sync network error:', result.message);
        }
      }, DEW_SYNC_DEBOUNCE_MS),
    [bookKey, getConfig, getBookData, setConfig],
  );

  useEffect(() => {
    if (!progress?.location) return;
    const { settings } = useSettingsStore.getState();
    const dewSync = resolveDewSyncSettings(settings.dewSync);
    if (!dewSync.enabled) return;
    debouncedProgressSync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress?.location]);

  // -- Notes sync (debounced, push with structured metadata) --
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const debouncedNotesSync = useMemo(
    () =>
      debounce(async () => {
        const { settings } = useSettingsStore.getState();
        const dewSync = resolveDewSyncSettings(settings.dewSync);
        if (!dewSync.enabled || !dewSync.syncNotes) return;

        const currentConfig = getConfig(bookKey);
        if (!currentConfig?.dewDocumentId) return;

        const booknotes = currentConfig.booknotes ?? [];
        const syncedIds = currentConfig.dewSyncedNoteIds ?? {};

        const newNotes = booknotes.filter(
          (n) =>
            (n.type === 'annotation' || n.type === 'excerpt') &&
            !n.deletedAt &&
            n.text &&
            !syncedIds[n.id],
        );
        if (newNotes.length === 0) return;

        const client = new DewSyncClient(dewSync);
        const updatedSyncedIds = { ...syncedIds };

        for (const note of newNotes) {
          const input = bookNoteToStructuredInput(note, currentConfig.dewDocumentId);
          // Step 1: POST creates the note (content only, metadata not persisted by POST)
          const result = await client.addNote({
            documentId: input.documentId,
            content: input.content,
          });
          if (result.success) {
            const noteId = result.data?.id || '';
            // Step 2: PUT adds metadata (POST doesn't persist metadata)
            if (noteId) {
              await client.updateNote(noteId, { metadata: input.metadata as Record<string, unknown> });
            }
            updatedSyncedIds[note.id] = noteId || note.id;
          } else if (!result.isNetworkError) {
            console.log('[DewSync] Note sync failed:', result.message);
          }
        }

        if (Object.keys(updatedSyncedIds).length > Object.keys(syncedIds).length) {
          setConfig(bookKey, { dewSyncedNoteIds: updatedSyncedIds });
        }
      }, DEW_SYNC_DEBOUNCE_MS),
    [bookKey, getConfig, setConfig],
  );

  useEffect(() => {
    debouncedNotesSync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.booknotes]);

  // -- Cleanup: flush pending debounced calls on unmount --
  useEffect(() => {
    return () => {
      debouncedProgressSync.flush();
      debouncedNotesSync.flush();
    };
  }, [debouncedProgressSync, debouncedNotesSync]);
};
