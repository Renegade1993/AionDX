// Local test bridge: protocol.host.ts (reference host) + the in-memory /v1 facade behind the encrypted channel.
// Env: NO_TASK_WRITE=1 drops the tasks.write capability; REQUIRE_CONFIRM=0 turns off the §5 confirm check.
import http from 'node:http';
import fs from 'node:fs';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) (globalThis as any).crypto = webcrypto;

import { generateKeyPair, randomBytes } from 'proj/src/lib/crypto/primitives';
import * as proto from 'proj/src/lib/crypto/protocol';
import * as host from 'proj/src/lib/crypto/protocol.host';
import { createMockFacade } from 'proj/src/lib/api/mock/facade';
import { fromB64u, toB64u } from 'proj/src/lib/encoding';

const PORT = 7777;
const hostKeys = generateKeyPair();
const hostId = 'test-bridge';
const pairingSecret = randomBytes(32);
const offer = {
  v: 1,
  hostId,
  hostName: 'TEST-PC',
  hostPublicKey: hostKeys.publicKey,
  pairingSecret,
  urls: [`http://localhost:${PORT}`],
  expiresAt: Date.now() + 30 * 60 * 1000,
};
fs.writeFileSync('pairing-uri.txt', proto.encodePairingUri(offer));
console.log('pairing uri written');

/** The PC's per-device "Require confirmation" (contract §5); flip at runtime with /__confirm?on=0|1. */
let REQUIRE_CONFIRM = process.env.REQUIRE_CONFIRM !== '0';
interface Device {
  publicKey: Uint8Array;
  name: string;
  pairedAt: number;
  confirmMode: string;
  /** Issued at pairing unless the phone has no screen lock (contract §5.2). */
  confirmKey?: Uint8Array;
}
const devices = new Map<string, Device>();
const pairPolls = new Map<string, number>();
const sessions = new Map<string, { keys: any; window: any; deviceId: string }>();
const facade = createMockFacade({
  hostId,
  hostName: 'TEST-PC',
  capabilities: process.env.NO_TASK_WRITE ? ['changes.longpoll', 'approvals.questions'] : ['changes.longpoll', 'tasks.write', 'approvals.questions'],
});
let failing = false;
let revoked = false;
let hostReset = false;
/** A2: the first valid pair request binds the offer to that device key. */
let offerBoundTo: string | null = null;
let offerBurned = false;
/** A4: non-GET inner requests are de-duplicated by rid (here: forever, per process). */
const ridCache = new Map<string, unknown>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The /v1 facade (contract §6), answered by the same in-memory facade the demo host uses.
 * The bridge adds what only a real PC knows: this device's confirm settings, and the §5 check.
 */
async function dispatch(deviceId: string, rpc: { method: string; path: string; body?: unknown }, confirmCheck: () => 'ok' | 'missing' | 'invalid') {
  const device = devices.get(deviceId)!;
  if (REQUIRE_CONFIRM && facade.isSensitive(rpc)) {
    const check = device.confirmKey ? confirmCheck() : 'missing';
    if (check === 'missing') return { status: 428, body: { error: { code: 'confirm_required', message: 'This action needs a confirmation' } } };
    if (check === 'invalid') return { status: 403, body: { error: { code: 'confirm_invalid', message: "The confirmation didn't verify" } } };
    console.log(`confirm proof verified for ${rpc.method} ${rpc.path}`);
  }
  const res = await facade.handle(rpc);
  if (rpc.path === '/v1/host' && res.status === 200) {
    const info = res.body as Record<string, unknown>;
    info.hostId = hostId;
    info.hostName = 'TEST-PC';
    info.device = { deviceId, name: device.name, pairedAt: device.pairedAt, requireConfirm: REQUIRE_CONFIRM, confirmMode: device.confirmMode };
  }
  return res;
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  if (req.url?.startsWith('/__fail')) { failing = req.url.includes('on=1'); console.log('failing', failing); return res.writeHead(200).end('ok'); }
  // Revoking deletes the device and kills its sessions (contract §3.4), so the next request re-handshakes and gets the A1 notice.
  if (req.url?.startsWith('/__revoke')) { revoked = true; devices.clear(); sessions.clear(); console.log('revoked'); return res.writeHead(200).end('ok'); }
  if (req.url?.startsWith('/__confirm')) { REQUIRE_CONFIRM = req.url.includes('on=1'); console.log('require confirm', REQUIRE_CONFIRM); return res.writeHead(200).end('ok'); }
  if (req.url?.startsWith('/__reset')) { hostReset = true; sessions.clear(); console.log('host key reset'); return res.writeHead(200).end('ok'); }
  // Simulate the PC dropping off the network: kill the connection without a response.
  if (failing && req.url?.startsWith('/api/mobile/v1/')) { req.socket.destroy(); return; }
  // After a host-key reset the phone's hostId is stale: plaintext 409, the phone keeps its pairing.
  if (hostReset && req.url === '/api/mobile/v1/session') return res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'unknown_host', hostId: 'reset-host-id' }));
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    const send = (status: number, json: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(json));
    try {
      const body = JSON.parse(raw || '{}');
      if (req.url === '/api/mobile/v1/pair') {
        const opened = host.hostOpenPairRequest(hostKeys, hostId, pairingSecret, body);
        if (offerBurned) return send(410, { error: 'pairing_expired' });
        // A2: a second device using the same code burns the offer for both.
        if (offerBoundTo && offerBoundTo !== body.devicePk) {
          offerBurned = true;
          console.log('offer used by a second device: burned');
          return send(409, { error: 'pairing_locked' });
        }
        offerBoundTo = body.devicePk;
        const n = (pairPolls.get(body.deviceId) ?? 0) + 1;
        pairPolls.set(body.deviceId, n);
        // Long-poll (§4.2): wait:false answers at once; wait:true is held, and the simulated
        // PC user approves during the second held request.
        if (opened.payload.wait) await sleep(2000);
        const status = n >= 3 ? 'approved' : 'pending';
        const confirmKey = status === 'approved' && opened.payload.confirmMode !== 'none' ? randomBytes(32) : undefined;
        if (status === 'approved') {
          devices.set(body.deviceId, {
            publicKey: opened.devicePublicKey,
            name: opened.payload.deviceName,
            pairedAt: Date.now(),
            confirmMode: opened.payload.confirmMode,
            confirmKey,
          });
        }
        console.log(`pair #${n} wait=${opened.payload.wait} mode=${opened.payload.confirmMode} from "${opened.payload.deviceName}" SAS=${opened.sas} -> ${status}`);
        return send(200, host.hostSealPairResponse(opened.pairingKey, hostId, body.deviceId, {
          status, hostId, hostName: 'TEST-PC', ts: Date.now(), reqTs: opened.payload.ts, ...(confirmKey ? { confirmKey: toB64u(confirmKey) } : {}),
        }));
      }
      if (req.url === '/api/mobile/v1/session') {
        // A1: any untrusted deviceId gets an authenticated notice the phone can verify.
        if (!devices.has(body.deviceId)) {
          return send(403, { error: 'device_revoked', notice: host.hostSealRevocationNotice(hostKeys, hostId, body, revoked ? 'revoked' : 'unknown') });
        }
        const { response, session } = host.hostRespondHandshake(hostKeys, hostId, body, (id: string) => devices.get(id)?.publicKey ?? null, 12 * 3600 * 1000);
        sessions.set(toB64u(session.sessionId), { keys: session, window: new host.ReplayWindow(), deviceId: body.deviceId });
        console.log('session established');
        return send(200, response);
      }
      if (req.url === '/api/mobile/v1/rpc') {
        const s = sessions.get(body.sid);
        if (!s) return send(401, { error: 'unknown_session' });
        const rpc = host.hostOpenRpcRequest(s.keys, s.window, body);
        const dedupe = rpc.method !== 'GET' && ridCache.has(rpc.rid);
        const confirmKey = devices.get(s.deviceId)?.confirmKey;
        const result = (dedupe
          ? ridCache.get(rpc.rid)
          : await dispatch(s.deviceId, rpc, () => (confirmKey ? host.hostCheckConfirm(confirmKey, s.keys, body.seq, rpc) : 'missing'))) as { status: number; body?: unknown };
        // A confirm failure isn't a result to replay: the phone resends signed with the same rid.
        if (rpc.method !== 'GET' && !dedupe && result.status !== 428 && result.status !== 403) ridCache.set(rpc.rid, result);
        if (dedupe) console.log(`rid ${rpc.rid} replayed: returning the first result`);
        if (process.env.VERBOSE) console.log(`rpc ${rpc.method} ${rpc.path} -> ${result.status}`);
        return send(200, host.hostSealRpcResponse(s.keys, body.seq, result));
      }
      send(404, { error: 'not_found' });
    } catch (e: any) {
      console.log('ERROR', req.url, e.message);
      send(400, { error: e.message });
    }
  });
});
server.listen(PORT, () => console.log(`bridge on ${PORT} (confirm ${REQUIRE_CONFIRM ? 'required' : 'off'})`));
void fromB64u;
