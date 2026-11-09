import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { AppState, StyleSheet, useColorScheme, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { OptionSheetHost } from '@/components/OptionSheet';
import { PlaceholderScreen } from '@/components/PlaceholderScreen';
import { TextPromptHost } from '@/components/TextPromptModal';
import { ToastHost } from '@/components/ToastHost';
import { Icon } from '@/components/ui/primitives';
import { QueryProvider } from '@/lib/api/QueryProvider';
import { useConnectionStore } from '@/state/connectionStore';
import { useLockStore } from '@/state/lockStore';
import { usePrefsStore } from '@/state/prefsStore';
import { useColors } from '@/theme';

/** Locks on cold start and after the auto-lock timeout in background; hides content in the app switcher. */
function useAppLifecycle() {
  const [appState, setAppState] = useState(AppState.currentState);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background') useLockStore.getState().onBackground();
      if (next === 'active') useLockStore.getState().onForeground();
      setAppState(next);
    });
    return () => sub.remove();
  }, []);
  return appState;
}

function PrivacyCover() {
  const c = useColors();
  return (
    <View style={[StyleSheet.absoluteFill, styles.cover, { backgroundColor: c.bg }]} accessibilityElementsHidden>
      <Icon name="lock-closed" size={40} color="textMuted" />
    </View>
  );
}

export default function RootLayout() {
  const status = useConnectionStore((s) => s.status);
  const error = useConnectionStore((s) => s.error);
  const hydrate = useConnectionStore((s) => s.hydrate);
  const prefsLoaded = usePrefsStore((s) => s.loaded);
  const locked = useLockStore((s) => s.locked);
  const scheme = useColorScheme();
  const appState = useAppLifecycle();

  useEffect(() => {
    void (async () => {
      await usePrefsStore.getState().load();
      await hydrate();
      const paired = useConnectionStore.getState().status === 'paired';
      if (paired && usePrefsStore.getState().lockMethod !== 'none') useLockStore.getState().lock();
    })();
  }, [hydrate]);

  if (status === 'loading' || !prefsLoaded) return null;
  if (status === 'error') return <PlaceholderScreen title="Couldn't open secure storage" note={error ?? undefined} />;

  const paired = status === 'paired';

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryProvider>
        <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
        <Stack screenOptions={{ headerShown: false }}>
          {/* Without redirectTo, "/" would be an unmatched route whenever the app is unpaired or locked. */}
          <Stack.Protected guard={paired && !locked} redirectTo={paired ? '/lock' : '/welcome'}>
            <Stack.Screen name="(app)" />
          </Stack.Protected>
          <Stack.Protected guard={paired && locked}>
            <Stack.Screen name="lock" options={{ animation: 'fade', gestureEnabled: false }} />
          </Stack.Protected>
          {/* Reachable while paired too: re-pair and "Pair another PC" reuse the scan/verify screens. */}
          <Stack.Screen name="(onboarding)" />
        </Stack>
        <ToastHost />
        <OptionSheetHost />
        <TextPromptHost />
        {appState !== 'active' && paired ? <PrivacyCover /> : null}
      </QueryProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  cover: { alignItems: 'center', justifyContent: 'center' },
});
