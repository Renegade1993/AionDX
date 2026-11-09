import { Platform, Switch, useColorScheme } from 'react-native';

import { useColors, withAlpha } from '@/theme';

/** Palette-themed switch (the platform default teal isn't a token; SPEC §13.11). */
export function Toggle({
  value,
  onValueChange,
  disabled,
  accessibilityLabel,
}: {
  value: boolean;
  onValueChange: (v: boolean) => void;
  disabled?: boolean;
  accessibilityLabel: string;
}) {
  const c = useColors();
  const dark = useColorScheme() === 'dark';
  // A surface-coloured thumb vanishes on a dark card, so off/disabled thumbs use a visible neutral.
  const offThumb = disabled ? c.textMuted : dark ? c.textMuted : '#FFFFFF';
  return (
    <Switch
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      accessibilityLabel={accessibilityLabel}
      trackColor={{ false: c.border, true: withAlpha(c.primary, 0.5) }}
      thumbColor={value ? c.primary : offThumb}
      ios_backgroundColor={c.border}
      // react-native-web ignores thumbColor when on and uses its own teal default.
      {...(Platform.OS === 'web' ? ({ activeThumbColor: c.primary } as object) : {})}
    />
  );
}
