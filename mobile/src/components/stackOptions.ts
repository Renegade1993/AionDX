import type { NativeStackNavigationOptions } from 'expo-router';

import { useColors } from '@/theme';

/** Shared themed header options for every stack. */
export function useStackScreenOptions(): NativeStackNavigationOptions {
  const c = useColors();
  return {
    headerStyle: { backgroundColor: c.surface },
    headerTintColor: c.primary,
    headerTitleStyle: { color: c.text },
    contentStyle: { backgroundColor: c.bg },
    headerShadowVisible: false,
  };
}
