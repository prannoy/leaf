import { useEffect, useMemo, useRef } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useSettingsStore } from '@/store/settingsStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { debounce } from '@/utils/debounce';
import { DewSyncSettings } from '@/types/settings';
import { DEFAULT_DEW_SYNC_SETTINGS } from '@/services/constants';
import { DewMemoryClient } from '@/services/dewsync/DewSyncClient';
import {
  highlightToMemory,
  annotationToMemory,
  bookCompletionToMemory,
} from '@/services/dewsync/mappers';

const DEW_SYNC_DEBOUNCE_MS = 5000;

// Next.js inlines NEXT_PUBLIC_* only with dot notation — bracket notation won't be replaced.
// @ts-expect-error TS4111: index signature access required, but dot notation needed for Next.js inlining
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const DEW_ENV_API_KEY = process.env.NEXT_PUBLIC_DEW_API_KEY;
// @ts-expect-error TS4111: index signature access required, but dot notation needed for Next.js inlining
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const DEW_ENV_API_URL = process.env.NEXT_PUBLIC_DEW_API_URL;

export function resolveDewSyncSettings(stored: DewSyncSettings | undefined): DewSyncSettings {
  const envApiKey = DEW_ENV_API_KEY ?? '';
  const envApiUrl = DEW_ENV_API_URL ?? '';

  const base = { ...DEFAULT_DEW_SYNC_SETTINGS, ...(stored ?? {}) };

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
  const { getConfig, setConfig, getBookData } = useBookDataStore();

  const contentIndexingRef = useRef(false);
  const hasIndexedRef = useRef(false);
  const prevReadingStatusRef = useRef<string | undefined>(undefined);

  const config = getConfig(bookKey);

  // -- Upload book file for content indexing on first open --
  useEffect(() => {
    if (!appService || hasIndexedRef.current || contentIndexingRef.current) return;

    const { settings } = useSettingsStore.getState();
    const dewSync = resolveDewSyncSettings(settings.dewSync);
    if (!dewSync.enabled || !dewSync.apiKey) return;

    const bookData = getBookData(bookKey);
    const book = bookData?.book;
    const currentConfig = getConfig(bookKey);
    if (!book) return;

    // Skip if already indexed
    if (currentConfig?.dewContentIndexed) {
      hasIndexedRef.current = true;
      return;
    }

    const client = new DewMemoryClient(dewSync);
    contentIndexingRef.current = true;

    const doIndex = async () => {
      try {
        const { file } = await appService.loadBookContent(book);
        const arrayBuffer = await file.arrayBuffer();
        const blob = new Blob([arrayBuffer], { type: file.type || 'application/octet-stream' });

        if (blob.size === 0) {
          console.log('[DewSync] Skipping content index: file is empty');
          return;
        }

        console.log('[DewSync] Uploading book for content indexing:', book.title);
        const result = await client.uploadContent(blob, {
          filename: book.sourceTitle || `${book.title}.${book.format.toLowerCase()}`,
          title: book.title,
          author: book.author,
        });

        if (result.success) {
          const primaryMemoryId = result.data?.memoryId;
          console.log('[DewSync] Content indexed:', book.title, 'memoryId:', primaryMemoryId);
          setConfig(bookKey, {
            dewContentIndexed: true,
            dewPrimaryMemoryId: primaryMemoryId,
          });
          hasIndexedRef.current = true;
        } else if (!result.isNetworkError) {
          console.log('[DewSync] Content index failed:', result.message);
        }
      } catch (e) {
        console.log('[DewSync] Content index error:', e);
      } finally {
        contentIndexingRef.current = false;
      }
    };

    doIndex();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appService, bookKey]);

  // -- Track reading status for "book finished" memory --
  useEffect(() => {
    const bookData = getBookData(bookKey);
    const book = bookData?.book;
    if (!book) return;

    // Initialize on first render
    if (prevReadingStatusRef.current === undefined) {
      prevReadingStatusRef.current = book.readingStatus;
      return;
    }

    // Detect transition to 'finished'
    if (book.readingStatus === 'finished' && prevReadingStatusRef.current !== 'finished') {
      const { settings } = useSettingsStore.getState();
      const dewSync = resolveDewSyncSettings(settings.dewSync);
      if (!dewSync.enabled || !dewSync.apiKey || !dewSync.syncCompletions) {
        prevReadingStatusRef.current = book.readingStatus;
        return;
      }

      const client = new DewMemoryClient(dewSync);
      const currentConfig = getConfig(bookKey);
      const memory = bookCompletionToMemory(book, book.hash);
      console.log('[DewSync] Pushing book completion memory:', book.title);
      client.pushMemory(memory).then((result) => {
        if (result.success && result.data?.id) {
          console.log('[DewSync] Book completion memory pushed');
          const primaryId = currentConfig?.dewPrimaryMemoryId;
          if (primaryId) {
            client.relateMemories(result.data.id, primaryId, 'mentions');
          }
        } else if (!result.isNetworkError) {
          console.log('[DewSync] Book completion push failed:', result.message);
        }
      });
    }

    prevReadingStatusRef.current = book.readingStatus;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getBookData(bookKey)?.book?.readingStatus]);

  // -- Push highlights/annotations as memories (debounced) --
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const debouncedMemorySync = useMemo(
    () =>
      debounce(async () => {
        const { settings } = useSettingsStore.getState();
        const dewSync = resolveDewSyncSettings(settings.dewSync);
        if (!dewSync.enabled || !dewSync.syncHighlights) return;

        const currentConfig = getConfig(bookKey);
        const bookData = getBookData(bookKey);
        const book = bookData?.book;
        if (!book) return;

        const booknotes = currentConfig?.booknotes ?? [];
        const syncedIds = currentConfig?.dewSyncedMemoryIds ?? {};

        const newNotes = booknotes.filter(
          (n) =>
            (n.type === 'annotation' || n.type === 'excerpt') &&
            !n.deletedAt &&
            n.text &&
            !syncedIds[n.id],
        );
        if (newNotes.length === 0) return;

        const client = new DewMemoryClient(dewSync);
        const updatedSyncedIds = { ...syncedIds };
        const primaryMemoryId = currentConfig?.dewPrimaryMemoryId;

        for (const note of newNotes) {
          const memory =
            note.note && note.note.trim()
              ? annotationToMemory(note, book.title, book.hash)
              : highlightToMemory(note, book.title, book.hash);

          const result = await client.pushMemory(memory);
          if (result.success) {
            const noteMemoryId = result.data?.id || note.id;
            updatedSyncedIds[note.id] = noteMemoryId;

            // Link to the book's primary content memory
            if (primaryMemoryId && result.data?.id) {
              client.relateMemories(result.data.id, primaryMemoryId, 'mentions');
            }
          } else if (!result.isNetworkError) {
            console.log('[DewSync] Memory push failed:', result.message);
          }
        }

        if (Object.keys(updatedSyncedIds).length > Object.keys(syncedIds).length) {
          setConfig(bookKey, { dewSyncedMemoryIds: updatedSyncedIds });
        }
      }, DEW_SYNC_DEBOUNCE_MS),
    [bookKey, getConfig, getBookData, setConfig],
  );

  useEffect(() => {
    debouncedMemorySync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.booknotes]);

  // -- Cleanup: flush pending debounced calls on unmount --
  useEffect(() => {
    return () => {
      debouncedMemorySync.flush();
    };
  }, [debouncedMemorySync]);
};
