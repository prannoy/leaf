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
function resolveDewSyncSettings(stored: DewSyncSettings | undefined): DewSyncSettings {
  const envApiKey = process.env['NEXT_PUBLIC_DEW_API_KEY'] ?? '';
  const envApiUrl = process.env['NEXT_PUBLIC_DEW_API_URL'] ?? '';

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
    if (!dewSync.enabled || !dewSync.apiKey) return;

    const bookData = getBookData(bookKey);
    const book = bookData?.book;
    const currentConfig = getConfig(bookKey);
    if (!book) return;

    const client = new DewSyncClient(dewSync);

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
        const { file } = await appService.loadBookContent(book);
        const uploadOpts = bookToUploadOptions(book);
        const result = await client.uploadDocument(file, uploadOpts);
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

        const result = await client.updateProgress(update);
        if (!result.success && !result.isNetworkError) {
          console.log('[DewSync] Progress sync failed:', result.message);
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
