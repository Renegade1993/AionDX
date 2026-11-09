import { Stack } from 'expo-router';

import { useStackScreenOptions } from '@/components/stackOptions';

/** A deep link into this stack still gets the tab's root under it, so ‹ Back always shows (SPEC §16 #20). */
export const unstable_settings = { anchor: 'index' };

export default function TasksLayout() {
  const screenOptions = useStackScreenOptions();
  return (
    <Stack screenOptions={screenOptions}>
      <Stack.Screen name="index" />
      <Stack.Screen name="[taskId]" options={{ title: '', headerBackTitle: 'Tasks' }} />
    </Stack>
  );
}
