import type { ConfirmMode, DeviceIdentity } from '../crypto/protocol';
import { publicKeyFromSecret, randomBytes, sha256 } from '../crypto/primitives';
import { fromB64u, toB64u, utf8 } from '../encoding';
import { secureStorage } from './secureStorage';

/*
 * Long-term secrets live only in the platform keystore (see secureStorage.ts); session
 * keys are never persisted. One phone identity per paired PC (contract A5): revoking on
 * one PC never affects another, PCs can't correlate the phone, and forgetting a PC
 * deletes its keypair, which is final even if that PC never hears about it.
 */

/** Pre-A5 single identity shared by every PC. Migrated on first load, then deleted. */
const LEGACY_DEVICE_KEY = 'aiondx.device.v1';
const HOSTS_KEY = 'aiondx.hosts.v1';

export interface PairedHost {
  hostId: string;
  hostName: string;
  /** base64url X25519 static public key, pinned at pairing time. */
  hostPublicKey: string;
  urls: string[];
  pairedAt: number;
  /** How this PC's confirm key is protected (§5.2); absent for pairings made before it existed. */
  confirmMode?: ConfirmMode;
  /**
   * The key can't be used: it read as null (biometrics changed) or the PC rejected its proof
   * (`confirm_invalid`). Sensitive actions stay unavailable until a re-key (SPEC §15.1.5, §15.3).
   */
  keyInvalid?: boolean;
}

interface StoredDevice {
  deviceId: string;
  secretKey: string;
}

/** Host ids are arbitrary strings; SecureStore keys and filenames need a safe charset. */
export function hostSlug(hostId: string): string {
  return toB64u(sha256(utf8(hostId))).slice(0, 22);
}

const deviceKeyFor = (hostId: string) => `aiondx.device.${hostSlug(hostId)}`;
const confirmKeyFor = (hostId: string) => `aiondx.confirm.${hostSlug(hostId)}`;

function toIdentity(stored: StoredDevice): DeviceIdentity {
  const secretKey = fromB64u(stored.secretKey);
  return { deviceId: stored.deviceId, secretKey, publicKey: publicKeyFromSecret(secretKey) };
}

/** A fresh keypair and deviceId for one pairing attempt. Persisted only once the PC approves. */
export function createDeviceIdentity(): DeviceIdentity {
  const secretKey = randomBytes(32);
  return { deviceId: toB64u(randomBytes(16)), secretKey, publicKey: publicKeyFromSecret(secretKey) };
}

export async function loadDeviceIdentity(hostId: string): Promise<DeviceIdentity | null> {
  const raw = await secureStorage.get(deviceKeyFor(hostId));
  return raw ? toIdentity(JSON.parse(raw) as StoredDevice) : null;
}

export async function saveDeviceIdentity(hostId: string, identity: DeviceIdentity): Promise<void> {
  const stored: StoredDevice = { deviceId: identity.deviceId, secretKey: toB64u(identity.secretKey) };
  await secureStorage.set(deviceKeyFor(hostId), JSON.stringify(stored));
}

export async function deleteDeviceIdentity(hostId: string): Promise<void> {
  await secureStorage.remove(deviceKeyFor(hostId));
}

/**
 * Moves a pre-A5 shared identity to every existing pairing that lacks its own: those
 * PCs pinned that exact key, so it must keep working until they're re-paired. The
 * legacy entry is deleted only after every copy succeeded; a failure leaves it in place
 * for the next launch. Pairings made from now on get fresh per-PC identities.
 */
export async function migrateLegacyIdentity(hosts: PairedHost[], isDemo: (hostId: string) => boolean): Promise<void> {
  const raw = await secureStorage.get(LEGACY_DEVICE_KEY);
  if (!raw) return;
  for (const host of hosts) {
    if (isDemo(host.hostId)) continue;
    if (!(await secureStorage.get(deviceKeyFor(host.hostId)))) await secureStorage.set(deviceKeyFor(host.hostId), raw);
  }
  await secureStorage.remove(LEGACY_DEVICE_KEY);
}

/**
 * Stores the bridge-issued confirm key per its mode (contract §5.2). Read with readConfirmKey.
 * - biometric: reads need Face ID / fingerprint, enforced by the secure hardware.
 * - device_passcode: plain keystore item; the app must prompt for the passcode before reading.
 * - none: no key is issued, so nothing is stored (and any stale key is removed).
 */
export async function saveConfirmKey(hostId: string, key: Uint8Array, mode: ConfirmMode): Promise<void> {
  if (mode === 'none') {
    await deleteConfirmKey(hostId);
    return;
  }
  await secureStorage.set(
    confirmKeyFor(hostId),
    toB64u(key),
    mode === 'biometric' ? { requireAuthentication: true, authenticationPrompt: 'Protect approvals for this PC' } : undefined,
  );
}

/**
 * Raw confirm-key read. For a biometric key this shows the OS prompt: it rejects if the user
 * cancels, and resolves null if the key was invalidated (enrolled biometrics changed) or never
 * stored. A device_passcode key is a plain item: the caller must authenticate first (§5.2).
 */
export async function readConfirmKey(hostId: string, mode: 'biometric' | 'device_passcode', prompt: string): Promise<Uint8Array | null> {
  const stored = await secureStorage.get(
    confirmKeyFor(hostId),
    mode === 'biometric' ? { requireAuthentication: true, authenticationPrompt: prompt } : undefined,
  );
  return stored ? fromB64u(stored) : null;
}

export async function deleteConfirmKey(hostId: string): Promise<void> {
  await secureStorage.remove(confirmKeyFor(hostId));
}

export async function loadPairedHosts(): Promise<PairedHost[]> {
  const raw = await secureStorage.get(HOSTS_KEY);
  return raw ? (JSON.parse(raw) as PairedHost[]) : [];
}

export async function savePairedHosts(hosts: PairedHost[]): Promise<void> {
  await secureStorage.set(HOSTS_KEY, JSON.stringify(hosts));
}

/** Removes every identity, confirm key and pairing. The PCs must re-pair this phone. */
export async function wipeAllKeys(hostIds: string[]): Promise<void> {
  await Promise.all([
    secureStorage.remove(LEGACY_DEVICE_KEY),
    secureStorage.remove(HOSTS_KEY),
    ...hostIds.flatMap((id) => [deleteDeviceIdentity(id), deleteConfirmKey(id)]),
  ]);
}
