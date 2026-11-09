/** Per-PC identities (contract A5), the legacy migration, and confirm-key storage modes. */
import { toB64u } from '../../encoding';
import {
  createDeviceIdentity,
  deleteConfirmKey,
  deleteDeviceIdentity,
  loadDeviceIdentity,
  migrateLegacyIdentity,
  type PairedHost,
  saveConfirmKey,
  saveDeviceIdentity,
  wipeAllKeys,
} from '../keyStore';

const mockStore = new Map<string, { value: string; opts?: { requireAuthentication?: boolean } }>();
let mockFailSetFor: string | null = null;

jest.mock('../secureStorage', () => ({
  secureStorage: {
    get: async (key: string) => mockStore.get(key)?.value ?? null,
    set: async (key: string, value: string, opts?: { requireAuthentication?: boolean }) => {
      if (mockFailSetFor && key.includes(mockFailSetFor)) throw new Error('keystore unavailable');
      mockStore.set(key, { value, opts });
    },
    remove: async (key: string) => void mockStore.delete(key),
  },
}));

const host = (hostId: string): PairedHost => ({ hostId, hostName: hostId, hostPublicKey: '', urls: [], pairedAt: 0 });
const isDemo = (id: string) => id === 'demo';
const legacy = { deviceId: 'legacy-device', secretKey: toB64u(new Uint8Array(32).fill(3)) };

beforeEach(() => {
  mockStore.clear();
  mockFailSetFor = null;
});

describe('per-PC identity', () => {
  it('stores one identity per host id; each PC gets its own deviceId and key', async () => {
    const a = createDeviceIdentity();
    const b = createDeviceIdentity();
    await saveDeviceIdentity('pc-a', a);
    await saveDeviceIdentity('pc-b', b);
    const loadedA = await loadDeviceIdentity('pc-a');
    const loadedB = await loadDeviceIdentity('pc-b');
    expect(loadedA?.deviceId).toBe(a.deviceId);
    expect(toB64u(loadedA!.publicKey)).toBe(toB64u(a.publicKey));
    expect(loadedB?.deviceId).not.toBe(loadedA?.deviceId);
    await deleteDeviceIdentity('pc-a');
    expect(await loadDeviceIdentity('pc-a')).toBeNull();
    expect(await loadDeviceIdentity('pc-b')).not.toBeNull();
  });
});

describe('legacy single-identity migration', () => {
  it('copies the legacy identity to every existing real pairing, then deletes it', async () => {
    mockStore.set('aiondx.device.v1', { value: JSON.stringify(legacy) });
    await migrateLegacyIdentity([host('pc-a'), host('pc-b'), host('demo')], isDemo);
    expect((await loadDeviceIdentity('pc-a'))?.deviceId).toBe('legacy-device');
    expect((await loadDeviceIdentity('pc-b'))?.deviceId).toBe('legacy-device');
    expect(await loadDeviceIdentity('demo')).toBeNull();
    expect(mockStore.has('aiondx.device.v1')).toBe(false);
  });

  it('never overwrites a per-PC identity that already exists', async () => {
    const own = createDeviceIdentity();
    await saveDeviceIdentity('pc-a', own);
    mockStore.set('aiondx.device.v1', { value: JSON.stringify(legacy) });
    await migrateLegacyIdentity([host('pc-a')], isDemo);
    expect((await loadDeviceIdentity('pc-a'))?.deviceId).toBe(own.deviceId);
  });

  it('keeps the legacy entry if a copy fails, so the next launch can retry', async () => {
    mockStore.set('aiondx.device.v1', { value: JSON.stringify(legacy) });
    mockFailSetFor = 'aiondx.device.';
    await expect(migrateLegacyIdentity([host('pc-a')], isDemo)).rejects.toThrow();
    expect(mockStore.has('aiondx.device.v1')).toBe(true);
  });

  it('is a no-op without a legacy entry', async () => {
    await migrateLegacyIdentity([host('pc-a')], isDemo);
    expect(await loadDeviceIdentity('pc-a')).toBeNull();
  });
});

describe('confirm key storage (§5.2)', () => {
  const key = new Uint8Array(32).fill(9);
  const confirmEntry = () => [...mockStore.entries()].find(([k]) => k.startsWith('aiondx.confirm.'))?.[1];

  it('biometric → requireAuthentication', async () => {
    await saveConfirmKey('pc-a', key, 'biometric');
    expect(confirmEntry()).toEqual({ value: toB64u(key), opts: expect.objectContaining({ requireAuthentication: true }) });
  });

  it('device_passcode → plain keystore item (the app gates reads)', async () => {
    await saveConfirmKey('pc-a', key, 'device_passcode');
    expect(confirmEntry()).toEqual({ value: toB64u(key), opts: undefined });
  });

  it('none → nothing stored, and a stale key is removed', async () => {
    await saveConfirmKey('pc-a', key, 'device_passcode');
    await saveConfirmKey('pc-a', key, 'none');
    expect(confirmEntry()).toBeUndefined();
  });

  it('forget and wipe remove identities and confirm keys', async () => {
    await saveDeviceIdentity('pc-a', createDeviceIdentity());
    await saveConfirmKey('pc-a', key, 'biometric');
    await deleteConfirmKey('pc-a');
    expect(confirmEntry()).toBeUndefined();
    await saveConfirmKey('pc-a', key, 'biometric');
    mockStore.set('aiondx.device.v1', { value: '{}' });
    await wipeAllKeys(['pc-a']);
    expect(mockStore.size).toBe(0);
  });
});
