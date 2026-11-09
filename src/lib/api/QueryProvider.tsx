import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';

import { useConnectionStore } from '@/state/connectionStore';
import { useHealthStore } from '@/state/healthStore';

import { useEncryptedQueryCache } from './cachePersistence';
import { DeviceRevokedError } from './secureChannel';

/** Pause polling while the app is backgrounded; resume (and refetch) on return (SPEC §5). */
function useAppStateFocus() {
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const sub = AppState.addEventListener('change', (state) => focusManager.setFocused(state === 'active'));
    return () => sub.remove();
  }, []);
}

export function QueryProvider({ children }: { children: ReactNode }) {
  useAppStateFocus();
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Polling is the retry mechanism; backoff lives in hooks.ts.
            retry: (failureCount, error) => !(error instanceof DeviceRevokedError) && failureCount < 1,
            refetchIntervalInBackground: false,
            gcTime: 24 * 60 * 60 * 1000,
          },
        },
      }),
  );
  useEncryptedQueryCache(client);

  // Connection health is per host.
  const hostId = useConnectionStore((s) => s.activeHostId);
  useEffect(() => useHealthStore.getState().reset(), [hostId]);

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
