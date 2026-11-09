import { Alert, PixelRatio, Pressable, StyleSheet, View } from 'react-native';

import { Icon } from '@/components/ui/primitives';
import { Text } from '@/components/ui/Text';
import { TextField } from '@/components/ui/TextField';
import { toast } from '@/state/toastStore';
import { radius, space, touchTarget, type as typeScale, useColors } from '@/theme';

const MAX_LINES = 6;

export interface ComposerProps {
  value: string;
  onChangeText: (text: string) => void;
  /** Called with the trimmed text. */
  onSend: (text: string) => void;
  /** Recipient name for the placeholder ("Message {name}…"). */
  name: string;
  /** Host unreachable → send disabled; tapping it explains why (SPEC §4.8). */
  offline?: boolean;
  /**
   * Lead DM only: long-press send offers "Send to all teammates (broadcast)" (SPEC §4.9).
   * Omit to disable the long-press option.
   */
  onBroadcast?: (text: string) => void;
  /** Caption above the input, e.g. "Sending will start the team" (SPEC §14.1.4). */
  hint?: string;
}

/** Multiline input (max 6 lines, then scrolls) + send (SPEC §4.9). */
export function Composer({ value, onChangeText, onSend, name, offline, onBroadcast, hint }: ComposerProps) {
  const c = useColors();
  const text = value.trim();
  const canSend = text.length > 0 && !offline;
  const lineHeight = typeScale.body.lineHeight * Math.min(2, PixelRatio.getFontScale());

  const press = () => {
    if (offline) {
      toast("Offline — can't send");
      return;
    }
    if (!text) return;
    onSend(text);
  };

  const longPress = onBroadcast
    ? () => {
        if (offline) {
          toast("Offline — can't send");
          return;
        }
        if (!text) {
          toast('Type a message to broadcast');
          return;
        }
        Alert.alert('Send to all teammates?', 'This message goes to every agent in the team (broadcast).', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Send to all teammates (broadcast)', onPress: () => onBroadcast(text) },
        ]);
      }
    : undefined;

  return (
    <View style={{ backgroundColor: c.surface }}>
      {hint ? (
        <Text variant="caption" color="textMuted" style={[styles.hint, { borderTopColor: c.border }]}>
          {hint}
        </Text>
      ) : null}
    <View style={[styles.bar, { backgroundColor: c.surface, borderTopColor: c.border }, hint ? { borderTopWidth: 0 } : null]}>
      <TextField
        value={value}
        onChangeText={onChangeText}
        placeholder={`Message ${name}…`}
        placeholderTextColor={c.textMuted}
        multiline
        scrollEnabled
        textAlignVertical="center"
        accessibilityLabel={`Message ${name}`}
        style={[
          styles.input,
          typeScale.body,
          {
            color: c.text,
            backgroundColor: c.surfaceAlt,
            maxHeight: lineHeight * MAX_LINES + space.sm * 2,
          },
        ]}
      />
      <Pressable
        onPress={press}
        onLongPress={longPress}
        accessibilityRole="button"
        accessibilityLabel="Send"
        accessibilityHint={onBroadcast ? 'Long-press to send to all teammates' : undefined}
        accessibilityState={{ disabled: !canSend }}
        accessibilityActions={onBroadcast ? [{ name: 'longpress', label: 'Send to all teammates' }] : undefined}
        onAccessibilityAction={(e) => (e.nativeEvent.actionName === 'longpress' ? longPress?.() : undefined)}
        hitSlop={4}
        style={styles.sendTarget}
      >
        {({ pressed }) => (
          <View style={[styles.sendCircle, { backgroundColor: canSend ? c.primary : c.surfaceAlt, opacity: pressed && canSend ? 0.8 : 1 }]}>
            <Icon name="send" size={18} color={canSend ? 'onPrimary' : 'textMuted'} />
          </View>
        )}
      </Pressable>
    </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    minHeight: touchTarget,
    borderRadius: radius.bubble + 4,
    paddingHorizontal: space.lg,
    paddingTop: space.sm + 2,
    paddingBottom: space.sm + 2,
  },
  hint: { paddingHorizontal: space.lg, paddingTop: space.sm, borderTopWidth: StyleSheet.hairlineWidth },
  sendTarget: { minWidth: touchTarget, minHeight: touchTarget, alignItems: 'center', justifyContent: 'center' },
  sendCircle: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
});
