import { NONCE_BYTES, open, randomBytes, seal } from '../crypto/primitives';
import { concatBytes, fromB64u, fromUtf8, toB64u, utf8 } from '../encoding';
import { blobStore } from './blobStore';
import { hostSlug } from './keyStore';
import { secureStorage } from './secureStorage';

/*
 * Encrypted-at-rest cache of last-known run-state, conversations and tasks per
 * paired PC (SPEC §8). Each host gets its own random 256-bit data key in the
 * keystore; the cache file holds nonce || XChaCha20-Poly1305(ciphertext).
 * Deleting the key (unpair / reset) crypto-shreds the file even if deletion fails.
 */

const FORMAT = 'aiondx/cache/v1';

const slug = hostSlug;

const keyName = (hostId: string) => `aiondx.cache.${slug(hostId)}`;
const fileName = (hostId: string) => `${slug(hostId)}.bin`;
const aad = (hostId: string) => utf8(`${FORMAT}|${hostId}`);

async function getOrCreateKey(hostId: string): Promise<Uint8Array> {
  const existing = await secureStorage.get(keyName(hostId));
  if (existing) return fromB64u(existing);
  const key = randomBytes(32);
  await secureStorage.set(keyName(hostId), toB64u(key));
  return key;
}

export async function saveCache(hostId: string, data: unknown): Promise<void> {
  const key = await getOrCreateKey(hostId);
  const { nonce, ciphertext } = seal(key, utf8(JSON.stringify(data)), aad(hostId));
  await blobStore.write(fileName(hostId), concatBytes(nonce, ciphertext));
}

/** Returns null if there is no cache or it can't be decrypted (it is then discarded). */
export async function loadCache<T>(hostId: string): Promise<T | null> {
  const bytes = await blobStore.read(fileName(hostId)).catch(() => null);
  if (!bytes) return null;
  const keyB64 = await secureStorage.get(keyName(hostId));
  try {
    if (!keyB64) throw new Error('missing key');
    const plaintext = open(fromB64u(keyB64), bytes.slice(0, NONCE_BYTES), bytes.slice(NONCE_BYTES), aad(hostId));
    return JSON.parse(fromUtf8(plaintext)) as T;
  } catch {
    await blobStore.remove(fileName(hostId));
    return null;
  }
}

export async function deleteCache(hostId: string): Promise<void> {
  await secureStorage.remove(keyName(hostId));
  await blobStore.remove(fileName(hostId));
}
