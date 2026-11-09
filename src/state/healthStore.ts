import { create } from 'zustand';

import { DeviceRevokedError, HostRefusedError, HostResetError } from '@/lib/api/secureChannel';
import { poll } from '@/theme';

const FAILURE_BURST_MS = 1500;

/**
 * revoked: verified A1 notice (the pairing is deleted). refused: an unauthenticated 403.
 * host_reset: 409 unknown_host. The last two are plaintext and could be spoofed, so they keep
 * the pairing and keep polling (with backoff) in case they clear up.
 */
export type FailureKind = 'unreachable' | 'revoked' | 'refused' | 'host_reset' | 'not_running';

interface HealthState {
  consecutiveFailures: number;
  lastSuccessAt: number | null;
  lastFailure: FailureKind | null;
  lastFailureAt: number | null;
  recordSuccess: () => void;
  recordFailure: (error: unknown) => void;
  reset: () => void;
}

/**
 * Connection health for the active host, fed by every polling query. Drives
 * ConnectionBanner, backoff, and the "offline → mutations disabled" rule (SPEC §4.8, §5).
 */
export const useHealthStore = create<HealthState>()((set) => ({
  consecutiveFailures: 0,
  lastSuccessAt: null,
  lastFailure: null,
  lastFailureAt: null,
  recordSuccess: () => set({ consecutiveFailures: 0, lastSuccessAt: Date.now(), lastFailure: null, lastFailureAt: null }),
  recordFailure: (error) =>
    set((s) => {
      // Several queries poll together; failures landing within one burst count as one failed poll,
      // so the banner goes through "Reconnecting" before "Can't reach" (SPEC §4.8).
      const now = Date.now();
      const sameBurst = s.lastFailureAt !== null && now - s.lastFailureAt < FAILURE_BURST_MS;
      return {
        consecutiveFailures: sameBurst ? s.consecutiveFailures : s.consecutiveFailures + 1,
        lastFailure: classify(error),
        lastFailureAt: now,
      };
    }),
  reset: () => set({ consecutiveFailures: 0, lastSuccessAt: null, lastFailure: null, lastFailureAt: null }),
}));

function classify(error: unknown): FailureKind {
  if (error instanceof DeviceRevokedError) return 'revoked';
  if (error instanceof HostRefusedError) return 'refused';
  if (error instanceof HostResetError) return 'host_reset';
  // [ASSUMED] the bridge answers but reports AionDX itself isn't running.
  if (error instanceof Error && /not.?running/i.test(error.message)) return 'not_running';
  return 'unreachable';
}

export type ConnectionState = 'ok' | 'reconnecting' | 'unreachable' | 'revoked' | 'refused' | 'host_reset' | 'not_running';

export function connectionState(s: Pick<HealthState, 'consecutiveFailures' | 'lastSuccessAt' | 'lastFailure'>, now = Date.now()): ConnectionState {
  if (s.lastFailure === 'revoked') return 'revoked';
  if (s.consecutiveFailures === 0) return 'ok';
  if (s.lastFailure === 'refused' || s.lastFailure === 'host_reset' || s.lastFailure === 'not_running') return s.lastFailure;
  const staleFor = s.lastSuccessAt ? now - s.lastSuccessAt : Infinity;
  if (s.consecutiveFailures > 3 || staleFor > poll.unreachableAfterMs) return 'unreachable';
  return 'reconnecting';
}

export function useConnectionState(): ConnectionState {
  return useHealthStore((s) => connectionState(s));
}

/** Mutating controls are disabled while the PC can't be reached (SPEC §4.8). */
export function useIsOffline(): boolean {
  const state = useConnectionState();
  return state !== 'ok' && state !== 'reconnecting';
}

/** The PC doesn't (or may not) accept this phone: nothing can be approved or sent. */
export function isTrustProblem(state: ConnectionState): boolean {
  return state === 'revoked' || state === 'refused' || state === 'host_reset';
}

/** Poll interval with failure backoff: 3 s → 6 s → 12 s → 30 s, reset on success (SPEC §5). */
export function backoffInterval(base: number, failures: number): number {
  if (failures === 0) return base;
  return Math.max(base, poll.backoff[Math.min(failures - 1, poll.backoff.length - 1)]);
}
