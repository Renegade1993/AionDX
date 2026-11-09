import { fromB64u, toB64u } from '../../encoding';
import { generateKeyPair, randomBytes } from '../primitives';
import {
  beginHandshake,
  buildPairRequest,
  type DeviceIdentity,
  encodePairingUri,
  finishHandshake,
  openPairResponse,
  openRevocationNotice,
  openRpcResponse,
  type PairingOffer,
  parsePairingUri,
  ProtocolError,
  sealRpcRequest,
} from '../protocol';
import {
  hostOpenPairRequest,
  hostOpenRpcRequest,
  hostRespondHandshake,
  hostSealPairResponse,
  hostSealRevocationNotice,
  hostSealRpcResponse,
  ReplayWindow,
} from '../protocol.host';

const NOW = 1_794_000_000_000;

function makeDevice(): DeviceIdentity {
  return { deviceId: toB64u(randomBytes(16)), ...generateKeyPair() };
}

function makeHost() {
  const keys = generateKeyPair();
  const offer: PairingOffer = {
    v: 1,
    hostId: 'host-1',
    hostName: 'Nate’s PC',
    hostPublicKey: keys.publicKey,
    pairingSecret: randomBytes(32),
    urls: ['http://192.168.1.20:7777', 'http://10.0.0.5:7777'],
    expiresAt: NOW + 5 * 60 * 1000,
  };
  return { keys, offer };
}

const flipMiddleChar = (b64u: string) => {
  const i = b64u.length >> 1;
  return b64u.slice(0, i) + (b64u[i] === 'A' ? 'B' : 'A') + b64u.slice(i + 1);
};

describe('pairing URI', () => {
  it('round-trips', () => {
    const { offer } = makeHost();
    const parsed = parsePairingUri(encodePairingUri(offer), NOW);
    expect(parsed).toEqual(offer);
  });

  it('rejects expired codes', () => {
    const { offer } = makeHost();
    expect(() => parsePairingUri(encodePairingUri(offer), offer.expiresAt + 1)).toThrow(ProtocolError);
  });

  it('rejects other schemes and missing fields', () => {
    expect(() => parsePairingUri('https://example.com/pair?v=1', NOW)).toThrow(/Not an AionDX/);
    expect(() => parsePairingUri('aiondx://pair?v=1&id=x', NOW)).toThrow(/missing fields/);
    expect(() => parsePairingUri('aiondx://pair?v=2', NOW)).toThrow(/Unsupported protocol version/);
  });
});

describe('pairing exchange', () => {
  it('host decrypts request, both sides agree on SAS, phone decrypts approval', () => {
    const { keys, offer } = makeHost();
    const device = makeDevice();
    const payload = { deviceName: 'Pixel', platform: 'android', appVersion: '1.0.0', ts: NOW, confirmMode: 'biometric' as const, wait: false };

    const { body, pairingKey, sas } = buildPairRequest(device, offer, payload);
    const host = hostOpenPairRequest(keys, offer.hostId, offer.pairingSecret, body, NOW);

    expect(host.payload).toEqual(payload);
    expect(host.sas).toBe(sas);
    expect(sas).toMatch(/^\d{3} \d{3}$/);
    expect(toB64u(host.devicePublicKey)).toBe(toB64u(device.publicKey));

    const box = hostSealPairResponse(host.pairingKey, offer.hostId, device.deviceId, {
      status: 'approved',
      hostId: offer.hostId,
      hostName: offer.hostName,
      ts: NOW,
      reqTs: payload.ts,
      confirmKey: toB64u(new Uint8Array(32).fill(7)),
    });
    const reply = openPairResponse(pairingKey, offer.hostId, device.deviceId, box, payload.ts);
    expect(reply.status).toBe('approved');
    expect(reply.confirmKey).toBe(toB64u(new Uint8Array(32).fill(7)));
  });

  it('rejects a response that answers a different request (reqTs echo)', () => {
    const { keys, offer } = makeHost();
    const device = makeDevice();
    const payload = { deviceName: 'x', platform: 'ios', appVersion: '1', ts: NOW, confirmMode: 'none' as const, wait: true };
    const { body, pairingKey } = buildPairRequest(device, offer, payload);
    const host = hostOpenPairRequest(keys, offer.hostId, offer.pairingSecret, body, NOW);
    const box = hostSealPairResponse(host.pairingKey, offer.hostId, device.deviceId, {
      status: 'pending',
      hostId: offer.hostId,
      hostName: offer.hostName,
      ts: NOW,
      reqTs: NOW - 1000,
    });
    expect(() => openPairResponse(pairingKey, offer.hostId, device.deviceId, box, NOW)).toThrow(/different request/);
  });

  it('fails without the QR pairing secret', () => {
    const { keys, offer } = makeHost();
    const device = makeDevice();
    const { body } = buildPairRequest(device, { ...offer, pairingSecret: randomBytes(32) }, {
      deviceName: 'x',
      platform: 'ios',
      appVersion: '1',
      ts: NOW,
      confirmMode: 'none',
      wait: false,
    });
    expect(() => hostOpenPairRequest(keys, offer.hostId, offer.pairingSecret, body, NOW)).toThrow(/Decryption failed/);
  });

  it('rejects stale pairing requests', () => {
    const { keys, offer } = makeHost();
    const { body } = buildPairRequest(makeDevice(), offer, { deviceName: 'x', platform: 'ios', appVersion: '1', ts: NOW - 10 * 60 * 1000, confirmMode: 'none', wait: false });
    expect(() => hostOpenPairRequest(keys, offer.hostId, offer.pairingSecret, body, NOW)).toThrow(/Timestamp/);
  });
});

describe('session handshake + RPC', () => {
  function establish() {
    const { keys, offer } = makeHost();
    const device = makeDevice();
    const paired = new Map([[device.deviceId, device.publicKey]]);
    const { body, state } = beginHandshake(device, offer, NOW);
    const { response, session: hostSession } = hostRespondHandshake(
      keys,
      offer.hostId,
      body,
      (id) => paired.get(id) ?? null,
      60 * 60 * 1000,
      NOW,
    );
    const phoneSession = finishHandshake(device, state, response);
    return { keys, offer, device, hostSession, phoneSession, body, response, state };
  }

  it('derives identical session keys on both sides', () => {
    const { hostSession, phoneSession } = establish();
    expect(toB64u(phoneSession.c2s)).toBe(toB64u(hostSession.c2s));
    expect(toB64u(phoneSession.s2c)).toBe(toB64u(hostSession.s2c));
    expect(toB64u(phoneSession.sessionId)).toBe(toB64u(hostSession.sessionId));
    expect(phoneSession.expiresAt).toBe(NOW + 60 * 60 * 1000);
  });

  it('uses fresh keys per session (forward secrecy via ephemerals)', () => {
    const a = establish();
    const b = establish();
    expect(toB64u(a.phoneSession.c2s)).not.toBe(toB64u(b.phoneSession.c2s));
  });

  it('host rejects unknown devices', () => {
    const { keys, offer } = makeHost();
    const { body } = beginHandshake(makeDevice(), offer, NOW);
    expect(() => hostRespondHandshake(keys, offer.hostId, body, () => null, 1000, NOW)).toThrow(/Unknown device/);
  });

  it('host rejects a device presenting someone else’s deviceId', () => {
    const { keys, offer } = makeHost();
    const victim = makeDevice();
    const attacker = { ...makeDevice(), deviceId: victim.deviceId };
    const { body } = beginHandshake(attacker, offer, NOW);
    expect(() => hostRespondHandshake(keys, offer.hostId, body, () => victim.publicKey, 1000, NOW)).toThrow(/Decryption failed/);
  });

  it('phone rejects an impostor host', () => {
    const { offer } = makeHost();
    const device = makeDevice();
    const { body, state } = beginHandshake(device, offer, NOW);
    const impostor = generateKeyPair();
    // Impostor can't open the init (wrong static key), so it fabricates a response.
    expect(() => hostRespondHandshake(impostor, offer.hostId, body, () => device.publicKey, 1000, NOW)).toThrow();
    const fake = { v: 1, epk: toB64u(generateKeyPair().publicKey), nonce: toB64u(randomBytes(24)), ct: toB64u(randomBytes(40)) };
    expect(() => finishHandshake(device, state, fake)).toThrow(/Decryption failed/);
  });

  it('round-trips RPC request/response', () => {
    const { hostSession, phoneSession } = establish();
    const window = new ReplayWindow();
    const req = { method: 'GET' as const, path: '/api/teams/t1/run-state', rid: 'rid-1' };

    const env = sealRpcRequest(phoneSession, 1, req);
    expect(hostOpenRpcRequest(hostSession, window, env)).toEqual(req);

    const resEnv = hostSealRpcResponse(hostSession, 1, { status: 200, body: { slots: [] } });
    expect(openRpcResponse(phoneSession, 1, resEnv)).toEqual({ status: 200, body: { slots: [] } });
  });

  it('rejects replayed, tampered, and re-sequenced requests', () => {
    const { hostSession, phoneSession } = establish();
    const window = new ReplayWindow();
    const env = sealRpcRequest(phoneSession, 5, { method: 'POST', path: '/api/x', body: { a: 1 }, rid: 'rid-2' });

    hostOpenRpcRequest(hostSession, window, env);
    expect(() => hostOpenRpcRequest(hostSession, window, env)).toThrow(/Replayed/);
    expect(() => hostOpenRpcRequest(hostSession, new ReplayWindow(), { ...env, ct: flipMiddleChar(env.ct) })).toThrow(/Decryption failed/);
    expect(() => hostOpenRpcRequest(hostSession, new ReplayWindow(), { ...env, seq: 6 })).toThrow(/Decryption failed/);
  });

  it('phone rejects a response bound to a different request', () => {
    const { hostSession, phoneSession } = establish();
    const resEnv = hostSealRpcResponse(hostSession, 2, { status: 200 });
    expect(() => openRpcResponse(phoneSession, 3, resEnv)).toThrow(/does not match/);
    expect(() => openRpcResponse(phoneSession, 3, { ...resEnv, seq: 3 })).toThrow(/Decryption failed/);
  });
});

describe('ReplayWindow', () => {
  it('accepts out-of-order within the window and rejects old/duplicate', () => {
    const w = new ReplayWindow(4);
    expect(w.accept(3)).toBe(true);
    expect(w.accept(1)).toBe(true);
    expect(w.accept(3)).toBe(false);
    expect(w.accept(10)).toBe(true);
    expect(w.accept(6)).toBe(false); // 10 - 4
    expect(w.accept(7)).toBe(true);
    expect(w.accept(-1)).toBe(false);
  });
});

describe('encoding', () => {
  it('base64url round-trips all lengths', () => {
    for (let n = 0; n < 40; n++) {
      const bytes = randomBytes(n);
      expect(Array.from(fromB64u(toB64u(bytes)))).toEqual(Array.from(bytes));
    }
  });

  it('rejects non-canonical base64url', () => {
    expect(() => fromB64u('AB')).toThrow(/Non-canonical/);
    expect(Array.from(fromB64u('AA'))).toEqual([0]);
  });
});

describe('revocation notice (A1)', () => {
  function attempt() {
    const { keys, offer } = makeHost();
    const device = makeDevice();
    const { body, state } = beginHandshake(device, offer, NOW);
    return { keys, offer, device, body, state };
  }

  it('verifies a host-sealed notice for this device', () => {
    const { keys, offer, device, body, state } = attempt();
    const notice = hostSealRevocationNotice(keys, offer.hostId, body, 'unknown', NOW);
    expect(openRevocationNotice(device, state, notice, NOW)).toEqual({ deviceId: device.deviceId, ts: NOW, reason: 'unknown' });
  });

  it('rejects a notice sealed by anyone but the paired host', () => {
    const { offer, device, body, state } = attempt();
    const forged = hostSealRevocationNotice(generateKeyPair(), offer.hostId, body, 'revoked', NOW);
    expect(() => openRevocationNotice(device, state, forged, NOW)).toThrow(/Decryption failed/);
  });

  it('rejects a notice replayed from another handshake (fresh e_c binds it)', () => {
    const { keys, offer, device, body } = attempt();
    const old = hostSealRevocationNotice(keys, offer.hostId, body, 'revoked', NOW);
    const { state: newState } = beginHandshake(device, offer, NOW);
    expect(() => openRevocationNotice(device, newState, old, NOW)).toThrow(/Decryption failed/);
  });

  it('rejects a stale notice', () => {
    const { keys, offer, device, body, state } = attempt();
    const notice = hostSealRevocationNotice(keys, offer.hostId, body, 'revoked', NOW - 10 * 60 * 1000);
    expect(() => openRevocationNotice(device, state, notice, NOW)).toThrow(/Timestamp/);
  });

  it('host handshake reports idleTimeoutMs to the phone', () => {
    const { keys, offer, device, body, state } = attempt();
    const { response } = hostRespondHandshake(keys, offer.hostId, body, () => device.publicKey, 60_000, NOW, 1_800_000);
    expect(finishHandshake(device, state, response).idleTimeoutMs).toBe(1_800_000);
  });
});
