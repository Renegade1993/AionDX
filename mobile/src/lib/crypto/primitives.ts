import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';

export const KEY_BYTES = 32;
export const NONCE_BYTES = 24;

export interface KeyPair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

export { randomBytes, sha256 };

export function generateKeyPair(): KeyPair {
  const secretKey = randomBytes(KEY_BYTES);
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

export function publicKeyFromSecret(secretKey: Uint8Array): Uint8Array {
  return x25519.getPublicKey(secretKey);
}

/** X25519 ECDH. Rejects low-order points (noble throws on an all-zero shared secret). */
export function dh(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== KEY_BYTES) throw new Error('dh: bad public key length');
  return x25519.getSharedSecret(secretKey, publicKey);
}

export function deriveKey(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length = KEY_BYTES): Uint8Array {
  return hkdf(sha256, ikm, salt, info, length);
}

/** XChaCha20-Poly1305 with a random 24-byte nonce (safe to generate randomly). */
export function seal(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): { nonce: Uint8Array; ciphertext: Uint8Array } {
  const nonce = randomBytes(NONCE_BYTES);
  return { nonce, ciphertext: xchacha20poly1305(key, nonce, aad).encrypt(plaintext) };
}

/** Throws if authentication fails. */
export function open(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, aad: Uint8Array): Uint8Array {
  if (nonce.length !== NONCE_BYTES) throw new Error('open: bad nonce length');
  return xchacha20poly1305(key, nonce, aad).decrypt(ciphertext);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** RFC 4122 version-4 UUID from the CSPRNG (request ids, contract A4). */
export function randomUuid(): string {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
