#!/usr/bin/env node
// Generates docs/mobile-bridge/vectors/vectors.json: fixed-input test vectors for protocol v1 as amended
// in CONTRACT.md. Node 20+ only, no packages. Usage: node gen-vectors.js [--check]
//   --check  regenerate and compare with vectors.json (exit 1 on any difference)
//
// Conventions (must match protocol.ts):
//   HKDF = HKDF-SHA256(ikm, salt, info, L); L = 32 unless stated. Empty salt = zero-length (RFC 5869 pads to 32 zeros).
//   AEAD = XChaCha20-Poly1305; ct field = b64u(ciphertext || 16-byte tag). Nonces here are fixed; real code uses random.
//   Plaintext = UTF-8 of JSON.stringify(value) exactly as given in each vector's `plaintext` string.
//   b64u = base64url, no padding. u64be = 8-byte big-endian.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const hex = (b) => Buffer.from(b).toString('hex');
const b64u = (b) => Buffer.from(b).toString('base64url');
const utf8 = (s) => Buffer.from(s, 'utf8');
const cat = (...xs) => Buffer.concat(xs.map((x) => Buffer.from(x)));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
const hkdf = (ikm, salt, info, len = 32) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const u64be = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
// Deterministic test material: SHA-256 of a label.
const seed = (label, len = 32) => sha256(utf8('aiondx-test-vector/' + label)).subarray(0, len);

// --- X25519 from raw 32-byte private keys -----------------------------------------------------------
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex');
function x25519Key(priv) {
  const key = crypto.createPrivateKey({ key: cat(PKCS8_X25519, priv), format: 'der', type: 'pkcs8' });
  const pub = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(12);
  return { priv: Buffer.from(priv), pub: Buffer.from(pub), key };
}
function dh(own, peerPub) {
  const pub = crypto.createPublicKey({ key: cat(SPKI_X25519, peerPub), format: 'der', type: 'spki' });
  return crypto.diffieHellman({ privateKey: own.key, publicKey: pub });
}

// --- XChaCha20-Poly1305 (HChaCha20 + Node's IETF ChaCha20-Poly1305) ----------------------------------
function hchacha20(key, nonce16) {
  const rotl = (v, c) => ((v << c) | (v >>> (32 - c))) >>> 0;
  const s = new Uint32Array(16);
  s[0] = 0x61707865; s[1] = 0x3320646e; s[2] = 0x79622d32; s[3] = 0x6b206574;
  for (let i = 0; i < 8; i++) s[4 + i] = key.readUInt32LE(4 * i);
  for (let i = 0; i < 4; i++) s[12 + i] = nonce16.readUInt32LE(4 * i);
  const qr = (a, b, c, d) => {
    s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl(s[d] ^ s[a], 16);
    s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl(s[b] ^ s[c], 12);
    s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl(s[d] ^ s[a], 8);
    s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl(s[b] ^ s[c], 7);
  };
  for (let i = 0; i < 10; i++) {
    qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15);
    qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14);
  }
  const out = Buffer.alloc(32);
  [0, 1, 2, 3, 12, 13, 14, 15].forEach((w, i) => out.writeUInt32LE(s[w], 4 * i));
  return out;
}
function xseal(key, nonce24, plaintext, aad) {
  const sub = hchacha20(Buffer.from(key), Buffer.from(nonce24).subarray(0, 16));
  const n12 = cat(Buffer.alloc(4), Buffer.from(nonce24).subarray(16, 24));
  const c = crypto.createCipheriv('chacha20-poly1305', sub, n12, { authTagLength: 16 });
  c.setAAD(Buffer.from(aad), { plaintextLength: plaintext.length });
  return cat(c.update(plaintext), c.final(), c.getAuthTag());
}
function xopen(key, nonce24, sealed, aad) {
  const sub = hchacha20(Buffer.from(key), Buffer.from(nonce24).subarray(0, 16));
  const n12 = cat(Buffer.alloc(4), Buffer.from(nonce24).subarray(16, 24));
  const d = crypto.createDecipheriv('chacha20-poly1305', sub, n12, { authTagLength: 16 });
  d.setAAD(Buffer.from(aad), { plaintextLength: sealed.length - 16 });
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  return cat(d.update(sealed.subarray(0, sealed.length - 16)), d.final());
}

// Self-test against draft-irtf-cfrg-xchacha-03 (§2.2.1 HChaCha20, §A.3.1 AEAD) before emitting anything.
(function selfTest() {
  const k = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
  const got = hex(hchacha20(k, Buffer.from('000000090000004a0000000031415927', 'hex')));
  const want = '82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc';
  if (got !== want) throw new Error('HChaCha20 self-test failed: ' + got);
  const pt = utf8("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
  const aead = xseal(
    Buffer.from('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f', 'hex'),
    Buffer.from('404142434445464748494a4b4c4d4e4f5051525354555657', 'hex'),
    pt,
    Buffer.from('50515253c0c1c2c3c4c5c6c7', 'hex'),
  );
  const wantTag = 'c0875924c1c7987947deafd8780acf49';
  if (hex(aead.subarray(aead.length - 16)) !== wantTag) throw new Error('XChaCha20-Poly1305 self-test failed: ' + hex(aead));
})();

// --- RFC 8785 JCS for the value types sensitive bodies use (string, boolean, null, safe integer, array, object)
function jcs(v) {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error('vectors only cover safe integers');
    return String(v);
  }
  if (Array.isArray(v)) return '[' + v.map(jcs).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + jcs(v[k])).join(',') + '}';
}

// --- Fixed inputs ------------------------------------------------------------------------------------
const Sh = x25519Key(seed('S_h'));
const Sc = x25519Key(seed('S_c'));
const ec = x25519Key(seed('e_c'));
const eh = x25519Key(seed('e_h'));
const hostId = b64u(seed('hostId', 16));
const deviceId = b64u(seed('deviceId', 16));
const pairingSecret = seed('pairingSecret');
const nonce = (label) => seed('nonce/' + label, 24);
const TS = 1794023000000;
const keys = (k) => ({ priv: hex(k.priv), pub: hex(k.pub), pubB64u: b64u(k.pub) });

const out = {
  version: 1,
  conventions: 'See header of gen-vectors.js and CONTRACT.md Appendix A.',
  inputs: { S_h: keys(Sh), S_c: keys(Sc), e_c: keys(ec), e_h: keys(eh), hostId, deviceId, pairingSecret: hex(pairingSecret), ts: TS },
};

// 1. Pairing
{
  const dhSS = dh(Sc, Sh.pub);
  if (!dhSS.equals(dh(Sh, Sc.pub))) throw new Error('dh mismatch');
  const kPair = hkdf(dhSS, pairingSecret, cat(utf8('aiondx/v1/pair'), Sh.pub, Sc.pub));
  const sasBytes = hkdf(kPair, Buffer.alloc(0), utf8('aiondx/v1/sas'), 4);
  const digits = String(sasBytes.readUInt32BE(0) % 1000000).padStart(6, '0');
  const reqPlain = JSON.stringify({ deviceName: 'Test Phone', platform: 'ios', appVersion: '1.0.0', ts: TS, confirmMode: 'biometric', wait: false });
  const reqAad = utf8(`aiondx/v1/pair-req|${hostId}|${deviceId}`);
  const reqCt = xseal(kPair, nonce('pair-req'), utf8(reqPlain), reqAad);
  const confirmKey = seed('confirmKey');
  const resPlain = JSON.stringify({ status: 'approved', hostId, hostName: 'Test PC', ts: TS + 1000, reqTs: TS, confirmKey: b64u(confirmKey) });
  const resAad = utf8(`aiondx/v1/pair-res|${hostId}|${deviceId}`);
  const resCt = xseal(kPair, nonce('pair-res'), utf8(resPlain), resAad);
  out.pairing = {
    dh_Sc_Sh: hex(dhSS), k_pair: hex(kPair),
    sasBytes: hex(sasBytes), sas: `${digits.slice(0, 3)} ${digits.slice(3)}`,
    request: { plaintext: reqPlain, aad: hex(reqAad), nonce: b64u(nonce('pair-req')), ct: b64u(reqCt) },
    response: { plaintext: resPlain, aad: hex(resAad), nonce: b64u(nonce('pair-res')), ct: b64u(resCt) },
    confirmKey: hex(confirmKey),
  };
  out._confirmKey = confirmKey;
}

// 2. Session handshake
{
  const dEcSh = dh(ec, Sh.pub), dScSh = dh(Sc, Sh.pub), dEcEh = dh(ec, eh.pub), dScEh = dh(Sc, eh.pub);
  if (!dEcEh.equals(dh(eh, ec.pub)) || !dScEh.equals(dh(eh, Sc.pub))) throw new Error('dh mismatch');
  const initSalt = sha256(cat(utf8(`aiondx/v1/hs-init|${deviceId}|`), Sc.pub, Sh.pub, ec.pub));
  const kInit = hkdf(cat(dEcSh, dScSh), initSalt, utf8('aiondx/v1/hs-init'));
  const initPlain = JSON.stringify({ ts: TS });
  const initAad = cat(utf8(`aiondx/v1/hs-init|${hostId}|${deviceId}|`), ec.pub);
  const initCt = xseal(kInit, nonce('hs-init'), utf8(initPlain), initAad);
  const T = sha256(cat(utf8(`aiondx/v1/session|${deviceId}|`), Sc.pub, Sh.pub, ec.pub, eh.pub));
  const okm = hkdf(cat(dEcSh, dScSh, dEcEh, dScEh), T, utf8('aiondx/v1/session-keys'), 80);
  const c2s = okm.subarray(0, 32), s2c = okm.subarray(32, 64), sid = okm.subarray(64, 80);
  const resPlain = JSON.stringify({ expiresAt: TS + 12 * 3600 * 1000, idleTimeoutMs: 1800000 });
  const resCt = xseal(s2c, nonce('hs-res'), utf8(resPlain), T);
  out.handshake = {
    dh_ec_Sh: hex(dEcSh), dh_Sc_Sh: hex(dScSh), dh_ec_eh: hex(dEcEh), dh_Sc_eh: hex(dScEh),
    initSalt: hex(initSalt), k_init: hex(kInit),
    init: { plaintext: initPlain, aad: hex(initAad), nonce: b64u(nonce('hs-init')), ct: b64u(initCt) },
    transcript: hex(T), okm: hex(okm), c2s: hex(c2s), s2c: hex(s2c), sid: hex(sid), sidB64u: b64u(sid),
    response: { plaintext: resPlain, aad: hex(T), nonce: b64u(nonce('hs-res')), ct: b64u(resCt) },
  };
  out._session = { c2s, s2c, sid };
}

// 3. RPC envelope (seq 1)
{
  const { c2s, s2c, sid } = out._session;
  const req = JSON.stringify({ method: 'GET', path: '/v1/teams', rid: '00000000-0000-4000-8000-000000000001' });
  const reqAad = cat(utf8('aiondx/v1/rpc-req'), sid, u64be(1));
  const res = JSON.stringify({ status: 200, body: [] });
  const resAad = cat(utf8('aiondx/v1/rpc-res'), sid, u64be(1));
  out.rpc = {
    seq: 1,
    request: { plaintext: req, aad: hex(reqAad), nonce: b64u(nonce('rpc-req')), ct: b64u(xseal(c2s, nonce('rpc-req'), utf8(req), reqAad)) },
    response: { plaintext: res, aad: hex(resAad), nonce: b64u(nonce('rpc-res')), ct: b64u(xseal(s2c, nonce('rpc-res'), utf8(res), resAad)) },
  };
}

// 4. Authenticated revocation notice (A1)
{
  const d = dh(Sh, ec.pub);
  const label = `aiondx/v1/revoked|${hostId}|${deviceId}|`;
  const salt = sha256(cat(utf8(label), ec.pub));
  const kRev = hkdf(d, salt, utf8('aiondx/v1/revoked'));
  const plain = JSON.stringify({ deviceId, ts: TS, reason: 'revoked' });
  const aad = cat(utf8(label), ec.pub);
  out.revocation = { dh_Sh_ec: hex(d), salt: hex(salt), k_rev: hex(kRev), notice: { plaintext: plain, aad: hex(aad), nonce: b64u(nonce('revoked')), ct: b64u(xseal(kRev, nonce('revoked'), utf8(plain), aad)) } };
}

// 5. Confirm proofs (§5)
{
  const { sid } = out._session;
  const ck = out._confirmKey;
  const cases = [
    { method: 'POST', path: '/v1/approvals/YWJjZDEyMzQ6Y2FsbC0x/answer', rid: '00000000-0000-4000-8000-000000000002', seq: 7, body: { decision: 'allow_once' } },
    { method: 'POST', path: '/v1/teams/t1/agents', rid: '00000000-0000-4000-8000-000000000003', seq: 8, body: { name: 'Reviewer é中', assistantId: 'asst-1', model: null, flags: [true, 2] } },
    { method: 'DELETE', path: '/v1/teams/t1/agents/slot-9', rid: '00000000-0000-4000-8000-000000000004', seq: 9, body: undefined },
  ];
  out.confirm = cases.map((c) => {
    const canon = jcs(c.body === undefined ? null : c.body);
    const bodyHash = sha256(utf8(canon));
    const macInput = cat(utf8('aiondx/v1/confirm'), sid, u64be(c.seq), utf8(c.method), [0], utf8(c.path), [0], bodyHash, utf8(c.rid));
    return { ...c, body: c.body === undefined ? '(absent)' : c.body, jcs: canon, jcsHex: hex(utf8(canon)), bodySha256: hex(bodyHash), macInput: hex(macInput), confirm: b64u(hmac(ck, macInput)) };
  });
}

// 6. Re-key proof (§5.3)
{
  const { sid } = out._session;
  const rekeySecret = seed('rekeySecret');
  const macInput = cat(utf8('aiondx/v1/rekey'), sid, utf8(deviceId));
  out.rekey = { rekeySecret: hex(rekeySecret), rekeySecretB64u: b64u(rekeySecret), macInput: hex(macInput), proof: b64u(hmac(rekeySecret, macInput)) };
}

// Round-trip every sealed box before writing.
for (const [k, box] of [
  [out.pairing.k_pair, out.pairing.request], [out.pairing.k_pair, out.pairing.response],
  [out.handshake.k_init, out.handshake.init], [out.handshake.s2c, out.handshake.response],
  [out.handshake.c2s, out.rpc.request], [out.handshake.s2c, out.rpc.response],
  [out.revocation.k_rev, out.revocation.notice],
]) {
  const pt = xopen(Buffer.from(k, 'hex'), Buffer.from(box.nonce, 'base64url'), Buffer.from(box.ct, 'base64url'), Buffer.from(box.aad, 'hex'));
  if (pt.toString('utf8') !== box.plaintext) throw new Error('round-trip failed');
}
delete out._session;
delete out._confirmKey;

const file = path.join(__dirname, 'vectors.json');
const json = JSON.stringify(out, null, 2) + '\n';
if (process.argv.includes('--check')) {
  // Ignore line endings: git may check the file out with CRLF.
  const same = fs.existsSync(file) && fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') === json;
  console.log(same ? 'vectors.json up to date' : 'vectors.json DIFFERS');
  process.exit(same ? 0 : 1);
}
fs.writeFileSync(file, json);
console.log('wrote ' + file);
