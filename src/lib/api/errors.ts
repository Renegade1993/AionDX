/**
 * Facade errors (contract §6.0): `{error: {code, message, details?}}` inside a sealed response,
 * plus the client-side confirmation failures (§5). Outer transport errors live in secureChannel.ts.
 */

import { Platform } from 'react-native';

export type ApiErrorCode =
  | 'invalid_request'
  | 'confirm_invalid'
  | 'rekey_invalid'
  | 'not_found'
  | 'no_rekey_offer'
  | 'no_such_route'
  | 'conflict'
  | 'already_resolved'
  | 'busy'
  | 'ambiguous_decision'
  | 'lead_not_allowed'
  | 'confirm_required'
  | 'rate_limited'
  | 'team_session_failed'
  | 'backend_unavailable'
  | (string & {});

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message || `AionDX API error ${status}${code ? ` (${code})` : ''}`);
    this.name = 'ApiError';
  }
}

/** Builds an ApiError from a non-2xx InnerResponse, tolerating bodies that don't follow §6.0. */
export function apiErrorFrom(status: number, body: unknown): ApiError {
  const e = body && typeof body === 'object' && 'error' in body ? (body as { error: unknown }).error : undefined;
  if (e && typeof e === 'object') {
    const { code, message, details } = e as { code?: unknown; message?: unknown; details?: unknown };
    return new ApiError(
      status,
      typeof code === 'string' ? code : '',
      typeof message === 'string' ? message : '',
      details && typeof details === 'object' ? (details as Record<string, unknown>) : undefined,
    );
  }
  // A bare string code (older shape) still identifies the failure.
  return new ApiError(status, typeof e === 'string' ? e : '', '');
}

export const isApiError = (err: unknown, code?: ApiErrorCode): err is ApiError =>
  err instanceof ApiError && (code === undefined || err.code === code);

/**
 * How a `409 already_resolved` approval ended (§6.5, rev 4.5 `details.resolution`). Older bridges
 * send no details: it was answered somewhere else.
 */
export const resolutionOf = (err: ApiError): 'answered' | 'cancelled' => (err.details?.resolution === 'cancelled' ? 'cancelled' : 'answered');

/** The user dismissed the Face ID / passcode prompt for a sensitive action. Not a failure to report. */
export class ConfirmCancelledError extends Error {
  /**
   * cancel: dismissed (or, in biometric mode, any prompt failure: secure-store reports them all the
   * same). failed / lockout: only distinguishable in device_passcode mode, where the OS says so.
   */
  constructor(
    readonly reason: 'cancel' | 'failed' | 'lockout' = 'cancel',
    /** The action's prompt text: repeated cancels of the same action are counted per prompt. */
    readonly prompt?: string,
  ) {
    super('Cancelled');
    this.name = 'ConfirmCancelledError';
  }
}

const NEUTRAL_AFTER = 2;
const NEUTRAL_WINDOW_MS = 30_000;
const recentCancels = new Map<string, number[]>();

/**
 * What to say after a confirmation prompt didn't go through (SPEC §15.1.3, §16 D4):
 * - passcode mode lockout / mismatch: the specific message (the OS reports these);
 * - the 2nd failed or cancelled prompt for the same action within 30 s: one neutral hint, since in
 *   biometric mode a lockout looks exactly like a cancel;
 * - otherwise nothing: cancelling is a normal choice.
 */
/** A confirmation went through: earlier cancels no longer count toward the hint. */
export function clearCancelNotices(): void {
  recentCancels.clear();
}

export function cancelNotice(err: ConfirmCancelledError, now = Date.now()): string | null {
  if (err.reason === 'lockout') return 'Too many passcode attempts. Unlock your phone with its passcode, then try again.';
  const key = err.prompt ?? '';
  const times = (recentCancels.get(key) ?? []).filter((t) => now - t < NEUTRAL_WINDOW_MS);
  times.push(now);
  if (times.length >= NEUTRAL_AFTER) {
    // Once per run of failures; the count starts over after the hint.
    recentCancels.delete(key);
    return `Couldn't confirm. If ${Platform.OS === 'ios' ? 'Face ID' : 'biometric unlock'} is locked, unlock your phone with its passcode, then try again.`;
  }
  recentCancels.set(key, times);
  return err.reason === 'failed' ? "Passcode didn't match. Try again." : null;
}

/**
 * "Confirmations unavailable" (SPEC §15.1.5): the PC requires confirmation (428) but this phone
 * can't produce a proof. no_passcode: no screen lock (confirmMode none, or the passcode was removed).
 * no_key: the pairing has no confirm key (made before keys existed, or the key is gone).
 * `nowRequired`: the PC turned confirmation on after the phone last read /v1/host.
 */
export class ConfirmUnavailableError extends Error {
  constructor(
    readonly reason: 'no_passcode' | 'no_key',
    readonly nowRequired = false,
  ) {
    super(
      (nowRequired ? 'Your PC now requires confirmation for this. ' : '') +
        (reason === 'no_passcode'
          ? "This phone has no screen lock, so it can't confirm it. Set a passcode, then re-confirm this phone on your PC, or turn off \"Require confirmation\" for it there."
          : "This phone can't confirm it until it's re-confirmed on your PC."),
    );
    this.name = 'ConfirmUnavailableError';
  }
}

/**
 * The biometric-protected confirm key is gone: enrolled biometrics changed, which invalidates it
 * on iOS and Android (§5). Sensitive actions stay unavailable until the key is re-issued (§5.3).
 */
export class ConfirmKeyInvalidatedError extends Error {
  constructor() {
    super(
      `Your ${Platform.OS === 'ios' ? 'Face ID or Touch ID settings' : 'fingerprints or face unlock'} changed, so this phone needs to be re-confirmed on your PC.`,
    );
    this.name = 'ConfirmKeyInvalidatedError';
  }
}

/** One-line copy for a failed action; `null` means say nothing (the user cancelled). */
export function describeActionError(err: unknown, fallback: string): string | null {
  if (err instanceof ConfirmCancelledError) return cancelNotice(err);
  if (err instanceof ConfirmUnavailableError || err instanceof ConfirmKeyInvalidatedError) return err.message;
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'confirm_invalid':
        return "The PC didn't accept this phone's confirmation. Re-issue the confirm key on your PC.";
      case 'confirm_required':
        return 'The PC needs a confirmation for this action.';
      case 'lead_not_allowed':
        return "That isn't available for the team lead.";
      case 'already_resolved':
        return resolutionOf(err) === 'cancelled' ? 'No longer needed — the agent moved on.' : 'Answered on your PC.';
      case 'team_session_failed': {
        const reason = typeof err.details?.error === 'string' ? err.details.error : null;
        return reason ? `The team couldn't start: ${reason}` : "The team couldn't start.";
      }
      case 'busy':
        return 'The agent is busy. Try again in a moment.';
      case 'rate_limited':
        return 'Too many requests. Try again in a moment.';
      case 'backend_unavailable':
        return 'AionDX on your PC is not responding.';
      default:
        return err.message && !err.message.startsWith('AionDX API error') ? `${fallback}: ${err.message}` : fallback;
    }
  }
  return fallback;
}
