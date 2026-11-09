import { Stack } from 'expo-router';

import { useStackScreenOptions } from '@/components/stackOptions';

export const unstable_settings = { anchor: 'welcome' };

export default function OnboardingLayout() {
  const screenOptions = useStackScreenOptions();
  return (
    <Stack screenOptions={{ ...screenOptions, title: '', headerBackTitle: 'Back' }}>
      <Stack.Screen name="welcome" options={{ headerShown: false }} />
      <Stack.Screen name="name" />
      <Stack.Screen name="scan" options={{ title: 'Scan code' }} />
      <Stack.Screen name="verify" options={{ gestureEnabled: false }} />
      <Stack.Screen name="app-lock" options={{ headerShown: false, gestureEnabled: false }} />
      <Stack.Screen name="done" options={{ headerShown: false, gestureEnabled: false }} />
    </Stack>
  );
}
