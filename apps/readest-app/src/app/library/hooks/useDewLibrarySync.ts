import { useCallback, useEffect, useRef } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';
import { DewSyncSettings } from '@/types/settings';
import { DEFAULT_DEW_SYNC_SETTINGS } from '@/services/constants';
import { DewSyncClient, DewDocument } from '@/services/dewsync/DewSyncClient';
import { bookToUploadOptions, dewDocumentToBook } from '@/services/dewsync/mappers';
import { Book } from '@/types/book';

const DEW_LIBRARY_SYNC_INTERVAL_MS = 60_000;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const DEW_ENV_API_KEY = process.env['NEXT_PUBLIC_DEW_API_KEY'];
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const DEW_ENV_API_URL = process.env['NEXT_PUBLIC_DEW_API_URL'];

function resolveDewSyncSettings(stored: DewSyncSettings | undefined): DewSyncSettings {
  const envApiKey = DEW_ENV_API_KEY ?? '';
  const envApiUrl = DEW_ENV_API_URL ?? '';

  const base = stored ?? DEFAULT_DEW_SYNC_SETTINGS;

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

export const useDewLibrarySync = () => {
  const { appService, envConfig } = useEnv();
  const { library, libraryLoaded } = useLibraryStore();
  const syncingRef = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pullLibrary = useCallback(async () => {
    if (!appService || syncingRef.current) return;

    const { settings } = useSettingsStore.getState();
    const dewSync = resolveDewSyncSettings(settings.dewSync);
    if (!dewSync.enabled || !dewSync.apiKey || !dewSync.syncLibrary) return;

    syncingRef.current = true;
    try {
      const client = new DewSyncClient(dewSync);
      const since = dewSync.lastLibrarySyncAt || undefined;

      console.log('[DewLibrarySync] Pulling documents since:', since || 'beginning');
      const result = await client.listDocuments(since);
      if (!result.success || !result.data) {
        if (!result.isNetworkError) {
          console.log('[DewLibrarySync] Pull failed:', result.message);
        }
        return;
      }

      const documents = result.data;
      if (documents.length === 0) {
        console.log('[DewLibrarySync] No new documents');
        return;
      }

      console.log('[DewLibrarySync] Got', documents.length, 'documents');
      const currentLibrary = useLibraryStore.getState().library;

      for (const doc of documents) {
        await processRemoteDocument(client, doc, currentLibrary);
      }

      // Update lastLibrarySyncAt
      const newSettings = {
        ...settings,
        dewSync: {
          ...dewSync,
          lastLibrarySyncAt: new Date().toISOString(),
        },
      };
      useSettingsStore.getState().setSettings(newSettings);
      useSettingsStore.getState().saveSettings(envConfig, newSettings);
    } catch (e) {
      console.log('[DewLibrarySync] Pull error:', e);
    } finally {
      syncingRef.current = false;
    }
  }, [appService, envConfig]);

  const processRemoteDocument = useCallback(
    async (client: DewSyncClient, doc: DewDocument, currentLibrary: Book[]) => {
      if (!appService) return;

      // 1. Match by dewDocumentId in existing library
      // Search by title+author in local library
      const normalizedTitle = doc.title.toLowerCase().trim();
      const normalizedAuthor = (doc.author || '').toLowerCase().trim();
      const existingByMeta = currentLibrary.find((book) => {
        return (
          book.title.toLowerCase().trim() === normalizedTitle &&
          (book.author || '').toLowerCase().trim() === normalizedAuthor &&
          !book.deletedAt
        );
      });

      if (existingByMeta) {
        console.log('[DewLibrarySync] Found local match by title+author:', doc.title);
        // Book already exists locally — no download needed
        return;
      }

      // 3. Truly new document — download file and import
      console.log('[DewLibrarySync] Downloading new document:', doc.title);
      const fileResult = await client.downloadFile(doc.id);
      if (!fileResult.success || !fileResult.data) {
        console.log('[DewLibrarySync] Download failed for', doc.title, ':', fileResult.message);
        return;
      }

      const blob = fileResult.data;
      if (blob.size === 0) {
        console.log('[DewLibrarySync] Skipping empty file:', doc.title);
        return;
      }

      // Determine filename from document
      const partialBook = dewDocumentToBook(doc);
      const ext = partialBook.format?.toLowerCase() || 'epub';
      const filename = `${doc.title}.${ext}`;

      // Create a File object from the blob
      const file = new File([blob], filename, {
        type: blob.type || 'application/octet-stream',
      });

      try {
        const updatedLibrary = useLibraryStore.getState().library;
        const importedBook = await appService.importBook(file, updatedLibrary);
        if (importedBook) {
          console.log('[DewLibrarySync] Imported book:', importedBook.title);
          // Merge Dew metadata into imported book
          if (partialBook.readingStatus) {
            importedBook.readingStatus = partialBook.readingStatus;
          }
          if (partialBook.progress) {
            importedBook.progress = partialBook.progress;
          }
          importedBook.updatedAt = Date.now();

          const finalLibrary = useLibraryStore.getState().library;
          // Update the library with the imported book
          const bookIdx = finalLibrary.findIndex((b) => b.hash === importedBook.hash);
          if (bookIdx !== -1) {
            finalLibrary[bookIdx] = importedBook;
          } else {
            finalLibrary.push(importedBook);
          }
          useLibraryStore.getState().setLibrary([...finalLibrary]);
          await appService.saveLibraryBooks(finalLibrary);
        }
      } catch (e) {
        console.log('[DewLibrarySync] Import error for', doc.title, ':', e);
      }
    },
    [appService],
  );

  const pushLibrary = useCallback(async () => {
    if (!appService || syncingRef.current) return;

    const { settings } = useSettingsStore.getState();
    const dewSync = resolveDewSyncSettings(settings.dewSync);
    if (!dewSync.enabled || !dewSync.apiKey || !dewSync.syncLibrary) return;

    syncingRef.current = true;
    try {
      const client = new DewSyncClient(dewSync);
      const currentLibrary = useLibraryStore.getState().library;

      // Push books that haven't been uploaded to Dew yet.
      // Since dewDocumentId is in BookConfig (per-book reader config), we search by title
      // to check if the document already exists on the server.
      for (const book of currentLibrary) {
        if (book.deletedAt) continue;

        // Search by title to see if it already exists
        const searchResult = await client.searchDocument(book.title);
        if (searchResult.success && searchResult.data?.id) {
          continue; // Already on server
        }

        console.log('[DewLibrarySync] Pushing book:', book.title);
        try {
          const { file } = await appService.loadBookContent(book);
          const arrayBuffer = await file.arrayBuffer();
          const blob = new Blob([arrayBuffer], { type: file.type || 'application/octet-stream' });

          if (blob.size === 0) {
            console.log('[DewLibrarySync] Skipping empty file:', book.title);
            continue;
          }

          const uploadOpts = bookToUploadOptions(book);
          const result = await client.uploadDocument(blob, uploadOpts);
          if (result.success && result.data?.id) {
            console.log('[DewLibrarySync] Pushed book:', book.title, 'id:', result.data.id);
          } else if (!result.isNetworkError) {
            console.log('[DewLibrarySync] Push failed for', book.title, ':', result.message);
          }
        } catch (e) {
          console.log('[DewLibrarySync] Push error for', book.title, ':', e);
        }
      }
    } finally {
      syncingRef.current = false;
    }
  }, [appService]);

  // Pull on mount + periodic polling
  useEffect(() => {
    if (!appService || !libraryLoaded) return;

    const { settings } = useSettingsStore.getState();
    const dewSync = resolveDewSyncSettings(settings.dewSync);
    if (!dewSync.enabled || !dewSync.apiKey || !dewSync.syncLibrary) return;

    // Initial pull
    pullLibrary();

    // Set up polling
    intervalRef.current = setInterval(() => {
      pullLibrary();
    }, DEW_LIBRARY_SYNC_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [appService, libraryLoaded, pullLibrary]);

  // Push new books when library changes (debounced by the polling interval)
  useEffect(() => {
    if (!appService || !libraryLoaded) return;

    const { settings } = useSettingsStore.getState();
    const dewSync = resolveDewSyncSettings(settings.dewSync);
    if (!dewSync.enabled || !dewSync.apiKey || !dewSync.syncLibrary) return;

    // Only push if we have books, to avoid push on initial load before pull
    if (library.length > 0) {
      pushLibrary();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [library.length]);
};
