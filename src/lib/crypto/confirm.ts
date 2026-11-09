/**
 * Bridge-enforced confirmation (contract §5, byte layout §5.4).
 *
 * A sensitive inner request carries `confirm = b64u(HMAC-SHA256(confirmKey, macInput))`, where
 * macInput binds the session, the envelope seq, the request line, the body and the rid. Because
 * it binds `seq`, the proof is computed at seal time (SecureChannel), never ahead of it.
 */
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { concatBytes, fromB64u, toB64u, u64be, utf8 } from '../encoding';

const CONFIRM_LABEL = 'aiondx/v1/confirm';
const REKEY_LABEL = 'aiondx/v1/rekey';
const ZERO = new Uint8Array([0]);

/**
 * RFC 8785 canonical JSON for the value types sensitive bodies use: strings, booleans, null,
 * safe integers, arrays and objects. Keys sort by UTF-16 code units (JS default sort), which is
 * what RFC 8785 specifies. Object members whose value is `undefined` are dropped, exactly as
 * `JSON.stringify` drops them from the body we actually send.
 */
export function jcs(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    // Floats would need the ES number serialization rules; sensitive bodies never use them (§5).
    if (!Number.isSafeInteger(value)) throw new Error('jcs: only safe integers are supported');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : jcs(v))).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const members = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${jcs(obj[k])}`);
    return `{${members.join(',')}}`;
  }
  throw new Error(`jcs: unsupported value type ${typeof value}`);
}

export interface ConfirmInput {
  /** Raw 16-byte session id (the HKDF output, not the b64u envelope text). */
  sessionId: Uint8Array;
  seq: number;
  method: string;
  path: string;
  body?: unknown;
  rid: string;
}

/** The exact §5.4 concatenation; exported so tests can compare it with `macInput` by offset. */
export function confirmMacInput({ sessionId, seq, method, path, body, rid }: ConfirmInput): Uint8Array {
  const bodyHash = sha256(utf8(jcs(body === undefined ? null : body)));
  return concatBytes(utf8(CONFIRM_LABEL), sessionId, u64be(seq), utf8(method.toUpperCase()), ZERO, utf8(path), ZERO, bodyHash, utf8(rid));
}

export function confirmProof(confirmKey: Uint8Array, input: ConfirmInput): string {
  return toB64u(hmac(sha256, confirmKey, confirmMacInput(input)));
}

/** Re-key proof (§5.3): HMAC(rekeySecret, label ‖ sid ‖ UTF-8 of the deviceId string). */
export function rekeyMacInput(sessionId: Uint8Array, deviceId: string): Uint8Array {
  return concatBytes(utf8(REKEY_LABEL), sessionId, utf8(deviceId));
}

export function rekeyProof(rekeySecret: Uint8Array, sessionId: Uint8Array, deviceId: string): string {
  return toB64u(hmac(sha256, rekeySecret, rekeyMacInput(sessionId, deviceId)));
}

// ---------------------------------------------------------------------------
// Re-key QR (§5.3): aiondx://rekey?v=1&id=<hostId>&d=<deviceId>&s=<rekeySecret b64u>&x=<expiresAt ms>
// ---------------------------------------------------------------------------

export interface RekeyOffer {
  hostId: string;
  deviceId: string;
  rekeySecret: Uint8Array;
  expiresAt: number;
}

/** What a scanned code is, before any network request (SPEC §15.3.2 R2's local checks). */
export type ScannedCode = { kind: 'rekey'; offer: RekeyOffer } | { kind: 'pairing' } | { kind: 'unknown' };

export function encodeRekeyUri(offer: RekeyOffer): string {
  const q = new URLSearchParams({ v: '1', id: offer.hostId, d: offer.deviceId, s: toB64u(offer.rekeySecret), x: String(offer.expiresAt) });
  return `aiondx://rekey?${q.toString()}`;
}

/** Classifies a scanned string. Expiry is checked by the caller so it can say "expired" specifically. */
export function classifyScannedCode(raw: string): ScannedCode {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { kind: 'unknown' };
  }
  if (url.protocol !== 'aiondx:') return { kind: 'unknown' };
  // `aiondx://rekey` parses with host "rekey" on most runtimes; accept the path form too.
  const target = url.host || url.pathname.replace(/^\/+/, '');
  if (target === 'pair') return { kind: 'pairing' };
  if (target !== 'rekey') return { kind: 'unknown' };
  const q = url.searchParams;
  const hostId = q.get('id');
  const deviceId = q.get('d');
  const s = q.get('s');
  const expiresAt = Number(q.get('x'));
  if (q.get('v') !== '1' || !hostId || !deviceId || !s || !Number.isFinite(expiresAt)) return { kind: 'unknown' };
  let rekeySecret: Uint8Array;
  try {
    rekeySecret = fromB64u(s);
  } catch {
    return { kind: 'unknown' };
  }
  if (rekeySecret.length !== 32) return { kind: 'unknown' };
  return { kind: 'rekey', offer: { hostId, deviceId, rekeySecret, expiresAt } };
}
