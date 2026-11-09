import { create } from 'zustand';

import { createApi } from '@/lib/api/api';
import type { AionDxApi } from '@/lib/api/client';
import { createMockTransport } from '@/lib/api/mock/transport';
import { SecureChannel } from '@/lib/api/secureChannel';
import { createSecureTransport } from '@/lib/api/transport';
import type { ConfirmMode, DeviceIdentity, PairingOffer } from '@/lib/crypto/protocol';
import { deleteCache } from '@/lib/storage/encryptedCache';
import {
  deleteConfirmKey,
  deleteDeviceIdentity,
  loadDeviceIdentity,
  loadPairedHosts,
  migrateLegacyIdentity,
  type PairedHost,
  saveConfirmKey,
  saveDeviceIdentity,
  savePairedHosts,
  wipeAllKeys,
} from '@/lib/storage/keyStore';
import { useHealthStore } from '@/state/healthStore';
import { simulateKeyUnlock } from '@/state/lockStore';
import { toast } from '@/state/toastStore';

type Status = 'loading' | 'unpaired' | 'paired' | 'error';

/** Built-in host backed by the in-memory facade (lib/api/mock) so the app is usable without a PC. */
export const DEMO_HOST_ID = 'demo';
export const DEMO_ENABLED = __DEV__ || process.env.EXPO_PUBLIC_ENABLE_DEMO === '1';
const isDemo = (hostId: string) => hostId === DEMO_HOST_ID;

interface AddHostOptions {
  enterApp?: boolean;
  /** The identity this pairing was made with (a fresh one per PC, contract A5). */
  identity?: DeviceIdentity;
  /** Bridge-issued confirm key from the approved pair response, stored per `host.confirmMode`. */
  confirmKey?: Uint8Array;
}

interface ConnectionState {
  status: Status;
  error: string | null;
  /** Phone identity per paired PC, keyed by hostId. The demo host has none. */
  identities: Record<string, DeviceIdentity>;
  hosts: PairedHost[];
  activeHostId: string | null;
  /** Scanned but not yet approved. Held in memory only — it contains the one-time pairing secret. */
  pendingOffer: PairingOffer | null;

  hydrate: () => Promise<void>;
  setPendingOffer: (offer: PairingOffer | null) => void;
  /**
   * Saves a newly paired PC and makes it active. With `enterApp: false` the app stays in
   * onboarding: flipping status to 'paired' swaps the root navigator's screens, which
   * would reset the onboarding stack mid-flow. Call `enterApp()` when onboarding is done.
   */
  addHost: (host: PairedHost, opts?: AddHostOptions) => Promise<void>;
  enterApp: () => void;
  addDemoHost: () => Promise<void>;
  /** Persists a change to one pairing (e.g. its confirm state) and rebuilds its API client. */
  updateHost: (hostId: string, patch: Partial<PairedHost>) => Promise<void>;
  /** Stores a re-issued confirm key under its mode and clears any key problem (SPEC §15.3 R3). */
  storeConfirmKey: (hostId: string, key: Uint8Array, mode: ConfirmMode) => Promise<void>;
  setActiveHost: (hostId: string) => void;
  /** Deletes the pairing, that PC's identity and confirm key, and its cache. */
  forgetHost: (hostId: string) => Promise<void>;
  resetDevice: () => Promise<void>;
}

/**
 * Pairing/connection state. Secrets are persisted by keyStore, not here; this
 * store only mirrors them in memory for the running app.
 */
export const useConnectionStore = create<ConnectionState>()((set, get) => ({
  status: 'loading',
  error: null,
  identities: {},
  hosts: [],
  activeHostId: null,
  pendingOffer: null,

  hydrate: async () => {
    try {
      const stored = await loadPairedHosts();
      await migrateLegacyIdentity(stored, isDemo);
      const hosts = DEMO_ENABLED ? stored : stored.filter((h) => !isDemo(h.hostId));
      const identities: Record<string, DeviceIdentity> = {};
      for (const h of hosts) {
        if (isDemo(h.hostId)) continue;
        const identity = await loadDeviceIdentity(h.hostId);
        if (identity) identities[h.hostId] = identity;
      }
      set({
        identities,
        hosts,
        activeHostId: hosts[0]?.hostId ?? null,
        status: hosts.length > 0 ? 'paired' : 'unpaired',
        error: null,
      });
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  },

  setPendingOffer: (pendingOffer) => set({ pendingOffer }),

  addHost: async (host, { enterApp = true, identity, confirmKey } = {}) => {
    // Identity first: a crash between the two writes must never leave a pairing without its key.
    if (identity) await saveDeviceIdentity(host.hostId, identity);
    if (confirmKey && host.confirmMode) {
      try {
        await saveConfirmKey(host.hostId, confirmKey, host.confirmMode);
      } catch {
        // e.g. biometric-gated storage is unavailable (Expo Go). Pairing still works; only
        // bridge-confirmed actions will need the confirm key re-issued from the PC (§5.3).
        toast("Couldn't store this PC's approval key. Approvals may need re-confirming on the PC.", 'error');
      }
    }
    const hosts = [host, ...get().hosts.filter((h) => h.hostId !== host.hostId)];
    await savePairedHosts(hosts);
    apis.delete(host.hostId);
    // A re-pair keeps the same host id, so clear any "revoked" state from the old pairing.
    useHealthStore.getState().reset();
    const identities = identity ? { ...get().identities, [host.hostId]: identity } : get().identities;
    // The offer stays until enterApp(): the verify screen treats a missing offer as "go back to scan".
    set({
      hosts,
      identities,
      activeHostId: host.hostId,
      ...(enterApp ? { status: 'paired' as const, pendingOffer: null } : {}),
    });
  },

  enterApp: () => set((s) => ({ status: s.hosts.length > 0 ? 'paired' : s.status, pendingOffer: null })),

  addDemoHost: async () => {
    // The demo PC behaves like a real one with a biometric confirm key (simulated by the OS prompt).
    await get().addHost({ hostId: DEMO_HOST_ID, hostName: 'DEMO-PC', hostPublicKey: '', urls: [], pairedAt: Date.now(), confirmMode: 'biometric' });
  },

  updateHost: async (hostId, patch) => {
    const hosts = get().hosts.map((h) => (h.hostId === hostId ? { ...h, ...patch } : h));
    await savePairedHosts(hosts);
    // The transport holds a snapshot of the pairing (confirm mode), so the client is rebuilt.
    apis.delete(hostId);
    set({ hosts });
  },

  storeConfirmKey: async (hostId, key, mode) => {
    // The demo PC has no keystore entry: its "key" is the simulated prompt.
    if (!isDemo(hostId)) await saveConfirmKey(hostId, key, mode);
    await get().updateHost(hostId, { confirmMode: mode, keyInvalid: false });
  },

  setActiveHost: (activeHostId) => set({ activeHostId }),

  forgetHost: async (hostId) => {
    const hosts = get().hosts.filter((h) => h.hostId !== hostId);
    await savePairedHosts(hosts);
    await Promise.all([deleteDeviceIdentity(hostId), deleteConfirmKey(hostId), deleteCache(hostId)]);
    apis.delete(hostId);
    const { [hostId]: _forgotten, ...identities } = get().identities;
    const activeHostId = get().activeHostId === hostId ? (hosts[0]?.hostId ?? null) : get().activeHostId;
    set({ hosts, identities, activeHostId, status: hosts.length > 0 ? 'paired' : 'unpaired' });
  },

  resetDevice: async () => {
    const hostIds = get().hosts.map((h) => h.hostId);
    await Promise.all(hostIds.map((id) => deleteCache(id)));
    await wipeAllKeys(hostIds);
    apis.clear();
    set({ hosts: [], identities: {}, activeHostId: null, status: 'loading' });
    await get().hydrate();
  },
}));

const apis = new Map<string, AionDxApi>();

/** One API client (and so one SecureChannel/session) per paired host, shared by all queries. */
export function getApi(hostId: string): AionDxApi {
  let api = apis.get(hostId);
  if (api) return api;
  const { identities, hosts } = useConnectionStore.getState();
  const host = hosts.find((h) => h.hostId === hostId);
  if (!host) throw new Error('No paired PC');
  if (isDemo(host.hostId)) {
    api = createApi(
      createMockTransport(simulateKeyUnlock, {
        keyInvalid: () => !!useConnectionStore.getState().hosts.find((h) => h.hostId === hostId)?.keyInvalid,
      }),
    );
  } else {
    const identity = identities[hostId];
    if (!identity) throw new Error('No device identity for this PC. Pair it again.');
    api = createApi(createSecureTransport(new SecureChannel(identity, host), { onKeyProblem: () => markKeyInvalid(hostId) }));
  }
  apis.set(hostId, api);
  return api;
}

/** The confirm key is unusable (unreadable or rejected): flag the pairing once (SPEC §15.1.5). */
function markKeyInvalid(hostId: string) {
  const host = useConnectionStore.getState().hosts.find((h) => h.hostId === hostId);
  if (host && !host.keyInvalid) void useConnectionStore.getState().updateHost(hostId, { keyInvalid: true });
}

export function useActiveHost(): PairedHost | undefined {
  return useConnectionStore((s) => s.hosts.find((h) => h.hostId === s.activeHostId));
}

/** This phone's identity for the active PC (none for the demo host). */
export function useActiveIdentity(): DeviceIdentity | undefined {
  return useConnectionStore((s) => (s.activeHostId ? s.identities[s.activeHostId] : undefined));
}
