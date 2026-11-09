import { type ReactNode, useRef } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { create } from 'zustand';

import { Divider, Icon } from '@/components/ui/primitives';
import { Text } from '@/components/ui/Text';
import { radius, space, touchTarget, useColors, withAlpha } from '@/theme';

export interface SheetOption {
  key: string;
  label: string;
  description?: string;
  left?: ReactNode;
  right?: ReactNode;
  selected?: boolean;
  destructive?: boolean;
}

/**
 * Simple modal picker. `onSelect` runs after the sheet has dismissed so it can
 * safely open an Alert (iOS can't present one while a modal is animating out).
 */
export function OptionSheet({
  visible,
  title,
  message,
  options,
  onSelect,
  onClose,
}: {
  visible: boolean;
  title: string;
  message?: string;
  options: SheetOption[];
  onSelect: (key: string) => void;
  onClose: () => void;
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const pending = useRef<string | null>(null);

  const flush = () => {
    const key = pending.current;
    pending.current = null;
    if (key !== null) onSelect(key);
  };

  const choose = (key: string) => {
    pending.current = key;
    onClose();
    // iOS runs `flush` from onDismiss once the modal is gone; elsewhere run it now.
    if (Platform.OS !== 'ios') flush();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} onDismiss={flush} statusBarTranslucent navigationBarTranslucent>
      <View style={styles.sheetRoot}>
        <Pressable
          style={[StyleSheet.absoluteFill, { backgroundColor: withAlpha('#000000', 0.4) }]}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
        />
        <View style={[styles.sheet, { backgroundColor: c.surface, paddingBottom: insets.bottom + space.sm }]} accessibilityViewIsModal>
          <View style={styles.sheetHeader}>
            <Text variant="headline" accessibilityRole="header">
              {title}
            </Text>
            {message ? (
              <Text variant="caption" color="textMuted">
                {message}
              </Text>
            ) : null}
          </View>
          <Divider />
          <ScrollView style={{ maxHeight: height * 0.55 }} keyboardShouldPersistTaps="handled">
            {options.map((o) => (
              <Pressable
                key={o.key}
                onPress={() => choose(o.key)}
                accessibilityRole="button"
                accessibilityState={{ selected: !!o.selected }}
                accessibilityLabel={[o.label, o.description].filter(Boolean).join(', ')}
                style={({ pressed }) => [styles.option, pressed && { backgroundColor: c.surfaceAlt }]}
              >
                {o.left}
                <View style={styles.optionText}>
                  <Text color={o.destructive ? 'danger' : 'text'} style={o.selected && { fontWeight: '600' }}>
                    {o.label}
                  </Text>
                  {o.description ? (
                    <Text variant="caption" color="textMuted" numberOfLines={1}>
                      {o.description}
                    </Text>
                  ) : null}
                </View>
                {o.right}
                {o.selected ? <Icon name="checkmark" color="primary" /> : null}
              </Pressable>
            ))}
          </ScrollView>
          <Divider />
          <Pressable onPress={onClose} accessibilityRole="button" style={({ pressed }) => [styles.option, styles.cancel, pressed && { backgroundColor: c.surfaceAlt }]}>
            <Text variant="headline" color="primary">
              Cancel
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}


// ---------------------------------------------------------------------------
// Imperative API for menus outside a component tree (quick actions, pickers).
// ---------------------------------------------------------------------------

interface PickerRequest {
  title: string;
  message?: string;
  options: SheetOption[];
  resolve: (key: string | null) => void;
}

const usePickerStore = create<{ request: PickerRequest | null; visible: boolean }>()(() => ({ request: null, visible: false }));

/** Shows an OptionSheet and resolves with the chosen key, or null if cancelled. */
export function pickOption(title: string, options: SheetOption[], message?: string): Promise<string | null> {
  usePickerStore.getState().request?.resolve(null);
  return new Promise((resolve) => usePickerStore.setState({ request: { title, message, options, resolve }, visible: true }));
}

/** Render once near the app root. */
export function OptionSheetHost() {
  const { request, visible } = usePickerStore();
  if (!request) return null;
  const close = () => {
    usePickerStore.setState({ visible: false });
    // A selection resolves via onSelect (immediately on Android, after the dismiss animation on iOS);
    // if none arrives, treat it as cancel.
    setTimeout(() => {
      const current = usePickerStore.getState().request;
      if (current === request) {
        request.resolve(null);
        usePickerStore.setState({ request: null });
      }
    }, 1000);
  };
  return (
    <OptionSheet
      visible={visible}
      title={request.title}
      message={request.message}
      options={request.options}
      onClose={close}
      onSelect={(key) => {
        usePickerStore.setState({ request: null });
        request.resolve(key);
      }}
    />
  );
}

const styles = StyleSheet.create({
  sheetRoot: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, overflow: 'hidden' },
  sheetHeader: { paddingHorizontal: space.gutter, paddingTop: space.lg, paddingBottom: space.md, gap: space.xs },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: touchTarget + 8,
    paddingHorizontal: space.gutter,
    paddingVertical: space.sm,
  },
  optionText: { flex: 1, gap: 2 },
  cancel: { justifyContent: 'center' },
});
