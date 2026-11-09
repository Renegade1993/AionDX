import { ActivityIndicator, Pressable, type PressableProps, StyleSheet, type StyleProp, View, type ViewStyle } from 'react-native';

import { type ColorToken, radius, space, touchTarget, useColors, withAlpha } from '@/theme';

import { Icon, type IconName } from './primitives';
import { Text } from './Text';

/** outline: `surface` fill + 1 pt border, for small actions on tinted cards (SPEC §14.3.2). */
type Variant = 'primary' | 'secondary' | 'outline' | 'danger' | 'dangerOutline' | 'ghost';

export interface ButtonProps extends Omit<PressableProps, 'style' | 'children'> {
  title: string;
  /** Allow the label to wrap (centred) instead of a single line. */
  numberOfLines?: number;
  variant?: Variant;
  loading?: boolean;
  compact?: boolean;
  /** 16 pt leading glyph in the label's color, e.g. the confirmation glyph (SPEC §15.1.1). */
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
}

/** The label's color token per variant, so glyphs match the text. */
const FG_TOKEN: Record<Variant, ColorToken> = { primary: 'onPrimary', secondary: 'text', outline: 'text', danger: 'onPrimary', dangerOutline: 'danger', ghost: 'primary' };

export function Button({ title, numberOfLines = 1, variant = 'primary', loading, compact, icon, disabled, style, ...rest }: ButtonProps) {
  const c = useColors();
  const palette: Record<Variant, { bg: string; fg: string; border: string }> = {
    primary: { bg: c.primary, fg: c.onPrimary, border: c.primary },
    secondary: { bg: c.surfaceAlt, fg: c.text, border: c.surfaceAlt },
    outline: { bg: c.surface, fg: c.text, border: c.border },
    danger: { bg: c.danger, fg: c.onPrimary, border: c.danger },
    dangerOutline: { bg: 'transparent', fg: c.danger, border: c.danger },
    ghost: { bg: 'transparent', fg: c.primary, border: 'transparent' },
  };
  const isDisabled = disabled || loading;
  // Disabled secondary/outline buttons keep their fill at full strength and dim only the label and
  // glyph, so the button's shape stays visible in dark mode (SPEC §16 #19). Others fade to 40%.
  const softDisabled = !!disabled && !loading && (variant === 'secondary' || variant === 'outline');
  const p = softDisabled ? { ...palette[variant], fg: c.textMuted } : palette[variant];
  const fgToken: ColorToken = softDisabled ? 'textMuted' : FG_TOKEN[variant];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!isDisabled, busy: !!loading }}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.base,
        compact && styles.compact,
        { backgroundColor: pressed && variant !== 'ghost' ? withAlpha(p.bg, 0.85) : p.bg, borderColor: p.border },
        isDisabled && !softDisabled && styles.disabled,
        style,
      ]}
      {...rest}
    >
      {loading ? (
        <ActivityIndicator color={p.fg} />
      ) : icon ? (
        <View style={styles.withIcon}>
          <Icon name={icon} size={16} color={fgToken} />
          <Text variant="headline" numberOfLines={numberOfLines} style={[styles.label, styles.shrink, { color: p.fg }]}>
            {title}
          </Text>
        </View>
      ) : (
        <Text variant="headline" numberOfLines={numberOfLines} style={[styles.label, { color: p.fg }]}>
          {title}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: touchTarget + 4,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.card,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  compact: { minHeight: touchTarget, paddingHorizontal: space.md, paddingVertical: space.sm },
  label: { textAlign: 'center' },
  withIcon: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.xs + 2, maxWidth: '100%' },
  shrink: { flexShrink: 1 },
  disabled: { opacity: 0.4 },
});
