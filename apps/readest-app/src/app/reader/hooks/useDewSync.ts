import { useEffect, useMemo, useRef } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useSettingsStore } from '@/store/settingsStore';
import { useReaderStore } from '@/store/readerStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { debounce } from '@/utils/debounce';
import { DewSyncClient, bookToUploadOptions, progressToUpdate, noteToContent } from '@/services/dewsync';

const DEW_SYNC_DEBOUNCE_MS = 5000;

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
    if (!settings.dewSync?.enabled || !settings.dewSync?.apiKey) return;

    const bookData = getBookData(bookKey);
    const book = bookData?.book;
    const currentConfig = getConfig(bookKey);
    if (!book) return;

    const client = new DewSyncClient(settings.dewSync);

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
        if (!settings.dewSync?.enabled || !settings.dewSync?.syncProgress) return;

        const currentConfig = getConfig(bookKey);
        const book = getBookData(bookKey)?.book;
        if (!currentConfig?.dewDocumentId || !book?.progress) return;

        const client = new DewSyncClient(settings.dewSync);
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
    if (!settings.dewSync?.enabled) return;
    debouncedProgressSync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress?.location]);

  // -- Notes sync (debounced) --
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const debouncedNotesSync = useMemo(
    () =>
      debounce(async () => {
        const { settings } = useSettingsStore.getState();
        if (!settings.dewSync?.enabled || !settings.dewSync?.syncNotes) return;

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

        const client = new DewSyncClient(settings.dewSync);
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
