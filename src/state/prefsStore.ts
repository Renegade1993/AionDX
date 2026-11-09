import { create } from 'zustand';

import { secureStorage } from '@/lib/storage/secureStorage';

export type LockMethod = 'biometric' | 'passcode' | 'none';

/** Capped at 5 minutes (SPEC §15): app lock is the only control on chat send (contract §5.1). */
export const AUTO_LOCK_OPTIONS = [
  { ms: 0, label: 'Immediately' },
  { ms: 60_000, label: 'After 1 minute' },
  { ms: 5 * 60_000, label: 'After 5 minutes' },
] as const;
const MAX_AUTO_LOCK_MS = 5 * 60_000;

export interface Prefs {
  /** Sent in pairing requests (SPEC P1b); null until the user names the phone. */
  deviceName: string | null;
  lockMethod: LockMethod;
  autoLockMs: number;
  /** Last selected team per host. */
  activeTeamByHost: Record<string, string>;
  /** Local display names for paired PCs (S2 "Rename" is phone-only). */
  hostLabels: Record<string, string>;
  /** Hosts whose "Confirmations need attention" toast was shown, with the state it was shown for. */
  confirmToastShown: Record<string, string>;
  /** Declined shutdowns dismissed with "Keep running", by `hostId:slotId` → requestedAt (SPEC §14.1.5). */
  dismissedRejections: Record<string, number>;
}

const DEFAULTS: Prefs = {
  deviceName: null,
  lockMethod: 'biometric',
  autoLockMs: 5 * 60_000,
  activeTeamByHost: {},
  hostLabels: {},
  confirmToastShown: {},
  dismissedRejections: {},
};

const KEY = 'aiondx.prefs.v1';

interface PrefsState extends Prefs {
  loaded: boolean;
  load: () => Promise<void>;
  update: (patch: Partial<Prefs>) => void;
}

/** Non-secret preferences. Kept in SecureStore anyway (small, and avoids another storage dependency). */
export const usePrefsStore = create<PrefsState>()((set, get) => ({
  ...DEFAULTS,
  loaded: false,
  load: async () => {
    const raw = await secureStorage.get(KEY).catch(() => null);
    const stored = raw ? (JSON.parse(raw) as Partial<Prefs> & { approvalBiometric?: unknown }) : {};
    // "Face ID before approving" is gone (SPEC §15: the PC enforces confirmation now).
    delete stored.approvalBiometric;
    // "Refresh rate" is gone too: the change feed pushes updates; nothing polls on a timer.
    delete (stored as { pollRate?: unknown }).pollRate;
    // A stored 15 min auto-lock from before the cap becomes 5 min.
    if (typeof stored.autoLockMs === 'number' && stored.autoLockMs > MAX_AUTO_LOCK_MS) stored.autoLockMs = MAX_AUTO_LOCK_MS;
    set({ ...DEFAULTS, ...stored, loaded: true });
  },
  update: (patch) => {
    set(patch);
    const { loaded: _loaded, load: _load, update: _update, ...prefs } = get();
    void secureStorage.set(KEY, JSON.stringify(prefs));
  },
}));
