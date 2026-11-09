/**
 * TEST-ONLY helpers for reproducing the bridge team's shared vectors byte for byte.
 * Production code must use `seal()` (random nonce). A fixed nonce here is only safe because
 * the keys and plaintexts are public test data.
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';

import { NONCE_BYTES } from './primitives';

/** XChaCha20-Poly1305 with a caller-chosen nonce; returns ciphertext ‖ 16-byte tag. */
export function sealWithNonce(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array {
  if (nonce.length !== NONCE_BYTES) throw new Error('sealWithNonce: bad nonce length');
  return xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new Error('fromHex: invalid hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
