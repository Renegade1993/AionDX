import { useRef, useState } from 'react';
import { KeyboardAvoidingView, Modal, PixelRatio, Platform, Pressable, StyleSheet, View } from 'react-native';
import { create } from 'zustand';

import { Button } from '@/components/ui/Button';
import type { IconName } from '@/components/ui/primitives';
import { Text } from '@/components/ui/Text';
import { TextField } from '@/components/ui/TextField';
import { radius, space, touchTarget, useColors, withAlpha } from '@/theme';

export interface TextPromptOptions {
  title: string;
  message?: string;
  initialValue?: string;
  placeholder?: string;
  maxLength?: number;
  /** Submit button label (default "Save"). */
  submitLabel?: string;
  submitVariant?: 'primary' | 'dangerOutline';
  /** Leading glyph on the submit button, e.g. the confirmation glyph (SPEC §15.1.1). */
  submitIcon?: IconName;
  /** An empty value can be submitted (an optional reason, say). */
  allowEmpty?: boolean;
}

/** Cross-platform single-line text prompt (Alert.prompt is iOS-only). */
export function TextPromptModal({
  visible,
  onSubmit,
  onClose,
  ...opts
}: TextPromptOptions & {
  visible: boolean;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const c = useColors();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.root}>
        <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: withAlpha('#000000', 0.4) }]} onPress={onClose} accessibilityLabel="Close" />
        {/* Mounted only while visible, so each opening starts from initialValue. */}
        {visible ? <PromptBody {...opts} onSubmit={onSubmit} onClose={onClose} colors={{ surface: c.surface, field: c.surfaceAlt, text: c.text, muted: c.textMuted }} /> : null}
      </KeyboardAvoidingView>
    </Modal>
  );
}

function PromptBody({
  title,
  message,
  initialValue = '',
  placeholder,
  maxLength,
  submitLabel = 'Save',
  submitVariant = 'primary',
  submitIcon,
  allowEmpty = true,
  onSubmit,
  onClose,
  colors,
}: TextPromptOptions & {
  onSubmit: (value: string) => void;
  onClose: () => void;
  colors: { surface: string; field: string; text: string; muted: string };
}) {
  const [value, setValue] = useState(initialValue);
  const disabled = !allowEmpty && !value.trim();
  // Side by side, each button gets about half the card: labels past ~12 characters (more with a
  // glyph or large text) wouldn't fit on one line.
  const stacked = submitLabel.length + (submitIcon ? 3 : 0) > 12 || PixelRatio.getFontScale() > 1.3;
  const submit = () => {
    if (disabled) return;
    onSubmit(value);
    onClose();
  };
  return (
    <View style={[styles.card, { backgroundColor: colors.surface }]} accessibilityViewIsModal>
      <Text variant="headline" accessibilityRole="header">
        {title}
      </Text>
      {message ? <Text color="textMuted">{message}</Text> : null}
      <TextField
        value={value}
        onChangeText={setValue}
        autoFocus
        maxLength={maxLength}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        returnKeyType="done"
        onSubmitEditing={submit}
        accessibilityLabel={placeholder ?? title}
        style={[styles.input, { backgroundColor: colors.field, color: colors.text }]}
      />
      {stacked ? (
        // Long labels: the action first at full width, Cancel below (SPEC §16 #3).
        <View style={styles.stacked}>
          <Button title={submitLabel} variant={submitVariant} icon={submitIcon} compact disabled={disabled} onPress={submit} />
          <Button title="Cancel" variant="secondary" compact onPress={onClose} />
        </View>
      ) : (
        <View style={styles.buttons}>
          <Button title="Cancel" variant="secondary" compact style={{ flex: 1 }} onPress={onClose} />
          <Button title={submitLabel} variant={submitVariant} icon={submitIcon} compact style={{ flex: 1 }} disabled={disabled} onPress={submit} />
        </View>
      )}
    </View>
  );
}

interface PromptRequest extends TextPromptOptions {
  resolve: (value: string | null) => void;
}

const usePromptStore = create<{ request: PromptRequest | null }>()(() => ({ request: null }));

/** Shows a text prompt and resolves with the entered text, or null if cancelled. */
export function promptText(opts: TextPromptOptions): Promise<string | null> {
  usePromptStore.getState().request?.resolve(null);
  return new Promise((resolve) => usePromptStore.setState({ request: { ...opts, resolve } }));
}

/** Render once near the app root. */
export function TextPromptHost() {
  const request = usePromptStore((s) => s.request);
  // Submit resolves first, then the modal closes; closing without a submit is a cancel.
  const submitted = useRef<PromptRequest | null>(null);
  if (!request) return null;
  const { resolve, ...opts } = request;
  return (
    <TextPromptModal
      visible
      {...opts}
      onSubmit={(v) => {
        submitted.current = request;
        resolve(v);
      }}
      onClose={() => {
        if (submitted.current !== request) resolve(null);
        usePromptStore.setState({ request: null });
      }}
    />
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'center', padding: space.xl },
  card: { borderRadius: radius.sheet, padding: space.xl, gap: space.md },
  input: { minHeight: touchTarget, borderRadius: radius.card, paddingHorizontal: space.md, fontSize: 16 },
  buttons: { flexDirection: 'row', gap: space.md },
  stacked: { gap: space.sm },
});
