/**
 * Shared test vectors from the bridge team (contract Appendix A), at
 * docs/bridge-vectors/vectors.json. Proves this TypeScript client and the Rust bridge agree
 * byte for byte. Every intermediate value is checked so a mismatch names the exact step.
 * Skips cleanly when the file is absent; override the path with AIONDX_VECTORS.
 */
import { fromB64u, fromUtf8, toB64u, utf8 } from '../../encoding';
import { dh, open, publicKeyFromSecret, sha256 } from '../primitives';
import {
  derivePairingKey,
  deriveSessionKeys,
  handshakeInitAad,
  handshakeInitKey,
  type HandshakeState,
  openRevocationNotice,
  pairRequestAad,
  pairResponseAad,
  revocationContext,
  revocationKey,
  rpcAad,
  sessionTranscript,
  shortAuthString,
} from '../protocol';
import { confirmMacInput, confirmProof, jcs, rekeyMacInput, rekeyProof } from '../confirm';
import { hostCheckConfirm } from '../protocol.host';
import { fromHex, sealWithNonce, toHex } from '../testing';

interface Sealed {
  plaintext: string;
  aad: string;
  nonce: string;
  ct: string;
}

// Node built-ins via require: the app tsconfig deliberately has no Node types; jest runs this in Node.
/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs') as { existsSync(p: string): boolean; readFileSync(p: string, enc: 'utf8'): string };
const path = require('path') as { join(...parts: string[]): string };
/* eslint-enable @typescript-eslint/no-require-imports */
declare const __dirname: string;

const VECTORS_PATH = process.env.AIONDX_VECTORS ?? path.join(__dirname, '../../../../docs/bridge-vectors/vectors.json');
const present = fs.existsSync(VECTORS_PATH);
// Untyped JSON fixture; every field is checked against our own computation below.
const v: any = present ? JSON.parse(fs.readFileSync(VECTORS_PATH, 'utf8')) : null;

if (!present) {
  // Visible in the jest output so a silently skipped interop suite doesn't go unnoticed.
  console.warn(`[vectors] ${VECTORS_PATH} not found — shared-vector tests skipped.`);
}

const describeVectors = present ? describe : describe.skip;

/** The sealed box must open to the exact plaintext, and re-sealing with its nonce must give the same ct. */
function expectSealed(key: Uint8Array, box: Sealed, expectedAad: Uint8Array) {
  expect(toHex(expectedAad)).toBe(box.aad);
  const nonce = fromB64u(box.nonce);
  expect(fromUtf8(open(key, nonce, fromB64u(box.ct), expectedAad))).toBe(box.plaintext);
  expect(toB64u(sealWithNonce(key, nonce, utf8(box.plaintext), expectedAad))).toBe(box.ct);
}

describeVectors('shared vectors (bridge contract Appendix A)', () => {
  const key = (k: string) => fromHex(v.inputs[k].priv);
  const pub = (k: string) => fromHex(v.inputs[k].pub);
  const hostId: string = v?.inputs.hostId;
  const deviceId: string = v?.inputs.deviceId;

  it('inputs: public keys derive from private keys', () => {
    for (const k of ['S_h', 'S_c', 'e_c', 'e_h']) {
      expect(toHex(publicKeyFromSecret(key(k)))).toBe(v.inputs[k].pub);
      expect(toB64u(pub(k))).toBe(v.inputs[k].pubB64u);
    }
  });

  it('pairing: DH, k_pair, SAS, sealed request and response', () => {
    const p = v.pairing;
    expect(toHex(dh(key('S_c'), pub('S_h')))).toBe(p.dh_Sc_Sh);
    const kPair = derivePairingKey(key('S_c'), pub('S_h'), fromHex(v.inputs.pairingSecret), pub('S_h'), pub('S_c'));
    expect(toHex(kPair)).toBe(p.k_pair);
    expect(shortAuthString(kPair)).toBe(p.sas);
    expectSealed(kPair, p.request, pairRequestAad(hostId, deviceId));
    expectSealed(kPair, p.response, pairResponseAad(hostId, deviceId));
    const res = JSON.parse(p.response.plaintext) as { confirmKey?: string };
    expect(res.confirmKey && toHex(fromB64u(res.confirmKey))).toBe(p.confirmKey);
  });

  it('handshake: DH outputs, k_init, sealed init, transcript, session keys, sealed response', () => {
    const h = v.handshake;
    const [ec, Sc, Sh, eh] = [key('e_c'), key('S_c'), pub('S_h'), pub('e_h')];
    expect(toHex(dh(ec, Sh))).toBe(h.dh_ec_Sh);
    expect(toHex(dh(Sc, Sh))).toBe(h.dh_Sc_Sh);
    expect(toHex(dh(ec, eh))).toBe(h.dh_ec_eh);
    expect(toHex(dh(Sc, eh))).toBe(h.dh_Sc_eh);

    const kInit = handshakeInitKey(dh(ec, Sh), dh(Sc, Sh), deviceId, pub('S_c'), Sh, pub('e_c'));
    expect(toHex(kInit)).toBe(h.k_init);
    expectSealed(kInit, h.init, handshakeInitAad(hostId, deviceId, pub('e_c')));

    const transcript = sessionTranscript(deviceId, pub('S_c'), Sh, pub('e_c'), eh);
    expect(toHex(transcript)).toBe(h.transcript);
    const keys = deriveSessionKeys([dh(ec, Sh), dh(Sc, Sh), dh(ec, eh), dh(Sc, eh)], transcript, 0);
    expect(toHex(keys.c2s)).toBe(h.c2s);
    expect(toHex(keys.s2c)).toBe(h.s2c);
    expect(toHex(keys.sessionId)).toBe(h.sid);
    expect(toB64u(keys.sessionId)).toBe(h.sidB64u);
    expectSealed(keys.s2c, h.response, transcript);
  });

  it('rpc: sealed request and response at the vector seq', () => {
    const h = v.handshake;
    const sid = fromHex(h.sid);
    expectSealed(fromHex(h.c2s), v.rpc.request, rpcAad('req', sid, v.rpc.seq));
    expectSealed(fromHex(h.s2c), v.rpc.response, rpcAad('res', sid, v.rpc.seq));
    // The vector request carries a rid, as every InnerRequest must (A4).
    expect(JSON.parse(v.rpc.request.plaintext).rid).toEqual(expect.any(String));
  });

  it('revocation (A1): k_rev, sealed notice, and the client verifier accepts it', () => {
    const r = v.revocation;
    const ecPub = pub('e_c');
    expect(toHex(dh(key('S_h'), ecPub))).toBe(r.dh_Sh_ec);
    expect(toHex(sha256(revocationContext(hostId, deviceId, ecPub)))).toBe(r.salt);
    const kRev = revocationKey(dh(key('S_h'), ecPub), hostId, deviceId, ecPub);
    expect(toHex(kRev)).toBe(r.k_rev);
    expectSealed(kRev, r.notice, revocationContext(hostId, deviceId, ecPub));

    // End to end through the code SecureChannel uses, with "now" at the vector timestamp.
    const identity = { deviceId, secretKey: key('S_c'), publicKey: pub('S_c') };
    const state: HandshakeState = { ephemeral: { secretKey: key('e_c'), publicKey: ecPub }, hostId, hostPublicKey: pub('S_h') };
    const notice = { nonce: r.notice.nonce, ct: r.notice.ct };
    expect(openRevocationNotice(identity, state, notice, v.inputs.ts)).toEqual(JSON.parse(r.notice.plaintext));
  });

  it('confirm (§5, §5.4): JCS, body hash, MAC input and proof for every case', () => {
    const confirmKey = fromHex(v.pairing.confirmKey);
    const sessionId = fromHex(v.handshake.sid);
    for (const c of v.confirm) {
      const body = c.body === '(absent)' ? undefined : c.body;
      expect(jcs(body === undefined ? null : body)).toBe(c.jcs);
      expect(toHex(sha256(utf8(c.jcs)))).toBe(c.bodySha256);
      const input = { sessionId, seq: c.seq, method: c.method, path: c.path, body, rid: c.rid };
      expect(toHex(confirmMacInput(input))).toBe(c.macInput);
      expect(confirmProof(confirmKey, input)).toBe(c.confirm);
      // The host reference accepts it, and rejects it at any other seq (the proof binds the envelope).
      const session = { sessionId, c2s: new Uint8Array(32), s2c: new Uint8Array(32), expiresAt: 0 };
      const request = { method: c.method, path: c.path, body, rid: c.rid, confirm: c.confirm };
      expect(hostCheckConfirm(confirmKey, session, c.seq, request)).toBe('ok');
      expect(hostCheckConfirm(confirmKey, session, c.seq + 1, request)).toBe('invalid');
      expect(hostCheckConfirm(confirmKey, session, c.seq, { ...request, confirm: undefined })).toBe('missing');
    }
  });

  it('rekey (§5.3): MAC input and proof', () => {
    const r = v.rekey;
    const sessionId = fromHex(v.handshake.sid);
    expect(toB64u(fromHex(r.rekeySecret))).toBe(r.rekeySecretB64u);
    expect(toHex(rekeyMacInput(sessionId, deviceId))).toBe(r.macInput);
    expect(rekeyProof(fromB64u(r.rekeySecretB64u), sessionId, deviceId)).toBe(r.proof);
  });
});
