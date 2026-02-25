import { useEffect, useMemo, useRef } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useSettingsStore } from '@/store/settingsStore';
import { useReaderStore } from '@/store/readerStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { debounce } from '@/utils/debounce';
import { DewSyncSettings } from '@/types/settings';
import { DEFAULT_DEW_SYNC_SETTINGS } from '@/services/constants';
import { DewSyncClient, bookToUploadOptions, progressToUpdate, noteToContent } from '@/services/dewsync';

const DEW_SYNC_DEBOUNCE_MS = 5000;

/**
 * Resolve effective DewSync settings by merging store settings with env var fallbacks.
 * This allows configuring via NEXT_PUBLIC_DEW_API_KEY / NEXT_PUBLIC_DEW_API_URL env vars
 * without needing a settings UI.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const DEW_ENV_API_KEY = process.env.NEXT_PUBLIC_DEW_API_KEY;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const DEW_ENV_API_URL = process.env.NEXT_PUBLIC_DEW_API_URL;

function resolveDewSyncSettings(stored: DewSyncSettings | undefined): DewSyncSettings {
  const envApiKey = DEW_ENV_API_KEY ?? '';
  const envApiUrl = DEW_ENV_API_URL ?? '';

  console.log('[DewSync] Env vars:', { envApiKey: envApiKey ? 'set' : 'empty', envApiUrl });

  const base = stored ?? DEFAULT_DEW_SYNC_SETTINGS;

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

  const progress = getProgress(bookKey);
  const config = getConfig(bookKey);

  // -- Upload on first open --
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
        console.log('[DewSync] Uploading file:', { name: file.name, size: blob.size, type: blob.type });

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

  // -- Progress sync (debounced) --
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
        } else if (!result.isNetworkError) {
          console.log('[DewSync] Progress sync failed:', result.message);
        } else {
          console.log('[DewSync] Progress sync network error:', result.message);
        }
      }, DEW_SYNC_DEBOUNCE_MS),
    [bookKey, getConfig, getBookData],
  );

  useEffect(() => {
    if (!progress?.location) return;
    const { settings } = useSettingsStore.getState();
    const dewSync = resolveDewSyncSettings(settings.dewSync);
    if (!dewSync.enabled) return;
    debouncedProgressSync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress?.location]);

  // -- Notes sync (debounced) --
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
          const content = noteToContent(note);
          const result = await client.addNote({
            documentId: currentConfig.dewDocumentId,
            content,
          });
          if (result.success) {
            updatedSyncedIds[note.id] = note.id;
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
