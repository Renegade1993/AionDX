/**
 * Host (PC bridge) side of protocol v1 — REFERENCE IMPLEMENTATION ONLY.
 *
 * Not used by the app at runtime. It exists so the client can be tested end to
 * end and so the bridge team has an executable spec to port or replace. The
 * bridge owns the real implementation (key storage, approval UI, replay windows).
 */
import { fromB64u, toB64u } from '../encoding';
import { confirmProof } from './confirm';
import { bytesEqual, dh, generateKeyPair, type KeyPair } from './primitives';
import {
  assertFresh,
  assertVersion,
  decodeKey,
  derivePairingKey,
  deriveSessionKeys,
  handshakeInitAad,
  handshakeInitKey,
  type HandshakeInitBody,
  type HandshakeResponseBody,
  openJson,
  type PairRequestBody,
  type PairRequestPayload,
  pairRequestAad,
  pairResponseAad,
  type PairResponsePayload,
  PROTOCOL_VERSION,
  ProtocolError,
  revocationContext,
  revocationKey,
  type RevocationNoticePayload,
  type RpcEnvelope,
  type RpcRequest,
  type RpcResponse,
  rpcAad,
  sealJson,
  type SealedBox,
  type SessionKeys,
  sessionTranscript,
  shortAuthString,
} from './protocol';

export function hostOpenPairRequest(
  hostStatic: KeyPair,
  hostId: string,
  pairingSecret: Uint8Array,
  body: PairRequestBody,
  now = Date.now(),
): { payload: PairRequestPayload; devicePublicKey: Uint8Array; pairingKey: Uint8Array; sas: string } {
  assertVersion(body.v);
  if (body.hostId !== hostId) throw new ProtocolError('auth_failed', 'Wrong host');
  const devicePublicKey = decodeKey(body.devicePk);
  const pairingKey = derivePairingKey(hostStatic.secretKey, devicePublicKey, pairingSecret, hostStatic.publicKey, devicePublicKey);
  const payload = openJson<PairRequestPayload>(pairingKey, body, pairRequestAad(hostId, body.deviceId));
  assertFresh(payload.ts, now);
  return { payload, devicePublicKey, pairingKey, sas: shortAuthString(pairingKey) };
}

export function hostSealPairResponse(
  pairingKey: Uint8Array,
  hostId: string,
  deviceId: string,
  response: PairResponsePayload,
): SealedBox {
  return sealJson(pairingKey, response, pairResponseAad(hostId, deviceId));
}

/** `lookupDevice` returns the paired device's static public key, or null if unknown/revoked. */
export function hostRespondHandshake(
  hostStatic: KeyPair,
  hostId: string,
  init: HandshakeInitBody,
  lookupDevice: (deviceId: string) => Uint8Array | null,
  sessionTtlMs: number,
  now = Date.now(),
  idleTimeoutMs = 30 * 60 * 1000,
): { response: HandshakeResponseBody; session: SessionKeys } {
  assertVersion(init.v);
  if (init.hostId !== hostId) throw new ProtocolError('auth_failed', 'Wrong host');
  const devicePk = lookupDevice(init.deviceId);
  if (!devicePk) throw new ProtocolError('auth_failed', 'Unknown device');
  const clientEpk = decodeKey(init.epk);

  const initKey = handshakeInitKey(
    dh(hostStatic.secretKey, clientEpk),
    dh(hostStatic.secretKey, devicePk),
    init.deviceId,
    devicePk,
    hostStatic.publicKey,
    clientEpk,
  );
  const { ts } = openJson<{ ts: number }>(initKey, init, handshakeInitAad(hostId, init.deviceId, clientEpk));
  assertFresh(ts, now);

  const ephemeral = generateKeyPair();
  const transcript = sessionTranscript(init.deviceId, devicePk, hostStatic.publicKey, clientEpk, ephemeral.publicKey);
  const session = deriveSessionKeys(
    [
      dh(hostStatic.secretKey, clientEpk),
      dh(hostStatic.secretKey, devicePk),
      dh(ephemeral.secretKey, clientEpk),
      dh(ephemeral.secretKey, devicePk),
    ],
    transcript,
    now + sessionTtlMs,
  );
  session.idleTimeoutMs = idleTimeoutMs;
  const box = sealJson(session.s2c, { expiresAt: session.expiresAt, idleTimeoutMs }, transcript);
  return { response: { v: PROTOCOL_VERSION, epk: toB64u(ephemeral.publicKey), ...box }, session };
}

/**
 * A1 authenticated revocation notice, for a /session init from a deviceId this host
 * doesn't trust (revoked, or never known). Needs only S_h and the init's e_c, so the
 * host can seal it after deleting the device's key. The phone verifies it with
 * openRevocationNotice() and only then deletes its pairing.
 */
export function hostSealRevocationNotice(
  hostStatic: KeyPair,
  hostId: string,
  init: HandshakeInitBody,
  reason: RevocationNoticePayload['reason'],
  now = Date.now(),
): SealedBox {
  const clientEpk = decodeKey(init.epk);
  const key = revocationKey(dh(hostStatic.secretKey, clientEpk), hostId, init.deviceId, clientEpk);
  const payload: RevocationNoticePayload = { deviceId: init.deviceId, ts: now, reason };
  return sealJson(key, payload, revocationContext(hostId, init.deviceId, clientEpk));
}

/**
 * Sliding-window replay protection (like IPsec/DTLS). Polling requests run
 * concurrently and may arrive out of order, so a strict "seq > last" check is
 * too strict.
 */
export class ReplayWindow {
  private highest = -1;
  private seen = new Set<number>();

  constructor(private readonly size = 256) {}

  accept(seq: number): boolean {
    if (!Number.isSafeInteger(seq) || seq < 0) return false;
    if (seq <= this.highest - this.size || this.seen.has(seq)) return false;
    this.seen.add(seq);
    if (seq > this.highest) {
      this.highest = seq;
      for (const s of this.seen) if (s <= this.highest - this.size) this.seen.delete(s);
    }
    return true;
  }
}

export function hostOpenRpcRequest(session: SessionKeys, window: ReplayWindow, envelope: RpcEnvelope): RpcRequest {
  assertVersion(envelope.v);
  const request = openJson<RpcRequest>(session.c2s, envelope, rpcAad('req', fromB64u(envelope.sid), envelope.seq));
  // Only consume the sequence number once the request has authenticated.
  if (!window.accept(envelope.seq)) throw new ProtocolError('auth_failed', 'Replayed request');
  return request;
}

/**
 * §5 bridge check for a sensitive request: 'missing' → 428 confirm_required, 'invalid' → 403
 * confirm_invalid. The proof binds this envelope's sid and seq, so it is checked per envelope.
 */
export function hostCheckConfirm(
  confirmKey: Uint8Array,
  session: SessionKeys,
  seq: number,
  request: RpcRequest,
): 'ok' | 'missing' | 'invalid' {
  if (!request.confirm) return 'missing';
  const expected = confirmProof(confirmKey, { sessionId: session.sessionId, seq, method: request.method, path: request.path, body: request.body, rid: request.rid });
  let given: Uint8Array;
  try {
    given = fromB64u(request.confirm);
  } catch {
    return 'invalid';
  }
  return bytesEqual(given, fromB64u(expected)) ? 'ok' : 'invalid';
}

export function hostSealRpcResponse(session: SessionKeys, seq: number, response: RpcResponse): RpcEnvelope {
  return {
    v: PROTOCOL_VERSION,
    sid: toB64u(session.sessionId),
    seq,
    ...sealJson(session.s2c, response, rpcAad('res', session.sessionId, seq)),
  };
}
