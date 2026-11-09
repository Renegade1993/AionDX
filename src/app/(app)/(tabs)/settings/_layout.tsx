import { Stack } from 'expo-router';

import { useStackScreenOptions } from '@/components/stackOptions';

/** A deep link into this stack still gets the tab's root under it, so ‹ Back always shows (SPEC §16 #20). */
export const unstable_settings = { anchor: 'index' };

export default function SettingsLayout() {
  const screenOptions = useStackScreenOptions();
  return (
    <Stack screenOptions={screenOptions}>
      <Stack.Screen name="index" options={{ title: 'Settings' }} />
      <Stack.Screen name="hosts" options={{ title: 'Paired PCs' }} />
      <Stack.Screen name="security" options={{ title: 'Security' }} />
      <Stack.Screen name="pc/[hostId]" options={{ title: 'PC' }} />
    </Stack>
  );
}
