/**
 * AionDX mobile <-> PC bridge secure channel, protocol v1 (DRAFT — pending
 * agreement with the bridge/backend team; see docs/pairing-encryption-proposal.md).
 *
 * This file is the client (phone) side and the shared wire format. The host side
 * reference implementation lives in protocol.host.ts. Everything here is pure: no
 * storage, no network, so both sides can be unit-tested against each other.
 */
import { concatBytes, fromB64u, fromUtf8, toB64u, u64be, utf8 } from '../encoding';
import { bytesEqual, deriveKey, dh, generateKeyPair, KEY_BYTES, type KeyPair, open, seal, sha256 } from './primitives';

export const PROTOCOL_VERSION = 1;
export const PAIRING_URI_SCHEME = 'aiondx:';
/** Max clock skew accepted for handshake timestamps, both directions. */
export const MAX_CLOCK_SKEW_MS = 2 * 60 * 1000;

const LABEL = {
  pair: 'aiondx/v1/pair',
  pairReq: 'aiondx/v1/pair-req',
  pairRes: 'aiondx/v1/pair-res',
  sas: 'aiondx/v1/sas',
  hsInit: 'aiondx/v1/hs-init',
  session: 'aiondx/v1/session',
  sessionKeys: 'aiondx/v1/session-keys',
  rpcReq: 'aiondx/v1/rpc-req',
  rpcRes: 'aiondx/v1/rpc-res',
  revoked: 'aiondx/v1/revoked',
} as const;

export class ProtocolError extends Error {
  constructor(
    readonly code:
      | 'bad_pairing_uri'
      | 'pairing_expired'
      | 'unsupported_version'
      | 'auth_failed'
      | 'clock_skew'
      | 'malformed',
    message: string,
  ) {
    super(message);
    this.name = 'ProtocolError';
  }
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** The phone's long-term identity. `deviceId` is random and not derived from the key. */
export interface DeviceIdentity extends KeyPair {
  deviceId: string;
}

/** A sealed payload as it appears on the wire (all binary fields base64url). */
export interface SealedBox {
  nonce: string;
  ct: string;
}

/** Contents of the QR code the PC displays: `aiondx://pair?...`. */
export interface PairingOffer {
  v: number;
  hostId: string;
  hostName: string;
  hostPublicKey: Uint8Array;
  /** One-time, short-lived secret. Proves the phone saw the QR code. */
  pairingSecret: Uint8Array;
  /** Candidate base URLs for the bridge, e.g. LAN addresses. Tried in order. */
  urls: string[];
  /** Unix ms. */
  expiresAt: number;
}

export interface PairRequestBody extends SealedBox {
  v: number;
  hostId: string;
  deviceId: string;
  devicePk: string;
}

/**
 * How this phone protects the bridge-issued confirm key (contract §5.2):
 * `biometric` = secure store with requireAuthentication; `device_passcode` = secure store
 * plus an app-enforced passcode prompt; `none` = no device security, so no key is issued.
 */
export type ConfirmMode = 'biometric' | 'device_passcode' | 'none';

export interface PairRequestPayload {
  deviceName: string;
  platform: string;
  appVersion: string;
  ts: number;
  confirmMode: ConfirmMode;
  /** Long-poll (contract §4.2): false on the first request, true afterwards (host holds up to 20 s). */
  wait: boolean;
}

/** `aborted`: another device used this pairing code, so the offer was burned (A2). */
export type PairStatus = 'pending' | 'approved' | 'rejected' | 'aborted';

export interface PairResponsePayload {
  status: PairStatus;
  hostId: string;
  hostName: string;
  ts: number;
  /** Echo of the answered request's `ts`; must match the phone's latest request. */
  reqTs: number;
  /** b64u, 32 bytes. Present only when `approved` (A7). */
  confirmKey?: string;
}

export interface HandshakeInitBody extends SealedBox {
  v: number;
  hostId: string;
  deviceId: string;
  epk: string;
}

export interface HandshakeResponseBody extends SealedBox {
  v: number;
  epk: string;
}

export interface HandshakeResponsePayload {
  /** Unix ms after which the host will reject this session. */
  expiresAt: number;
  /** The host drops the session after this much inactivity (informational; 401 retry covers it). */
  idleTimeoutMs?: number;
}

export interface SessionKeys {
  sessionId: Uint8Array;
  /** Phone -> host. */
  c2s: Uint8Array;
  /** Host -> phone. */
  s2c: Uint8Array;
  expiresAt: number;
  idleTimeoutMs?: number;
}

export interface RpcEnvelope extends SealedBox {
  v: number;
  sid: string;
  seq: number;
}

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** InnerRequest (contract §4.4). */
export interface RpcRequest {
  method: HttpMethod;
  /** Facade path, including any query string, e.g. /v1/teams/abc/run-state */
  path: string;
  body?: unknown;
  /** Client id of one logical request, identical across retries; the host de-duplicates writes by it (A4). */
  rid: string;
  /** b64u HMAC proof for sensitive actions (§5). Bound to this envelope's sid and seq. */
  confirm?: string;
}

export interface RpcResponse {
  status: number;
  body?: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function sealJson(key: Uint8Array, value: unknown, aad: Uint8Array): SealedBox {
  const { nonce, ciphertext } = seal(key, utf8(JSON.stringify(value)), aad);
  return { nonce: toB64u(nonce), ct: toB64u(ciphertext) };
}

export function openJson<T>(key: Uint8Array, box: SealedBox, aad: Uint8Array): T {
  let plaintext: Uint8Array;
  try {
    plaintext = open(key, fromB64u(box.nonce), fromB64u(box.ct), aad);
  } catch {
    throw new ProtocolError('auth_failed', 'Decryption failed');
  }
  return JSON.parse(fromUtf8(plaintext)) as T;
}

export function decodeKey(b64u: string): Uint8Array {
  const key = fromB64u(b64u);
  if (key.length !== KEY_BYTES) throw new ProtocolError('malformed', 'Bad key length');
  return key;
}

export function assertVersion(v: unknown): void {
  if (v !== PROTOCOL_VERSION) throw new ProtocolError('unsupported_version', `Unsupported protocol version ${String(v)}`);
}

export function assertFresh(ts: number, now: number): void {
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_CLOCK_SKEW_MS) {
    throw new ProtocolError('clock_skew', 'Timestamp outside allowed window');
  }
}

// ---------------------------------------------------------------------------
// Pairing (one-time, via QR code)
// ---------------------------------------------------------------------------

/**
 * aiondx://pair?v=1&id=<hostId>&n=<hostName>&pk=<b64u>&s=<b64u>&x=<expiry ms>&u=<url>[&u=<url>...]
 */
export function parsePairingUri(raw: string, now = Date.now()): PairingOffer {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ProtocolError('bad_pairing_uri', 'Not a URL');
  }
  // `aiondx://pair` parses with host "pair" on most runtimes; accept the path form too.
  const target = url.host || url.pathname.replace(/^\/+/, '');
  if (url.protocol !== PAIRING_URI_SCHEME || target !== 'pair') {
    throw new ProtocolError('bad_pairing_uri', 'Not an AionDX pairing code');
  }
  const q = url.searchParams;
  const v = Number(q.get('v'));
  assertVersion(v);
  const hostId = q.get('id');
  const pk = q.get('pk');
  const s = q.get('s');
  const expiresAt = Number(q.get('x'));
  // IPv6 ULA URLs are fine (`http://[fd12::1]:47734`); link-local ones are dropped (contract §7, rev 4.4).
  const urls = q.getAll('u').filter((u) => /^https?:\/\//i.test(u) && !/^https?:\/\/\[fe[89ab][0-9a-f]?:/i.test(u));
  if (!hostId || !pk || !s || !Number.isFinite(expiresAt) || urls.length === 0) {
    throw new ProtocolError('bad_pairing_uri', 'Pairing code is missing fields');
  }
  if (expiresAt <= now) throw new ProtocolError('pairing_expired', 'Pairing code has expired');
  const pairingSecret = fromB64u(s);
  if (pairingSecret.length < 16) throw new ProtocolError('bad_pairing_uri', 'Pairing secret too short');
  return {
    v,
    hostId,
    hostName: q.get('n') ?? 'AionDX',
    hostPublicKey: decodeKey(pk),
    pairingSecret,
    urls,
    expiresAt,
  };
}

export function encodePairingUri(offer: PairingOffer): string {
  const q = new URLSearchParams({
    v: String(offer.v),
    id: offer.hostId,
    n: offer.hostName,
    pk: toB64u(offer.hostPublicKey),
    s: toB64u(offer.pairingSecret),
    x: String(offer.expiresAt),
  });
  for (const u of offer.urls) q.append('u', u);
  return `aiondx://pair?${q.toString()}`;
}

/** k_pair = HKDF(DH(S_dev, S_host), salt = pairingSecret, info = label || S_host || S_dev). */
export function derivePairingKey(
  ownSecretKey: Uint8Array,
  peerPublicKey: Uint8Array,
  pairingSecret: Uint8Array,
  hostPublicKey: Uint8Array,
  devicePublicKey: Uint8Array,
): Uint8Array {
  return deriveKey(
    dh(ownSecretKey, peerPublicKey),
    pairingSecret,
    concatBytes(utf8(LABEL.pair), hostPublicKey, devicePublicKey),
  );
}

export function pairRequestAad(hostId: string, deviceId: string): Uint8Array {
  return utf8(`${LABEL.pairReq}|${hostId}|${deviceId}`);
}

export function pairResponseAad(hostId: string, deviceId: string): Uint8Array {
  return utf8(`${LABEL.pairRes}|${hostId}|${deviceId}`);
}

/**
 * 6-digit short authentication string shown on both phone and PC. The user
 * confirms they match before the PC approves the device. Guards against a
 * photographed/relayed QR code being used by someone else.
 */
export function shortAuthString(pairingKey: Uint8Array): string {
  const bytes = deriveKey(pairingKey, new Uint8Array(0), utf8(LABEL.sas), 4);
  const n = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0) % 1_000_000;
  const digits = n.toString().padStart(6, '0');
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

export function buildPairRequest(
  identity: DeviceIdentity,
  offer: PairingOffer,
  payload: PairRequestPayload,
): { body: PairRequestBody; pairingKey: Uint8Array; sas: string } {
  const pairingKey = derivePairingKey(
    identity.secretKey,
    offer.hostPublicKey,
    offer.pairingSecret,
    offer.hostPublicKey,
    identity.publicKey,
  );
  const box = sealJson(pairingKey, payload, pairRequestAad(offer.hostId, identity.deviceId));
  return {
    body: {
      v: PROTOCOL_VERSION,
      hostId: offer.hostId,
      deviceId: identity.deviceId,
      devicePk: toB64u(identity.publicKey),
      ...box,
    },
    pairingKey,
    sas: shortAuthString(pairingKey),
  };
}

/** `expectedReqTs`: the `ts` of the request this response answers (contract §4.2). */
export function openPairResponse(
  pairingKey: Uint8Array,
  hostId: string,
  deviceId: string,
  box: SealedBox,
  expectedReqTs?: number,
): PairResponsePayload {
  const res = openJson<PairResponsePayload>(pairingKey, box, pairResponseAad(hostId, deviceId));
  if (res.hostId !== hostId) throw new ProtocolError('auth_failed', 'Host id mismatch');
  if (expectedReqTs !== undefined && res.reqTs !== expectedReqTs) {
    throw new ProtocolError('malformed', 'Pairing response answers a different request');
  }
  return res;
}

// ---------------------------------------------------------------------------
// Session handshake (every app launch / on expiry). Mutually authenticated by
// both static keys, forward secret via ephemerals. Shape follows Noise KK.
// ---------------------------------------------------------------------------

export function handshakeInitKey(
  dhEphStatic: Uint8Array,
  dhStaticStatic: Uint8Array,
  deviceId: string,
  devicePk: Uint8Array,
  hostPk: Uint8Array,
  clientEpk: Uint8Array,
): Uint8Array {
  const salt = sha256(concatBytes(utf8(`${LABEL.hsInit}|${deviceId}|`), devicePk, hostPk, clientEpk));
  return deriveKey(concatBytes(dhEphStatic, dhStaticStatic), salt, utf8(LABEL.hsInit));
}

export function handshakeInitAad(hostId: string, deviceId: string, clientEpk: Uint8Array): Uint8Array {
  return concatBytes(utf8(`${LABEL.hsInit}|${hostId}|${deviceId}|`), clientEpk);
}

export function sessionTranscript(
  deviceId: string,
  devicePk: Uint8Array,
  hostPk: Uint8Array,
  clientEpk: Uint8Array,
  hostEpk: Uint8Array,
): Uint8Array {
  return sha256(concatBytes(utf8(`${LABEL.session}|${deviceId}|`), devicePk, hostPk, clientEpk, hostEpk));
}

/**
 * ikm = DH(e_c, S_h) || DH(S_c, S_h) || DH(e_c, e_h) || DH(S_c, e_h)
 * okm = HKDF(ikm, salt = transcript, info = label) -> c2s(32) || s2c(32) || sid(16)
 */
export function deriveSessionKeys(dhs: [Uint8Array, Uint8Array, Uint8Array, Uint8Array], transcript: Uint8Array, expiresAt: number): SessionKeys {
  const okm = deriveKey(concatBytes(...dhs), transcript, utf8(LABEL.sessionKeys), 80);
  return { c2s: okm.slice(0, 32), s2c: okm.slice(32, 64), sessionId: okm.slice(64, 80), expiresAt };
}

export interface HandshakeState {
  ephemeral: KeyPair;
  hostId: string;
  hostPublicKey: Uint8Array;
}

export function beginHandshake(
  identity: DeviceIdentity,
  host: { hostId: string; hostPublicKey: Uint8Array },
  now = Date.now(),
): { body: HandshakeInitBody; state: HandshakeState } {
  const ephemeral = generateKeyPair();
  const key = handshakeInitKey(
    dh(ephemeral.secretKey, host.hostPublicKey),
    dh(identity.secretKey, host.hostPublicKey),
    identity.deviceId,
    identity.publicKey,
    host.hostPublicKey,
    ephemeral.publicKey,
  );
  const box = sealJson(key, { ts: now }, handshakeInitAad(host.hostId, identity.deviceId, ephemeral.publicKey));
  return {
    body: {
      v: PROTOCOL_VERSION,
      hostId: host.hostId,
      deviceId: identity.deviceId,
      epk: toB64u(ephemeral.publicKey),
      ...box,
    },
    state: { ephemeral, hostId: host.hostId, hostPublicKey: host.hostPublicKey },
  };
}

/** Completes the handshake. Successful decryption authenticates the host. */
export function finishHandshake(
  identity: DeviceIdentity,
  state: HandshakeState,
  response: HandshakeResponseBody,
): SessionKeys {
  assertVersion(response.v);
  const hostEpk = decodeKey(response.epk);
  const { ephemeral, hostPublicKey } = state;
  const transcript = sessionTranscript(identity.deviceId, identity.publicKey, hostPublicKey, ephemeral.publicKey, hostEpk);
  const provisional = deriveSessionKeys(
    [
      dh(ephemeral.secretKey, hostPublicKey),
      dh(identity.secretKey, hostPublicKey),
      dh(ephemeral.secretKey, hostEpk),
      dh(identity.secretKey, hostEpk),
    ],
    transcript,
    0,
  );
  const payload = openJson<HandshakeResponsePayload>(provisional.s2c, response, transcript);
  return { ...provisional, expiresAt: payload.expiresAt, idleTimeoutMs: payload.idleTimeoutMs };
}

// ---------------------------------------------------------------------------
// Authenticated revocation notice (contract A1). Returned by /session for any
// deviceId the host doesn't trust. Only S_h's holder can seal it, and the fresh
// e_c prevents replay, so a verified notice means deleting the pairing is safe.
// A plaintext 403 without a valid notice must NOT delete anything.
// ---------------------------------------------------------------------------

export interface RevocationNoticePayload {
  deviceId: string;
  ts: number;
  /** Only changes the wording shown; both mean this PC won't accept this device key. */
  reason: 'revoked' | 'unknown';
}

/** `"aiondx/v1/revoked|hostId|deviceId|" ‖ e_c` — the AAD, and (hashed) the HKDF salt. */
export function revocationContext(hostId: string, deviceId: string, clientEpk: Uint8Array): Uint8Array {
  return concatBytes(utf8(`${LABEL.revoked}|${hostId}|${deviceId}|`), clientEpk);
}

/** k_rev = HKDF(DH(S_h, e_c), salt = SHA256(context), info = "aiondx/v1/revoked"). */
export function revocationKey(dhHostClientEph: Uint8Array, hostId: string, deviceId: string, clientEpk: Uint8Array): Uint8Array {
  return deriveKey(dhHostClientEph, sha256(revocationContext(hostId, deviceId, clientEpk)), utf8(LABEL.revoked));
}

/** Throws ProtocolError unless the notice is authentic, for this device, and fresh. */
export function openRevocationNotice(
  identity: DeviceIdentity,
  state: HandshakeState,
  notice: SealedBox,
  now = Date.now(),
): RevocationNoticePayload {
  const { ephemeral, hostId, hostPublicKey } = state;
  const key = revocationKey(dh(ephemeral.secretKey, hostPublicKey), hostId, identity.deviceId, ephemeral.publicKey);
  const payload = openJson<RevocationNoticePayload>(key, notice, revocationContext(hostId, identity.deviceId, ephemeral.publicKey));
  if (payload.deviceId !== identity.deviceId) throw new ProtocolError('auth_failed', 'Notice is for another device');
  assertFresh(payload.ts, now);
  return payload;
}

// ---------------------------------------------------------------------------
// RPC envelopes. All API traffic is tunneled through POST /api/mobile/v1/rpc so
// LAN observers see neither paths nor bodies.
// ---------------------------------------------------------------------------

export function rpcAad(direction: 'req' | 'res', sessionId: Uint8Array, seq: number): Uint8Array {
  return concatBytes(utf8(direction === 'req' ? LABEL.rpcReq : LABEL.rpcRes), sessionId, u64be(seq));
}

export function sealRpcRequest(session: SessionKeys, seq: number, request: RpcRequest): RpcEnvelope {
  return {
    v: PROTOCOL_VERSION,
    sid: toB64u(session.sessionId),
    seq,
    ...sealJson(session.c2s, request, rpcAad('req', session.sessionId, seq)),
  };
}

/** The response must be bound to the same session and sequence number as the request. */
export function openRpcResponse(session: SessionKeys, seq: number, envelope: RpcEnvelope): RpcResponse {
  assertVersion(envelope.v);
  if (envelope.seq !== seq || !bytesEqual(fromB64u(envelope.sid), session.sessionId)) {
    throw new ProtocolError('auth_failed', 'Response does not match request');
  }
  return openJson<RpcResponse>(session.s2c, envelope, rpcAad('res', session.sessionId, seq));
}
