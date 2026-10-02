#!/usr/bin/env node
/**
 * fetch-aionui-base.js - puts AionUi 2.2.2's original release files in vendor\aionui-base, the base tools\build-release.ps1 builds
 * AionDX on, without installing AionUi: downloads AionUi's official installer from its release CDN (the address AionUi's own updater
 * uses), checks its SHA-512 against the one AionUi publishes in latest.yml beside it, unpacks it with 7-Zip (the 7za from the
 * 7zip-bin package, which reads the installer's archive directly) and checks the three files the build depends on against their
 * known SHA-256.
 *
 *   node tools\fetch-aionui-base.js [--force]
 *
 * Needs network access and about 1.2 GB of disk (the installer, 180 MB, and the 910 MB it unpacks to). Both folders it uses are under
 * vendor\, which git ignores.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const VERSION = '2.2.2';
const URL_BASE = 'https://static.aionui.com/releases';
const FILE = 'AionUi-' + VERSION + '-win-x64.exe';
const vendor = path.join(__dirname, '..', 'vendor');
const src = path.join(vendor, 'aionui-base-src');
const dest = path.join(vendor, 'aionui-base');
const KNOWN = [
  ['AionUi.exe', '16360a60802c14b1842289362704b4c4731fe4db57fda3aad4346945c1dec6dc'],
  ['resources/app.asar', '95b6352bca6400e2990781398a0644f185e5b1b9f42706125ddeee21e72c7d73'],
  ['resources/bundled-aioncore/win32-x64/aioncore.exe', '67eb02774bab3855b759ec9756c2e540cd17b64b850407fa4b8bad07fd8a0892'],
];
const sha = (f, alg, enc) => { const h = crypto.createHash(alg); h.update(fs.readFileSync(f)); return h.digest(enc || 'hex'); };

function verifyBase() {
  return KNOWN.every(([f, want]) => { try { return sha(path.join(dest, f), 'sha256') === want; } catch (e) { return false; } });
}

(async () => {
  if (!process.argv.includes('--force') && verifyBase()) { console.log('vendor/aionui-base is already AionUi ' + VERSION + ' (all three files match).'); return; }
  fs.mkdirSync(src, { recursive: true });
  const exe = path.join(src, FILE);
  const yml = await (await fetch(URL_BASE + '/latest.yml')).text();
  const want = /sha512:\s*(\S+)/.exec(yml);
  if (!want || !new RegExp('version:\\s*' + VERSION.replace(/\./g, '\\.')).test(yml)) throw new Error('AionUi publishes another version than ' + VERSION + ' at ' + URL_BASE + '/latest.yml; the base needs that exact one');
  if (!fs.existsSync(exe) || sha(exe, 'sha512', 'base64') !== want[1]) {
    console.log('downloading ' + FILE + ' ...');
    const res = await fetch(URL_BASE + '/' + VERSION + '/' + FILE);
    if (!res.ok) throw new Error('download failed: HTTP ' + res.status);
    fs.writeFileSync(exe, Buffer.from(await res.arrayBuffer()));
  }
  if (sha(exe, 'sha512', 'base64') !== want[1]) throw new Error('the installer does not match the SHA-512 AionUi publishes');
  console.log('installer checked against the SHA-512 AionUi publishes');
  const tools = path.join(src, 'tools');
  const za = path.join(tools, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
  if (!fs.existsSync(za)) {
    fs.mkdirSync(tools, { recursive: true });
    if (!fs.existsSync(path.join(tools, 'package.json'))) fs.writeFileSync(path.join(tools, 'package.json'), '{"name":"aionui-base-tools","private":true}\n');
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const r = spawnSync(npm, ['install', '7zip-bin', '--no-audit', '--no-fund', '--silent'], { cwd: tools, stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true });
    if (r.status !== 0 || !fs.existsSync(za)) throw new Error('could not install 7zip-bin');
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const x = spawnSync(za, ['x', exe, '-o' + dest, '-y'], { stdio: 'inherit', windowsHide: true });
  if (x.status !== 0 && x.status !== 1) throw new Error('7za failed (exit ' + x.status + ')');
  for (const [f, w] of KNOWN) if (sha(path.join(dest, f), 'sha256') !== w) throw new Error(f + ' is not the file AionUi ' + VERSION + ' ships');
  console.log('vendor/aionui-base is AionUi ' + VERSION + ': AionUi.exe, app.asar and aioncore.exe match.');
})().catch((e) => { console.error('fetch-aionui-base: ' + e.message); process.exit(1); });
