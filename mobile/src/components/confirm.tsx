import * as LocalAuthentication from 'expo-local-authentication';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';

import { useHostLabel } from '@/components/Banners';
import type { IconName } from '@/components/ui/primitives';
import { Text } from '@/components/ui/Text';
import { useConfirmState, useHostInfo } from '@/lib/api/hooks';
import { detectConfirmMode } from '@/lib/api/pairing';
import type { ConfirmMode } from '@/lib/api/types';
import { type BiometricKind, biometricName, canConfirm, type ConfirmState } from '@/lib/confirmState';
import { DEMO_HOST_ID, useActiveHost, useConnectionStore } from '@/state/connectionStore';
import { usePrefsStore } from '@/state/prefsStore';
import { toast } from '@/state/toastStore';
import { space, useColors, withAlpha } from '@/theme';

/*
 * Sensitive-action confirmation UI (SPEC §15.1, §15.2): the glyph on confirming buttons, the
 * disabled state with its one-line explanation, the inline notice in sheets, and the one-time
 * "needs attention" toast.
 */

/** Face ID vs Touch ID vs fingerprint, for glyphs and copy (copy says "Face ID" when unknown). */
export function useBiometricKind(): BiometricKind | null {
  // The web preview can't tell, so it gets no kind (the glyph falls back to the lock).
  const [kind, setKind] = useState<BiometricKind | null>(null);
  useEffect(() => {
    if (Platform.OS === 'web') return;
    void LocalAuthentication.supportedAuthenticationTypesAsync()
      .then((types) => {
        if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) setKind('face');
        else if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) setKind(Platform.OS === 'ios' ? 'touch' : 'fingerprint');
      })
      .catch(() => undefined);
  }, []);
  return kind;
}

/**
 * What this phone could protect a key with right now (§5.2). The demo PC and the web preview
 * simulate a biometric phone so the whole flow can be tried there.
 */
export function useEnrolledMode(hostId?: string): ConfirmMode | null {
  const simulated = hostId === DEMO_HOST_ID || Platform.OS === 'web';
  const [mode, setMode] = useState<ConfirmMode | null>(simulated ? 'biometric' : null);
  useEffect(() => {
    if (simulated) return;
    void detectConfirmMode().then(setMode);
  }, [simulated]);
  return mode;
}

/**
 * P4's read-only "Confirmations on NATE-PC" card (SPEC §15.2.1), replacing the old
 * "Require Face ID to approve" toggle.
 */
export function ConfirmationsCard({ state, hostName }: { state: ConfirmState; hostName: string }) {
  const c = useColors();
  const kind = useBiometricKind();
  const copy =
    state === 'biometric'
      ? { title: biometricName(kind), body: `Approving requests and managing agents will ask for ${biometricName(kind)}.` }
      : state === 'device_passcode'
        ? {
            title: '🔒 Passcode (app-enforced)',
            body: "Approving requests and managing agents will ask for your phone's passcode. Set up Face ID later and re-confirm to switch.",
          }
        : state === 'off'
          ? { title: 'Off on this PC', body: `${hostName} lets this phone approve and manage agents without confirming.` }
          : {
              title: 'Not available on this phone',
              body: `Set a screen lock on this phone, then re-confirm it on ${hostName}. Until then, you can still chat, deny requests, and manage tasks.`,
            };
  const warn = state === 'none' || state === 'needs_reconfirm';
  return (
    <View
      style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }, warn ? { borderLeftWidth: 4, borderLeftColor: c.stNeedsYou } : null]}
    >
      <Text variant="caption" color="textMuted" style={{ fontWeight: '600' }}>
        Confirmations on {hostName}
      </Text>
      <Text style={{ fontWeight: '600' }}>{copy.title}</Text>
      <Text variant="caption" color="textMuted">
        {copy.body}
      </Text>
      {warn ? (
        <Pressable onPress={openHelp} accessibilityRole="link" hitSlop={6}>
          <Text variant="caption" color="primary" style={{ fontWeight: '600' }}>
            Learn more
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * The glyph that says "this asks for Face ID / fingerprint / passcode" (SPEC §15.1.1, §16 #6):
 * by the phone's sensor type, falling back to a lock when it's unknown; a lock with a slash when
 * confirmations are unavailable; none when Off.
 */
export function confirmGlyph(state: ConfirmState, kind: BiometricKind | null): IconName | undefined {
  if (state === 'biometric') return kind === 'face' ? 'face-id' : kind === 'touch' || kind === 'fingerprint' ? 'finger-print' : 'lock-closed';
  if (state === 'device_passcode') return 'lock-closed';
  if (state === 'none' || state === 'needs_reconfirm') return 'lock-off';
  return undefined;
}

/**
 * Props for a sensitive button on the active PC (SPEC §15.1.1, §15.1.5): the leading glyph, the
 * accessibility hint, and whether it's usable. Disabled buttons are 40% opacity.
 */
export function useSensitive() {
  const state = useConfirmState();
  const kind = useBiometricKind();
  const available = canConfirm(state);
  return {
    state,
    available,
    icon: confirmGlyph(state, kind),
    accessibilityHint: state === 'biometric' ? `Requires ${biometricName(kind)}` : state === 'device_passcode' ? 'Requires your passcode' : undefined,
    style: undefined,
  };
}

const openRekey = (hostId: string) => router.push({ pathname: '/rekey/[hostId]', params: { hostId } });
const openHelp = () => router.push('/confirm-help');

/**
 * A sensitive menu or swipe action while confirmations are unavailable (SPEC §15.1.5, §16 D5):
 * "Confirmations unavailable on NATE-PC" with `Re-confirm` (or `Learn more` with no screen lock).
 */
export function toastConfirmUnavailable(state?: ConfirmState) {
  const { activeHostId, hosts } = useConnectionStore.getState();
  const host = hosts.find((h) => h.hostId === activeHostId);
  if (!host) return;
  const name = usePrefsStore.getState().hostLabels[host.hostId] ?? host.hostName;
  toast(
    `Confirmations unavailable on ${name}`,
    'info',
    state === 'none' ? { label: 'Learn more', onPress: openHelp } : { label: 'Re-confirm', onPress: () => openRekey(host.hostId) },
  );
}

/** The single line under a footer whose sensitive buttons are disabled (SPEC §15.1.5). */
export function ConfirmUnavailableLine({ state }: { state: ConfirmState }) {
  const host = useActiveHost();
  if (canConfirm(state) || !host) return null;
  const none = state === 'none';
  return (
    <Pressable
      onPress={() => (none ? openHelp() : openRekey(host.hostId))}
      accessibilityRole="link"
      accessibilityLabel={none ? 'Needs a screen lock. Learn more' : 'Confirmations unavailable. Re-confirm this phone'}
      hitSlop={6}
      style={styles.line}
    >
      <Text variant="caption" color="textMuted" style={styles.center}>
        {none ? 'Needs a screen lock · ' : 'Confirmations unavailable · '}
        <Text variant="caption" color="primary" style={{ fontWeight: '600' }}>
          {none ? 'Learn more' : 'Re-confirm…'}
        </Text>
      </Text>
    </Pressable>
  );
}

/**
 * Inline notice at the top of an approval / question footer (SPEC §15.1.5). Rendered inside the
 * sheet, so it shows above it on every platform (a toast would sit behind a web form sheet).
 */
export function ConfirmNotice({
  state,
  error,
  rekey = true,
  tone = 'error',
}: {
  state: ConfirmState;
  error?: string | null;
  rekey?: boolean;
  /** neutral: a hint, not a failure (the D4b "couldn't confirm" hint, §16 N2). */
  tone?: 'error' | 'neutral';
}) {
  const c = useColors();
  const host = useActiveHost();
  const hostName = useHostLabel();
  if (!host || (canConfirm(state) && !error)) return null;
  const text = error ?? `You can deny from here, but allowing needs this phone to be re-confirmed on ${hostName}.`;
  const none = !error && state === 'none';
  const isError = !!error && tone === 'error';
  return (
    <View
      accessibilityRole="alert"
      style={[styles.notice, isError ? { backgroundColor: withAlpha(c.stError, 0.08), borderLeftColor: c.stError } : { backgroundColor: c.surfaceAlt, borderLeftColor: c.stNeedsYou }]}
    >
      <Text variant="caption" color={isError ? 'stErrorText' : 'text'}>
        {none ? `This phone has no screen lock, so it can't confirm allowing. You can still deny from here.` : text}
      </Text>
      {/* An error only offers Re-confirm when re-confirming is the fix (a key problem). */}
      {error && !rekey ? null : (
      <Pressable onPress={() => (none ? openHelp() : openRekey(host.hostId))} accessibilityRole="link" hitSlop={6}>
        <Text variant="caption" color="primary" style={{ fontWeight: '600' }}>
          {none ? 'Learn more' : 'Re-confirm…'}
        </Text>
      </Pressable>
      )}
    </View>
  );
}

/**
 * One-time toast when a PC's confirmations first need attention (SPEC §15.1.5), with `Fix`.
 * Remembered per PC and state, so it doesn't repeat on every launch.
 */
export function useConfirmAttentionToast() {
  const host = useActiveHost();
  const state = useConfirmState();
  // Only once the PC has said whether it requires confirmation at all.
  const known = !!useHostInfo().data;
  const hostName = useHostLabel();
  const shown = usePrefsStore((s) => (host ? s.confirmToastShown[host.hostId] : undefined));
  useEffect(() => {
    if (!host || !known) return;
    const attention = state === 'needs_reconfirm' || state === 'none' ? state : null;
    if (!attention || shown === attention) return;
    const prefs = usePrefsStore.getState();
    prefs.update({ confirmToastShown: { ...prefs.confirmToastShown, [host.hostId]: attention } });
    toast(`Confirmations need attention on ${hostName}`, 'info', {
      label: 'Fix',
      onPress: () => (attention === 'none' ? openHelp() : openRekey(host.hostId)),
    });
  }, [host, known, state, shown, hostName]);
}

const styles = StyleSheet.create({
  line: { minHeight: 32, justifyContent: 'center' },
  center: { textAlign: 'center' },
  notice: { borderLeftWidth: 4, borderRadius: 8, padding: space.md, gap: space.xs },
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: space.md, gap: space.xs },
});
