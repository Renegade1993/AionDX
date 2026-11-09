import * as LocalAuthentication from 'expo-local-authentication';
import { Platform } from 'react-native';

import { randomUuid } from '../crypto/primitives';
import type { HttpMethod } from '../crypto/protocol';
import { type PairedHost, readConfirmKey } from '../storage/keyStore';
import { ConfirmCancelledError, ConfirmKeyInvalidatedError, ConfirmUnavailableError, isApiError } from './errors';
import type { SecureChannel } from './secureChannel';
import type { HostInfo } from './types';

/** One facade call (contract §6). */
export interface ApiRequest {
  method: HttpMethod;
  /** Facade path including the query, e.g. /v1/teams/abc/run-state. */
  path: string;
  body?: unknown;
  /** Reused across user-initiated retries so the PC de-duplicates the write (A4). */
  rid?: string;
  /**
   * Marks a §5.1 sensitive action; the text is the reason shown in the Face ID / passcode prompt.
   * The request then carries a confirm proof made with this PC's confirm key.
   */
  confirm?: string;
}

/**
 * How facade calls reach a PC. The real one seals them into the SecureChannel; the demo host
 * answers from an in-memory facade. Both speak the same /v1 surface, so everything above this
 * (api.ts, mappers, the change feed) runs identically against either.
 */
export interface Transport {
  request<T>(req: ApiRequest): Promise<T>;
  /** Raw session id, for proofs bound to it (re-key, §5.3). */
  sessionId?(): Promise<Uint8Array>;
  /** Called with every GET /v1/host answer, so the transport knows the PC's `requireConfirm`. */
  onHostInfo?(info: HostInfo): void;
}

/** The demo host's simulated key unlock: the OS prompt with the per-action copy. */
export type LocalConfirmGate = (prompt: string) => Promise<boolean>;

export interface TransportHooks {
  /** The confirm key is unusable: unreadable (biometrics changed) or rejected (`confirm_invalid`). */
  onKeyProblem?: () => void;
}

/** Errors that mean "this phone needs re-confirming" (SPEC §15.1.4). */
export const isKeyProblem = (err: unknown) => err instanceof ConfirmKeyInvalidatedError || isApiError(err, 'confirm_invalid');

/** Does this pairing hold a confirm key at all (contract §5.2)? */
export const hasConfirmKey = (host: Pick<PairedHost, 'confirmMode'>) => host.confirmMode === 'biometric' || host.confirmMode === 'device_passcode';

/**
 * Unlocks this PC's confirm key for one sensitive action, per its confirmMode (§5.2, SPEC §15.1.2):
 * - biometric: the secure-store read itself shows Face ID / fingerprint (hardware-enforced);
 * - device_passcode: LocalAuthentication (passcode allowed) before every read (app-enforced).
 * Throws ConfirmCancelledError, ConfirmKeyInvalidatedError or ConfirmUnavailableError.
 */
export async function unlockConfirmKey(host: PairedHost, prompt: string): Promise<Uint8Array> {
  const mode = host.confirmMode;
  if (mode !== 'biometric' && mode !== 'device_passcode') throw new ConfirmUnavailableError('no_key');

  if (mode === 'device_passcode' && Platform.OS !== 'web') {
    const auth = await LocalAuthentication.authenticateAsync({ promptMessage: prompt, cancelLabel: 'Cancel', disableDeviceFallback: false });
    if (!auth.success) {
      if (auth.error === 'passcode_not_set' || auth.error === 'not_enrolled') throw new ConfirmUnavailableError('no_passcode');
      // The OS tells these apart in passcode mode (SPEC §16 D4a).
      if (auth.error === 'lockout') throw new ConfirmCancelledError('lockout', prompt);
      if (auth.error === 'authentication_failed') throw new ConfirmCancelledError('failed', prompt);
      throw new ConfirmCancelledError('cancel', prompt);
    }
  }

  let key: Uint8Array | null;
  try {
    key = await readConfirmKey(host.hostId, mode, prompt);
  } catch {
    // expo-secure-store rejects the same way when the prompt is cancelled, fails or is locked out.
    throw new ConfirmCancelledError('cancel', prompt);
  }
  if (!key) {
    // A biometric key reads as null once enrolled biometrics change (§5): re-confirm needed.
    throw mode === 'biometric' ? new ConfirmKeyInvalidatedError() : new ConfirmUnavailableError('no_key');
  }
  return key;
}

/**
 * Sensitive actions on a real pairing (contract §5, SPEC §15.1.2 / §15.1.4 / §15.2):
 * - the PC requires confirmation (the default, also while unknown) and this phone has a key:
 *   prompt, sign, send;
 * - the PC has `requireConfirm` off: send unsigned, no prompt. A 428 means it was turned back on
 *   since the phone last read /v1/host: prompt once and resend signed with the same rid;
 * - no key: send unsigned. The PC accepts it only with `requireConfirm` off; a 428 means
 *   confirmations are unavailable on this phone (ConfirmUnavailableError, with the explanation).
 * There is no app-level fallback gate for real pairings: the PC is the enforcement point.
 */
export function createSecureTransport(channel: SecureChannel, hooks: TransportHooks = {}): Transport {
  let requireConfirm: boolean | undefined;
  const host = channel.host;

  async function sensitive<T>(inner: { method: HttpMethod; path: string; body?: unknown }, rid: string | undefined, confirm: string): Promise<T> {
      const knownOff = requireConfirm === false;
      const sign = hasConfirmKey(host) && !knownOff;
      // Fixed rid for this logical request: an automatic resend must de-duplicate with the first try.
      const id = rid ?? randomUuid();
      const confirmKey = sign ? await unlockConfirmKey(host, confirm) : undefined;
      try {
        return await channel.request<T>(inner, { rid: id, confirmKey });
      } catch (err) {
        if (!isApiError(err, 'confirm_required') || confirmKey) throw err;
        requireConfirm = true;
        if (!hasConfirmKey(host)) throw new ConfirmUnavailableError(host.confirmMode === 'none' ? 'no_passcode' : 'no_key', knownOff);
        // The PC turned confirmations on after we last looked: one prompt, same rid (SPEC §15.1.4).
        return channel.request<T>(inner, { rid: id, confirmKey: await unlockConfirmKey(host, confirm) });
      }
  }

  return {
    async request<T>({ method, path, body, rid, confirm }: ApiRequest): Promise<T> {
      const inner = { method, path, body };
      if (!confirm) return channel.request<T>(inner, { rid });
      try {
        return await sensitive<T>(inner, rid, confirm);
      } catch (err) {
        if (isKeyProblem(err)) hooks.onKeyProblem?.();
        throw err;
      }
    },
    sessionId: () => channel.sessionId(),
    onHostInfo: (info) => {
      requireConfirm = info.device ? info.device.requireConfirm : undefined;
    },
  };
}
