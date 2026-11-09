/**
 * SecureChannel and the pairing loop against a fake bridge built from the host reference
 * (protocol.host.ts), with `fetch` stubbed. Covers the rev-2 transport rules: rid reuse on
 * the 401 retry, per-request timeouts, the A1 revocation notice, 409 unknown_host, and the
 * pairing long-poll.
 */
import { toB64u } from '../../encoding';
import { generateKeyPair, randomBytes } from '../../crypto/primitives';
import {
  type HandshakeInitBody,
  type PairingOffer,
  type PairRequestBody,
  type RpcEnvelope,
  type RpcRequest,
} from '../../crypto/protocol';
import {
  hostCheckConfirm,
  hostOpenPairRequest,
  hostOpenRpcRequest,
  hostRespondHandshake,
  hostSealPairResponse,
  hostSealRevocationNotice,
  hostSealRpcResponse,
  ReplayWindow,
} from '../../crypto/protocol.host';
import * as keyStore from '../../storage/keyStore';
import { createDeviceIdentity, type PairedHost } from '../../storage/keyStore';
import { ConfirmKeyInvalidatedError, ConfirmUnavailableError } from '../errors';
import * as http from '../http';
import { PairingLockedError, pairWithHost } from '../pairing';
import { DeviceRevokedError, ForbiddenPeerError, HostRefusedError, HostResetError, SecureChannel } from '../secureChannel';
import { createSecureTransport } from '../transport';

type Reply = { status: number; json: unknown };
type Handler = (path: string, body: unknown) => Reply | Promise<Reply>;

function stubFetch(handler: Handler) {
  globalThis.fetch = jest.fn(async (url: string | URL, init?: RequestInit) => {
    const reply = await handler(new URL(String(url)).pathname, JSON.parse(String(init?.body)));
    return { status: reply.status, json: async () => reply.json } as Response;
  }) as typeof fetch;
}

function setup() {
  const hostKeys = generateKeyPair();
  const hostId = 'host-1';
  const identity = createDeviceIdentity();
  const host: PairedHost = {
    hostId,
    hostName: 'PC',
    hostPublicKey: toB64u(hostKeys.publicKey),
    urls: ['http://192.168.1.2:47734'],
    pairedAt: 0,
  };
  return { hostKeys, hostId, identity, host };
}

/** A minimal bridge: handshake + rpc, with knobs for the failure modes under test. */
function fakeBridge(s: ReturnType<typeof setup>, knobs: { trusted?: boolean; expireFirstRpc?: boolean } = {}) {
  const sessions = new Map<string, { keys: ReturnType<typeof hostRespondHandshake>['session']; window: ReplayWindow }>();
  const seen: RpcRequest[] = [];
  let rpcCount = 0;
  const handler: Handler = (path, body) => {
    if (path.endsWith('/session')) {
      const init = body as HandshakeInitBody;
      if (knobs.trusted === false) {
        return { status: 403, json: { error: 'device_revoked', notice: hostSealRevocationNotice(s.hostKeys, s.hostId, init, 'revoked') } };
      }
      const { response, session } = hostRespondHandshake(s.hostKeys, s.hostId, init, () => s.identity.publicKey, 3_600_000);
      sessions.set(toB64u(session.sessionId), { keys: session, window: new ReplayWindow() });
      return { status: 200, json: response };
    }
    const env = body as RpcEnvelope;
    const sess = sessions.get(env.sid);
    if (!sess) return { status: 401, json: { error: 'unknown_session' } };
    const req = hostOpenRpcRequest(sess.keys, sess.window, env);
    seen.push(req);
    if (knobs.expireFirstRpc && rpcCount++ === 0) {
      sessions.delete(env.sid); // the PC restarted mid-request
      return { status: 401, json: { error: 'session_expired' } };
    }
    return { status: 200, json: hostSealRpcResponse(sess.keys, env.seq, { status: 200, body: { ok: req.path } }) };
  };
  return { handler, seen };
}

describe('SecureChannel (rev 2 transport)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('tags every request with a rid and reuses it on the 401 re-handshake retry (A4)', async () => {
    const s = setup();
    const bridge = fakeBridge(s, { expireFirstRpc: true });
    stubFetch(bridge.handler);
    const channel = new SecureChannel(s.identity, s.host);

    await expect(channel.request({ method: 'POST', path: '/v1/x', body: { a: 1 } })).resolves.toEqual({ ok: '/v1/x' });
    expect(bridge.seen).toHaveLength(2);
    expect(bridge.seen[0].rid).toMatch(/^[0-9a-f-]{36}$/);
    expect(bridge.seen[1].rid).toBe(bridge.seen[0].rid);

    await channel.request({ method: 'GET', path: '/v1/y' });
    expect(bridge.seen[2].rid).not.toBe(bridge.seen[0].rid);
  });

  it('honours a caller rid (e.g. a chat message local id)', async () => {
    const s = setup();
    const bridge = fakeBridge(s);
    stubFetch(bridge.handler);
    await new SecureChannel(s.identity, s.host).request({ method: 'POST', path: '/v1/m' }, { rid: 'local-123' });
    expect(bridge.seen[0].rid).toBe('local-123');
  });

  it('uses a 35 s timeout for /v1/changes long-polls and the default elsewhere', async () => {
    const s = setup();
    stubFetch(fakeBridge(s).handler);
    const spy = jest.spyOn(http, 'postJson');
    const channel = new SecureChannel(s.identity, s.host);
    await channel.request({ method: 'GET', path: '/v1/changes?since=a.1&wait=25' });
    await channel.request({ method: 'GET', path: '/v1/teams' });
    const rpcCalls = spy.mock.calls.filter(([, path]) => path.endsWith('/rpc'));
    expect(rpcCalls[0][3]).toEqual({ timeoutMs: 35_000 });
    expect(rpcCalls[1][3]).toEqual({ timeoutMs: undefined });
  });

  it('a verified revocation notice → DeviceRevokedError (safe to delete the pairing)', async () => {
    const s = setup();
    stubFetch(fakeBridge(s, { trusted: false }).handler);
    const err = await new SecureChannel(s.identity, s.host).request({ method: 'GET', path: '/v1/teams' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceRevokedError);
    expect(err).toMatchObject({ hostId: 'host-1', reason: 'revoked' });
  });

  it('a forged notice or a bare 403 → HostRefusedError (pairing kept)', async () => {
    const s = setup();
    const impostor = generateKeyPair();
    stubFetch((path, body) =>
      path.endsWith('/session')
        ? { status: 403, json: { error: 'device_revoked', notice: hostSealRevocationNotice(impostor, s.hostId, body as HandshakeInitBody, 'revoked') } }
        : { status: 500, json: null },
    );
    await expect(new SecureChannel(s.identity, s.host).request({ method: 'GET', path: '/v1/a' })).rejects.toBeInstanceOf(HostRefusedError);

    stubFetch(() => ({ status: 403, json: { error: 'device_revoked' } }));
    await expect(new SecureChannel(s.identity, s.host).request({ method: 'GET', path: '/v1/a' })).rejects.toBeInstanceOf(HostRefusedError);
  });

  it('409 unknown_host → HostResetError (pairing kept)', async () => {
    const s = setup();
    stubFetch(() => ({ status: 409, json: { error: 'unknown_host', hostId: 'new-id' } }));
    await expect(new SecureChannel(s.identity, s.host).request({ method: 'GET', path: '/v1/a' })).rejects.toBeInstanceOf(HostResetError);
  });
});

describe('pairWithHost (long-poll, contract §4.2)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function offerFor(hostKeys: ReturnType<typeof generateKeyPair>): PairingOffer {
    return {
      v: 1,
      hostId: 'host-1',
      hostName: 'PC',
      hostPublicKey: hostKeys.publicKey,
      pairingSecret: randomBytes(32),
      urls: ['http://192.168.1.2:47734'],
      expiresAt: Date.now() + 5 * 60_000,
    };
  }

  /** Answers each pair request with the next scripted status, echoing its ts. */
  function pairBridge(hostKeys: ReturnType<typeof generateKeyPair>, offer: PairingOffer, script: string[]) {
    const waits: boolean[] = [];
    const confirmKey = randomBytes(32);
    const handler: Handler = (_path, raw) => {
      const body = raw as PairRequestBody;
      const opened = hostOpenPairRequest(hostKeys, offer.hostId, offer.pairingSecret, body);
      waits.push(opened.payload.wait);
      const status = script[waits.length - 1] ?? 'pending';
      if (status === 'locked') return { status: 409, json: { error: 'pairing_locked' } };
      return {
        status: 200,
        json: hostSealPairResponse(opened.pairingKey, offer.hostId, body.deviceId, {
          status: status as 'pending' | 'approved' | 'aborted',
          hostId: offer.hostId,
          hostName: 'PC',
          ts: Date.now(),
          reqTs: opened.payload.ts,
          ...(status === 'approved' ? { confirmKey: toB64u(confirmKey) } : {}),
        }),
      };
    };
    return { handler, waits, confirmKey };
  }

  async function run<T>(p: Promise<T>): Promise<T> {
    const settled = p.then(
      (v) => ({ v }),
      (e: unknown) => ({ e }),
    );
    for (let i = 0; i < 20; i++) await jest.advanceTimersByTimeAsync(7_000);
    const r = (await settled) as { v?: T; e?: unknown };
    if ('e' in r) throw r.e;
    return r.v as T;
  }

  it('first request wait:false, then wait:true; returns the host and confirm key on approval', async () => {
    const hostKeys = generateKeyPair();
    const offer = offerFor(hostKeys);
    const bridge = pairBridge(hostKeys, offer, ['pending', 'pending', 'approved']);
    stubFetch(bridge.handler);
    const result = await run(pairWithHost(createDeviceIdentity(), offer, { confirmMode: 'biometric', deviceName: 'Phone' }));
    expect(bridge.waits).toEqual([false, true, true]);
    expect(result.host).toMatchObject({ hostId: 'host-1', confirmMode: 'biometric' });
    expect(toB64u(result.confirmKey!)).toBe(toB64u(bridge.confirmKey));
  });

  it('uses a ≥25 s HTTP timeout for the held requests', async () => {
    const hostKeys = generateKeyPair();
    const offer = offerFor(hostKeys);
    stubFetch(pairBridge(hostKeys, offer, ['approved']).handler);
    const spy = jest.spyOn(http, 'postJson');
    await run(pairWithHost(createDeviceIdentity(), offer, { confirmMode: 'none' }));
    expect((spy.mock.calls[0][3] as { timeoutMs: number }).timeoutMs).toBeGreaterThanOrEqual(25_000);
  });

  it('aborted (the code was used by another device) → PairingLockedError', async () => {
    const hostKeys = generateKeyPair();
    const offer = offerFor(hostKeys);
    stubFetch(pairBridge(hostKeys, offer, ['pending', 'aborted']).handler);
    await expect(run(pairWithHost(createDeviceIdentity(), offer, { confirmMode: 'none' }))).rejects.toBeInstanceOf(PairingLockedError);
  });

  it('409 pairing_locked → PairingLockedError', async () => {
    const hostKeys = generateKeyPair();
    const offer = offerFor(hostKeys);
    stubFetch(pairBridge(hostKeys, offer, ['locked']).handler);
    await expect(run(pairWithHost(createDeviceIdentity(), offer, { confirmMode: 'none' }))).rejects.toBeInstanceOf(PairingLockedError);
  });
});

describe('sensitive actions on a real pairing (contract §5, SPEC §15.2)', () => {
  const confirmKey = new Uint8Array(32).fill(5);
  afterEach(() => jest.restoreAllMocks());

  /** A bridge with the §5 check: requireConfirm decides whether a proof is needed. */
  function confirmBridge(s: ReturnType<typeof setup>, state: { requireConfirm: boolean }) {
    const sessions = new Map<string, { keys: ReturnType<typeof hostRespondHandshake>['session']; window: ReplayWindow }>();
    const seen: { rid: string; confirmed: boolean }[] = [];
    const handler: Handler = (path, body) => {
      if (path.endsWith('/session')) {
        const { response, session } = hostRespondHandshake(s.hostKeys, s.hostId, body as HandshakeInitBody, () => s.identity.publicKey, 3_600_000);
        sessions.set(toB64u(session.sessionId), { keys: session, window: new ReplayWindow() });
        return { status: 200, json: response };
      }
      const env = body as RpcEnvelope;
      const sess = sessions.get(env.sid)!;
      const req = hostOpenRpcRequest(sess.keys, sess.window, env);
      const check = hostCheckConfirm(confirmKey, sess.keys, env.seq, req);
      seen.push({ rid: req.rid, confirmed: check === 'ok' });
      const inner =
        state.requireConfirm && check === 'missing'
          ? { status: 428, body: { error: { code: 'confirm_required' } } }
          : state.requireConfirm && check === 'invalid'
            ? { status: 403, body: { error: { code: 'confirm_invalid' } } }
            : { status: 200, body: { removed: true } };
      return { status: 200, json: hostSealRpcResponse(sess.keys, env.seq, inner) };
    };
    return { handler, seen };
  }

  const sensitive = { method: 'DELETE' as const, path: '/v1/teams/t/agents/s', confirm: 'Force remove QA' };

  it('with a key: prompts (reads the key), signs, and the PC accepts', async () => {
    const s = setup();
    const read = jest.spyOn(keyStore, 'readConfirmKey').mockResolvedValue(confirmKey);
    const bridge = confirmBridge(s, { requireConfirm: true });
    stubFetch(bridge.handler);
    const t = createSecureTransport(new SecureChannel(s.identity, { ...s.host, confirmMode: 'biometric' }));
    await expect(t.request(sensitive)).resolves.toEqual({ removed: true });
    expect(read).toHaveBeenCalledWith('host-1', 'biometric', 'Force remove QA');
    expect(bridge.seen).toEqual([{ rid: expect.any(String), confirmed: true }]);
  });

  it('PC has requireConfirm off: no prompt; if it was turned back on, one prompt and the same rid', async () => {
    const s = setup();
    const read = jest.spyOn(keyStore, 'readConfirmKey').mockResolvedValue(confirmKey);
    const state = { requireConfirm: false };
    const bridge = confirmBridge(s, state);
    stubFetch(bridge.handler);
    const t = createSecureTransport(new SecureChannel(s.identity, { ...s.host, confirmMode: 'biometric' }));
    t.onHostInfo!({ hostId: 'host-1', hostName: 'PC', serverTime: 0, capabilities: [], device: { deviceId: 'd', name: 'p', pairedAt: 0, requireConfirm: false, confirmMode: 'biometric' } });
    await t.request(sensitive);
    expect(read).not.toHaveBeenCalled();

    state.requireConfirm = true;
    await expect(t.request(sensitive)).resolves.toEqual({ removed: true });
    expect(read).toHaveBeenCalledTimes(1);
    const [, unsigned, signed] = bridge.seen;
    expect(unsigned.confirmed).toBe(false);
    expect(signed).toEqual({ rid: unsigned.rid, confirmed: true });
  });

  it('no key: sends unsigned; works only with requireConfirm off, else "confirmations unavailable"', async () => {
    const s = setup();
    const read = jest.spyOn(keyStore, 'readConfirmKey');
    const state = { requireConfirm: false };
    stubFetch(confirmBridge(s, state).handler);
    const t = createSecureTransport(new SecureChannel(s.identity, { ...s.host, confirmMode: 'none' }));
    await expect(t.request(sensitive)).resolves.toEqual({ removed: true });
    state.requireConfirm = true;
    await expect(t.request(sensitive)).rejects.toBeInstanceOf(ConfirmUnavailableError);
    expect(read).not.toHaveBeenCalled();
  });

  it('an invalidated biometric key (reads as null) is caught before sending', async () => {
    const s = setup();
    jest.spyOn(keyStore, 'readConfirmKey').mockResolvedValue(null);
    const bridge = confirmBridge(s, { requireConfirm: true });
    stubFetch(bridge.handler);
    const t = createSecureTransport(new SecureChannel(s.identity, { ...s.host, confirmMode: 'biometric' }));
    await expect(t.request(sensitive)).rejects.toBeInstanceOf(ConfirmKeyInvalidatedError);
    expect(bridge.seen).toHaveLength(0);
  });
});

describe('outer error table (contract rev 4.3 §4.4a)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('rpc 401 auth_failed re-handshakes once, 400 replayed re-seals once, both with the same rid', async () => {
    for (const failure of [{ status: 401, error: 'auth_failed' }, { status: 400, error: 'replayed' }]) {
      const s = setup();
      const bridge = fakeBridge(s);
      let failed = false;
      stubFetch((path, body) => {
        if (path.endsWith('/rpc') && !failed) {
          failed = true;
          return { status: failure.status, json: { error: failure.error } };
        }
        return bridge.handler(path, body);
      });
      await expect(new SecureChannel(s.identity, s.host).request({ method: 'POST', path: '/v1/x' }, { rid: 'r-1' })).resolves.toEqual({ ok: '/v1/x' });
      expect(bridge.seen.map((r) => r.rid)).toEqual(['r-1']);
    }
  });

  it('403 forbidden_peer is a route problem, not a refusal: the pairing is kept', async () => {
    const s = setup();
    stubFetch(() => ({ status: 403, json: { error: 'forbidden_peer' } }));
    await expect(new SecureChannel(s.identity, s.host).request({ method: 'GET', path: '/v1/a' })).rejects.toBeInstanceOf(ForbiddenPeerError);
  });
});
