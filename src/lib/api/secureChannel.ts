import {
  beginHandshake,
  type DeviceIdentity,
  finishHandshake,
  type HandshakeResponseBody,
  type HandshakeState,
  openRevocationNotice,
  openRpcResponse,
  type RevocationNoticePayload,
  type RpcEnvelope,
  type RpcRequest,
  type RpcResponse,
  type SealedBox,
  sealRpcRequest,
  type SessionKeys,
} from '../crypto/protocol';
import { confirmProof } from '../crypto/confirm';
import { randomUuid } from '../crypto/primitives';
import { fromB64u } from '../encoding';
import type { PairedHost } from '../storage/keyStore';
import { bridgeErrorCode, ENDPOINTS } from './endpoints';
import { apiErrorFrom } from './errors';
import { postJson, TransportError } from './http';

/** Refresh the session a little before the host-declared expiry or idle timeout. */
const EXPIRY_MARGIN_MS = 60 * 1000;
/** /v1/changes long-polls for up to 25 s on the host; the HTTP timeout must exceed it (contract §4.4). */
const LONG_POLL_TIMEOUT_MS = 35 * 1000;

/**
 * The PC sent an *authenticated* revocation notice (A1): it will not accept this device
 * key again, so deleting the pairing is safe. Only thrown after the notice verified.
 */
export class DeviceRevokedError extends Error {
  constructor(
    readonly hostId: string,
    readonly reason: RevocationNoticePayload['reason'],
  ) {
    super(reason === 'unknown' ? 'This PC no longer knows this phone.' : 'This phone was removed on the PC.');
    this.name = 'DeviceRevokedError';
  }
}

/** A 403 we couldn't authenticate. Anyone on the network can send one, so the pairing is kept. */
export class HostRefusedError extends Error {
  constructor(readonly hostId: string) {
    super('The PC refused the connection.');
    this.name = 'HostRefusedError';
  }
}

/**
 * 403 forbidden_peer: the PC only accepts phones on a private network (its LAN or your VPN). Not a
 * trust problem: the pairing is fine, the route isn't (contract rev 4.3 §4.4a).
 */
export class ForbiddenPeerError extends TransportError {
  constructor() {
    super('Your PC only accepts phones on its local network or your VPN.');
    this.name = 'ForbiddenPeerError';
  }
}

/** 409 unknown_host: the PC's host key was reset (new hostId). Plaintext, so the pairing is kept. */
export class HostResetError extends Error {
  constructor(readonly hostId: string) {
    super('This PC was reset. Pair again.');
    this.name = 'HostResetError';
  }
}

export class ClockSkewError extends Error {
  constructor(readonly hostTime: number | undefined) {
    super(
      hostTime
        ? `Your phone's clock is off by about ${Math.round(Math.abs(Date.now() - hostTime) / 60_000)} min. Fix the time and try again.`
        : "Your phone's clock doesn't match the PC. Fix the time and try again.",
    );
    this.name = 'ClockSkewError';
  }
}

export interface RequestOptions {
  /** Defaults to 35 s for /v1/changes long-polls, else the transport default. */
  timeoutMs?: number;
  /** Reuse an id across user-initiated retries (e.g. a chat message's local id) so the host de-duplicates. */
  rid?: string;
  /**
   * Unlocked confirm key for a sensitive action (§5). The proof binds the sid and seq of the
   * envelope it travels in, so it is computed at seal time, and again if the 401 retry re-seals.
   */
  confirmKey?: Uint8Array;
}

function hostTimeOf(json: unknown): number | undefined {
  const t = json && typeof json === 'object' && 'hostTime' in json ? (json as { hostTime: unknown }).hostTime : undefined;
  return typeof t === 'number' ? t : undefined;
}

/**
 * Encrypted request channel to one paired PC. Lazily performs the session
 * handshake, re-handshakes on expiry, idle timeout, or when the bridge reports an
 * unknown session (e.g. after the PC restarted), and tunnels every API call
 * through the single RPC endpoint.
 */
export class SecureChannel {
  private session: SessionKeys | null = null;
  private pendingSession: Promise<SessionKeys> | null = null;
  private seq = 0;
  private lastActivityAt = 0;
  /** Last base URL that answered; tried first next time. */
  private preferredUrl: string | null = null;

  private readonly hostPublicKey: Uint8Array;

  constructor(
    private readonly identity: DeviceIdentity,
    readonly host: PairedHost,
  ) {
    this.hostPublicKey = fromB64u(host.hostPublicKey);
  }

  async request<T = unknown>(request: Omit<RpcRequest, 'rid' | 'confirm'>, opts: RequestOptions = {}): Promise<T> {
    // One rid per logical request: the 401 re-handshake retry re-seals this same object (A4).
    const full: RpcRequest = { ...request, rid: opts.rid ?? randomUuid() };
    const timeoutMs = opts.timeoutMs ?? (request.path.startsWith('/v1/changes') ? LONG_POLL_TIMEOUT_MS : undefined);
    const res = await this.send(full, timeoutMs, true, opts.confirmKey);
    if (res.status < 200 || res.status >= 300) throw apiErrorFrom(res.status, res.body);
    return res.body as T;
  }

  /** Raw session id of the live session (handshaking first if needed); the re-key proof binds it (§5.3). */
  async sessionId(): Promise<Uint8Array> {
    return (await this.ensureSession()).sessionId;
  }

  /** Drops session keys, e.g. when the app is backgrounded for a long time. */
  reset(): void {
    this.session = null;
    this.pendingSession = null;
  }

  private async send(request: RpcRequest, timeoutMs: number | undefined, allowRetry: boolean, confirmKey?: Uint8Array): Promise<RpcResponse> {
    const session = await this.ensureSession();
    const seq = ++this.seq;
    const sealed: RpcRequest = confirmKey
      ? { ...request, confirm: confirmProof(confirmKey, { sessionId: session.sessionId, seq, ...request }) }
      : request;
    const envelope = sealRpcRequest(session, seq, sealed);
    const res = await postJson(this.urls(), ENDPOINTS.rpc, envelope, { timeoutMs });
    this.preferredUrl = res.baseUrl;
    this.lastActivityAt = Date.now();

    if (res.status === 200) return openRpcResponse(session, seq, res.json as RpcEnvelope);

    const code = bridgeErrorCode(res.json);
    // 401 unknown_session / session_expired / auth_failed: the session is gone or its keys don't
    // match (the PC restarted). Re-handshake and retry once.
    if ((code === 'unknown_session' || code === 'session_expired' || code === 'auth_failed') && allowRetry) {
      if (this.session === session) this.reset();
      // Same rid; the proof (if any) is recomputed for the new sid and seq.
      return this.send(request, timeoutMs, false, confirmKey);
    }
    // 400 replayed: this seq was already used; re-seal with a fresh one (same rid, so no double write).
    if (code === 'replayed' && allowRetry) return this.send(request, timeoutMs, false, confirmKey);
    if (code === 'forbidden_peer') throw new ForbiddenPeerError();
    // rpc never carries an authenticated revocation (contract §4.4); a 403 here can't be trusted.
    if (res.status === 403) throw new HostRefusedError(this.host.hostId);
    throw new TransportError(`Secure channel error (${res.status}${code ? `: ${code}` : ''})`);
  }

  private ensureSession(): Promise<SessionKeys> {
    const now = Date.now();
    const s = this.session;
    const idleExpired = !!s?.idleTimeoutMs && now - this.lastActivityAt > s.idleTimeoutMs - EXPIRY_MARGIN_MS;
    if (s && s.expiresAt - EXPIRY_MARGIN_MS > now && !idleExpired) return Promise.resolve(s);
    // Coalesce concurrent callers (several polling queries fire at once) onto one handshake.
    this.pendingSession ??= this.handshake().finally(() => {
      this.pendingSession = null;
    });
    return this.pendingSession;
  }

  private async handshake(): Promise<SessionKeys> {
    const { body, state } = beginHandshake(this.identity, {
      hostId: this.host.hostId,
      hostPublicKey: this.hostPublicKey,
    });
    const res = await postJson(this.urls(), ENDPOINTS.session, body);
    this.preferredUrl = res.baseUrl;
    if (res.status !== 200) throw this.handshakeError(res.status, res.json, state);
    const session = finishHandshake(this.identity, state, res.json as HandshakeResponseBody);
    this.session = session;
    this.seq = 0;
    this.lastActivityAt = Date.now();
    return session;
  }

  private handshakeError(status: number, json: unknown, state: HandshakeState): Error {
    const code = bridgeErrorCode(json);
    if (code === 'forbidden_peer') return new ForbiddenPeerError();
    if (status === 403) {
      const notice = json && typeof json === 'object' && 'notice' in json ? (json as { notice: SealedBox }).notice : undefined;
      if (code === 'device_revoked' && notice) {
        try {
          const verified = openRevocationNotice(this.identity, state, notice);
          return new DeviceRevokedError(this.host.hostId, verified.reason);
        } catch {
          // Forged, stale or for another device: fall through to the unauthenticated case.
        }
      }
      return new HostRefusedError(this.host.hostId);
    }
    if (status === 409 && code === 'unknown_host') return new HostResetError(this.host.hostId);
    if (code === 'clock_skew') return new ClockSkewError(hostTimeOf(json));
    return new TransportError(`Handshake failed (${status}${code ? `: ${code}` : ''})`);
  }

  private urls(): string[] {
    const { urls } = this.host;
    return this.preferredUrl ? [this.preferredUrl, ...urls.filter((u) => u !== this.preferredUrl)] : urls;
  }
}
