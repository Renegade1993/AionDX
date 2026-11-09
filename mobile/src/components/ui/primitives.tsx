import Ionicons from '@expo/vector-icons/Ionicons';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import type { ComponentProps, ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, View, type ViewProps } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';

import { type ColorToken, radius, space, touchTarget, useColors, withAlpha } from '@/theme';

import { Text } from './Text';

/**
 * Ionicons names, plus two glyphs Ionicons lacks: `face-id` (a face in corner brackets) and
 * `lock-off` (a lock with a slash, for unavailable confirmations).
 */
export type IconName = ComponentProps<typeof Ionicons>['name'] | 'face-id' | 'lock-off';

const MCI: Record<string, ComponentProps<typeof MaterialCommunityIcons>['name']> = { 'face-id': 'face-recognition', 'lock-off': 'lock-off-outline' };

export function Icon({ name, size = 18, color = 'text' }: { name: IconName; size?: number; color?: ColorToken }) {
  const c = useColors();
  if (MCI[name]) return <MaterialCommunityIcons name={MCI[name]} size={size} color={c[color]} />;
  return <Ionicons name={name as ComponentProps<typeof Ionicons>['name']} size={size} color={c[color]} />;
}

/** Full-screen background. Use `edges` for screens without a native header. */
export function Screen({ children, edges = [], scroll, style, ...rest }: ViewProps & { edges?: Edge[]; scroll?: boolean }) {
  const c = useColors();
  const content = scroll ? (
    <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
      {children}
    </ScrollView>
  ) : (
    children
  );
  return (
    <SafeAreaView edges={edges} style={[styles.screen, { backgroundColor: c.bg }, style]} {...rest}>
      {content}
    </SafeAreaView>
  );
}

export function Card({ children, style, accentColor, ...rest }: ViewProps & { accentColor?: string }) {
  const c = useColors();
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: c.surface, borderColor: c.border },
        accentColor ? { borderLeftWidth: 4, borderLeftColor: accentColor } : null,
        style,
      ]}
      {...rest}
    >
      {children}
    </View>
  );
}

export function SectionHeader({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <View style={styles.sectionHeader} accessibilityRole="header">
      <Text variant="caption" color="textMuted" style={styles.sectionTitle}>
        {title.toUpperCase()}
      </Text>
      {right}
    </View>
  );
}

export function EmptyState({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <View style={styles.empty}>
      <Text color="textMuted" style={{ textAlign: 'center' }}>
        {title}
      </Text>
      {action}
    </View>
  );
}

/** Skeleton rows for first load with no cache (SPEC §8: skeletons, not spinners). */
export function SkeletonList({ rows = 3 }: { rows?: number }) {
  const c = useColors();
  return (
    <View style={{ gap: space.md, padding: space.gutter }} accessibilityLabel="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <View key={i} style={[styles.skeleton, { backgroundColor: c.surfaceAlt }]} />
      ))}
    </View>
  );
}

export function Divider() {
  const c = useColors();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border }} />;
}

/**
 * Chip for segmented controls, filters and summary counts — one shared style (SPEC §13.5).
 * Selected is always the primary tint (12% background, primary text, 600), never a status
 * colour, so it can't read as disabled. `dot` adds a status dot for summary chips (§13.9).
 */
export function Chip({
  label,
  selected,
  onPress,
  count,
  dot,
}: {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  count?: number;
  dot?: ColorToken;
}) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected }}
      style={[
        styles.chip,
        { backgroundColor: selected ? withAlpha(c.primary, 0.12) : c.surfaceAlt, borderColor: selected ? c.primary : 'transparent' },
      ]}
    >
      {dot ? <View style={[styles.chipDot, { backgroundColor: c[dot] }]} /> : null}
      <Text variant="caption" style={{ fontWeight: selected ? '600' : '500', color: selected ? c.primary : c.text }}>
        {label}
        {count !== undefined ? ` ${count}` : ''}
      </Text>
    </Pressable>
  );
}

export function IconButton({
  icon,
  label,
  onPress,
  color = 'primary',
  disabled,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  color?: ColorToken;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      style={[styles.iconButton, disabled && { opacity: 0.4 }]}
    >
      <Icon name={icon} size={22} color={color} />
    </Pressable>
  );
}

/** Settings-style tappable row. */
export function Row({
  title,
  subtitle,
  value,
  valueColor = 'textMuted',
  dot,
  onPress,
  icon,
  right,
  destructive,
  disabled,
}: {
  title: string;
  /** Caption under the title. */
  subtitle?: string;
  value?: string;
  valueColor?: ColorToken;
  /** Attention dot (stNeedsYou) before the value. */
  dot?: boolean;
  onPress?: () => void;
  icon?: IconName;
  right?: ReactNode;
  destructive?: boolean;
  /** Shown at 40% and not tappable. */
  disabled?: boolean;
}) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress || disabled}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityState={disabled ? { disabled: true } : undefined}
      style={({ pressed }) => [styles.row, subtitle ? styles.rowTall : null, { backgroundColor: pressed ? c.surfaceAlt : c.surface }, disabled ? { opacity: 0.4 } : null]}
    >
      {icon ? <Icon name={icon} color={destructive ? 'danger' : 'textMuted'} /> : null}
      <View style={{ flex: 1, gap: 2 }}>
        <Text color={destructive ? 'danger' : 'text'}>{title}</Text>
        {subtitle ? (
          <Text variant="caption" color="textMuted">
            {subtitle}
          </Text>
        ) : null}
      </View>
      {dot ? <View style={[styles.dot, { backgroundColor: c.stNeedsYou }]} /> : null}
      {value ? (
        <Text color={valueColor} style={styles.rowValue} numberOfLines={2}>
          {value}
        </Text>
      ) : null}
      {right}
      {onPress && !right ? <Icon name="chevron-forward" color="textMuted" /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scrollContent: { padding: space.gutter, gap: space.lg },
  card: { borderRadius: radius.card, borderWidth: StyleSheet.hairlineWidth, padding: space.md, gap: space.xs },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: space.lg,
    paddingBottom: space.sm,
  },
  sectionTitle: { fontWeight: '600', letterSpacing: 0.5 },
  empty: { alignItems: 'center', justifyContent: 'center', padding: space.xxl, gap: space.lg },
  skeleton: { height: 76, borderRadius: radius.card },
  chip: {
    minHeight: 36,
    paddingHorizontal: space.md,
    borderRadius: radius.chip,
    borderWidth: 1,
    flexDirection: 'row',
    gap: space.xs + 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipDot: { width: 8, height: 8, borderRadius: 4 },
  iconButton: { minWidth: touchTarget, minHeight: touchTarget, alignItems: 'center', justifyContent: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: touchTarget + 8,
    paddingHorizontal: space.lg,
  },
  rowTall: { paddingVertical: space.sm },
  rowValue: { maxWidth: '55%', textAlign: 'right' },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
