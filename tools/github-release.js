#!/usr/bin/env node
/**
 * github-release.js - publishes a release of github.com/Renegade1993/AionDX with the sign-in git already has on this PC.
 * It makes a DRAFT (nobody sees it), uploads the assets, downloads each one back and compares its SHA-256 with the file, and only
 * then, with --publish, makes it public. Without --publish it stops at the draft.
 *
 *   node tools\github-release.js --tag v0.25.0-beta --title "AionDX beta v.25" --notes FILE --asset F [--asset F ...] [--prerelease] [--publish]
 *
 * The update check in the app reads the published releases for an asset named AionDX-<semver>-setup.exe and the release's
 * SHA256SUMS.txt, so both go up together. Refuses when the tag already has a release.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { api, token, OWNER, REPO } = require('./github-api');

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const many = (n) => args.reduce((a, x, i) => (x === n ? a.concat(args[i + 1]) : a), []);
const tag = opt('--tag'), title = opt('--title'), notesFile = opt('--notes'), assets = many('--asset');
if (!tag || !title || !notesFile || !assets.length) { console.error('usage: node tools\\github-release.js --tag T --title TITLE --notes FILE --asset FILE [--asset FILE ...] [--prerelease] [--publish]'); process.exit(2); }
const sha = (f) => new Promise((resolve, reject) => { const h = crypto.createHash('sha256'); fs.createReadStream(f).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex'))); });

(async () => {
  for (const f of assets) if (!fs.existsSync(f)) throw new Error('no such file: ' + f);
  const repo = '/repos/' + OWNER + '/' + REPO;
  const existing = await api('GET', repo + '/releases?per_page=100');
  if (existing.ok && existing.json.some((r) => r.tag_name === tag)) throw new Error('a release for ' + tag + ' already exists (draft or published); not touching it');
  const created = await api('POST', repo + '/releases', { tag_name: tag, target_commitish: 'main', name: title, body: fs.readFileSync(notesFile, 'utf8'), draft: true, prerelease: args.includes('--prerelease') });
  if (!created.ok) throw new Error('could not create the draft: ' + created.status + ' ' + (created.json && created.json.message));
  const rel = created.json;
  console.log('draft ' + rel.id + ' created for ' + tag);
  const uploadBase = rel.upload_url.replace(/\{.*$/, '');
  for (const f of assets) {
    const name = path.basename(f);
    const size = fs.statSync(f).size;
    console.log('uploading ' + name + ' (' + (size / 1048576).toFixed(1) + ' MB) ...');
    const res = await fetch(uploadBase + '?name=' + encodeURIComponent(name), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token(), Accept: 'application/vnd.github+json', 'User-Agent': 'AionDX-release', 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
      body: fs.createReadStream(f), duplex: 'half',
    });
    const j = await res.json().catch(() => null);
    if (!res.ok) throw new Error('upload of ' + name + ' failed: ' + res.status + ' ' + (j && j.message));
    if (j.size !== size) throw new Error(name + ': GitHub stored ' + j.size + ' bytes, the file has ' + size);
    console.log('  stored, ' + j.size + ' bytes');
  }
  // Read every asset back from the draft and compare.
  const back = await api('GET', repo + '/releases/' + rel.id);
  for (const f of assets) {
    const name = path.basename(f);
    const a = back.json.assets.find((x) => x.name === name);
    if (!a) throw new Error(name + ' is not on the draft');
    const dl = await fetch(a.url, { headers: { Authorization: 'Bearer ' + token(), Accept: 'application/octet-stream', 'User-Agent': 'AionDX-release' }, redirect: 'follow' });
    if (!dl.ok) throw new Error('could not read ' + name + ' back: ' + dl.status);
    const h = crypto.createHash('sha256');
    for await (const chunk of dl.body) h.update(chunk);
    const got = h.digest('hex'), want = await sha(f);
    if (got !== want) throw new Error(name + ' came back different from what was sent');
    console.log('  ' + name + ' read back, SHA-256 ' + got.slice(0, 16) + '... matches');
  }
  if (!args.includes('--publish')) { console.log('draft left as it is (no --publish): ' + rel.html_url); return; }
  const pub = await api('PATCH', repo + '/releases/' + rel.id, { draft: false, prerelease: args.includes('--prerelease') });
  if (!pub.ok) throw new Error('could not publish: ' + pub.status + ' ' + (pub.json && pub.json.message));
  console.log('published: ' + pub.json.html_url);
})().catch((e) => { console.error('github-release: ' + e.message); process.exit(1); });
