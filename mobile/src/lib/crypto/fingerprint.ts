import { sha256 } from './primitives';

/** Human-comparable key fingerprint: first 16 bytes of SHA-256, hex, grouped in 4s. */
export function fingerprint(publicKey: Uint8Array): string {
  const hex = Array.from(sha256(publicKey).slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
  return hex.match(/.{4}/g)!.join(' ').toUpperCase();
}
