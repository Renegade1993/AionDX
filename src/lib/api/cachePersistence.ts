import { dehydrate, hydrate, type Query, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { loadCache, saveCache } from '@/lib/storage/encryptedCache';
import { useConnectionStore } from '@/state/connectionStore';

const SAVE_THROTTLE_MS = 3000;

/** Only successful queries for the given host are cached. */
const belongsTo = (hostId: string) => (q: Query) => q.state.status === 'success' && q.queryKey[0] === 'host' && q.queryKey[1] === hostId;

/**
 * Restores the active host's encrypted cache into React Query on activation so
 * cold starts render instantly (SPEC §8), and writes it back (throttled, and on
 * backgrounding) as polls land.
 */
export function useEncryptedQueryCache(client: QueryClient) {
  const hostId = useConnectionStore((s) => s.activeHostId);

  useEffect(() => {
    if (!hostId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const save = () => {
      timer = null;
      const state = dehydrate(client, { shouldDehydrateQuery: belongsTo(hostId) });
      // Unsent optimistic messages would reappear as permanently "sending" after a restart.
      // Copy rather than mutate: dehydrated entries may share objects with the live cache.
      const queries = state.queries.map((q) =>
        Array.isArray(q.state.data)
          ? { ...q, state: { ...q.state, data: (q.state.data as unknown[]).filter((m) => !(m && typeof m === 'object' && 'localState' in m)) } }
          : q,
      );
      void saveCache(hostId, { ...state, queries }).catch(() => {});
    };
    const scheduleSave = () => {
      if (!timer) timer = setTimeout(save, SAVE_THROTTLE_MS);
    };

    void loadCache<Parameters<typeof hydrate>[1]>(hostId).then((state) => {
      // Fresh server data beats cache; hydrate() keeps whichever is newer per query.
      if (!cancelled && state) hydrate(client, state);
    });

    const unsubCache = client.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'success' && belongsTo(hostId)(event.query)) scheduleSave();
    });
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'background') {
        if (timer) clearTimeout(timer);
        save();
      }
    });

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      unsubCache();
      sub.remove();
    };
  }, [client, hostId]);
}
