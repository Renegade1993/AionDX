import * as LocalAuthentication from 'expo-local-authentication';
import { Platform } from 'react-native';
import { create } from 'zustand';

import { usePrefsStore } from './prefsStore';

interface LockState {
  locked: boolean;
  backgroundedAt: number | null;
  lock: () => void;
  unlock: () => void;
  onBackground: () => void;
  onForeground: () => void;
}

export const useLockStore = create<LockState>()((set, get) => ({
  locked: false,
  backgroundedAt: null,
  lock: () => set({ locked: true }),
  unlock: () => set({ locked: false }),
  onBackground: () => set({ backgroundedAt: Date.now() }),
  onForeground: () => {
    const { backgroundedAt } = get();
    const { lockMethod, autoLockMs } = usePrefsStore.getState();
    if (lockMethod !== 'none' && backgroundedAt !== null && Date.now() - backgroundedAt >= autoLockMs) {
      set({ locked: true });
    }
    set({ backgroundedAt: null });
  },
}));

export type AuthResult = { ok: true; warning?: string } | { ok: false; cancelled: boolean; message: string };

/**
 * OS authentication for app unlock and approval gating.
 * - 'biometric': Face ID / fingerprint, falling back to device passcode.
 * - 'passcode': same OS prompt with "Use passcode" as the labelled fallback. Neither
 *   iOS nor Android lets an app force passcode-only, so biometrics may still appear.
 * If the device has no passcode/biometrics at all the lock can't be enforced: we
 * let the user in and return a warning so the UI can nudge them.
 */
export async function authenticate(promptMessage: string): Promise<AuthResult> {
  const { lockMethod } = usePrefsStore.getState();
  if (Platform.OS === 'web') {
    // Web preview has no biometrics; a confirm dialog stands in so both outcomes can be exercised.
    const ok = window.confirm(`${promptMessage}? (web preview — no biometrics)`);
    return ok ? { ok: true } : { ok: false, cancelled: true, message: 'Cancelled' };
  }
  const level = await LocalAuthentication.getEnrolledLevelAsync();
  if (level === LocalAuthentication.SecurityLevel.NONE) {
    return { ok: true, warning: 'Set a device passcode to protect AionDX.' };
  }
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage,
    fallbackLabel: lockMethod === 'passcode' ? 'Use passcode' : undefined,
    disableDeviceFallback: false,
  });
  if (result.success) return { ok: true };
  if (result.error === 'not_enrolled' || result.error === 'passcode_not_set') {
    return { ok: true, warning: 'Set a device passcode to protect AionDX.' };
  }
  const cancelled = result.error === 'user_cancel' || result.error === 'system_cancel' || result.error === 'app_cancel';
  return { ok: false, cancelled, message: cancelled ? 'Cancelled' : 'Authentication failed' };
}

/**
 * The demo PC's stand-in for unlocking a biometric confirm key: the same OS prompt, with the
 * per-action copy (SPEC §15.1.1). Real pairings read the keystore instead (transport.ts).
 */
export async function simulateKeyUnlock(prompt: string): Promise<boolean> {
  const r = await authenticate(prompt);
  return r.ok;
}
