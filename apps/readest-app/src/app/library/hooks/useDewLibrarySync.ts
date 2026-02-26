import { useCallback, useEffect, useRef } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { DewSyncSettings } from '@/types/settings';
import { DEFAULT_DEW_SYNC_SETTINGS } from '@/services/constants';
import { DewMemoryClient } from '@/services/dewsync/DewSyncClient';

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

export const useDewLibrarySync = () => {
  const { appService } = useEnv();
  const { library, libraryLoaded } = useLibraryStore();
  const { getConfig, setConfig } = useBookDataStore();
  const indexingRef = useRef(false);

  const indexLibraryBooks = useCallback(async () => {
    if (!appService || indexingRef.current) return;

    const { settings } = useSettingsStore.getState();
    const dewSync = resolveDewSyncSettings(settings.dewSync);
    if (!dewSync.enabled || !dewSync.apiKey) return;

    indexingRef.current = true;
    try {
      const client = new DewMemoryClient(dewSync);
      const currentLibrary = useLibraryStore.getState().library;

      for (const book of currentLibrary) {
        if (book.deletedAt) continue;

        // Check if already indexed via BookConfig
        const bookConfig = getConfig(book.hash);
        if (bookConfig?.dewContentIndexed) continue;

        console.log('[DewLibrarySync] Uploading for content indexing:', book.title);
        try {
          const { file } = await appService.loadBookContent(book);
          const arrayBuffer = await file.arrayBuffer();
          const blob = new Blob([arrayBuffer], { type: file.type || 'application/octet-stream' });

          if (blob.size === 0) {
            console.log('[DewLibrarySync] Skipping empty file:', book.title);
            continue;
          }

          const result = await client.uploadContent(blob, {
            filename: book.sourceTitle || `${book.title}.${book.format.toLowerCase()}`,
            title: book.title,
            author: book.author,
          });

          if (result.success && result.data?.success) {
            const primaryMemoryId = result.data.memoryId;
            console.log('[DewLibrarySync] Content indexed:', book.title, 'memoryId:', primaryMemoryId);
            setConfig(book.hash, {
              dewContentIndexed: true,
              dewPrimaryMemoryId: primaryMemoryId,
            });
          } else if (!result.isNetworkError) {
            console.log('[DewLibrarySync] Index failed for', book.title, ':', result.data?.message || result.message);
          }
        } catch (e) {
          console.log('[DewLibrarySync] Index error for', book.title, ':', e);
        }
      }
    } finally {
      indexingRef.current = false;
    }
  }, [appService, getConfig, setConfig]);

  // Index new books when library changes
  useEffect(() => {
    if (!appService || !libraryLoaded) return;

    const { settings } = useSettingsStore.getState();
    const dewSync = resolveDewSyncSettings(settings.dewSync);
    if (!dewSync.enabled || !dewSync.apiKey) return;

    if (library.length > 0) {
      indexLibraryBooks();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [library.length]);
};
