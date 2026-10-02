#!/usr/bin/env node
/**
 * github-api.js - the few GitHub calls the release needs, using the sign-in git already has on this PC (Git Credential Manager):
 * no token is typed, stored or printed. Used by tools\github-release.js; run alone it answers one read-only question.
 *
 *   node tools\github-api.js repo            visibility, default branch, and the releases the repository has
 */
'use strict';
const { spawnSync } = require('child_process');

const SLUG = 'Renegade1993/AionDX';
const [OWNER, REPO] = SLUG.split('/');

function token() {
  const r = spawnSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const m = /^password=(.+)$/m.exec(r.stdout || '');
  if (r.status !== 0 || !m) throw new Error('git has no GitHub sign-in on this PC');
  return m[1].trim();
}
async function api(method, url, body, extra) {
  const res = await fetch(url.startsWith('http') ? url : 'https://api.github.com' + url, Object.assign({
    method,
    headers: Object.assign({ Authorization: 'Bearer ' + token(), Accept: 'application/vnd.github+json', 'User-Agent': 'AionDX-release', 'X-GitHub-Api-Version': '2022-11-28' },
      body && typeof body === 'object' && !(body instanceof Buffer) && !body.pipe ? { 'Content-Type': 'application/json' } : {}),
    body: body && typeof body === 'object' && !(body instanceof Buffer) && !body.pipe ? JSON.stringify(body) : body,
  }, extra || {}));
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: res.status, ok: res.ok, json, text };
}
module.exports = { api, token, OWNER, REPO };

if (require.main === module) {
  (async () => {
    if (process.argv[2] === 'repo') {
      const r = await api('GET', '/repos/' + OWNER + '/' + REPO);
      if (!r.ok) { console.log('status ' + r.status + ': ' + (r.json && r.json.message)); return; }
      console.log('repository ' + r.json.full_name + ': ' + (r.json.private ? 'PRIVATE' : 'public') + ', default branch ' + r.json.default_branch + ', pushed ' + r.json.pushed_at);
      const rel = await api('GET', '/repos/' + OWNER + '/' + REPO + '/releases');
      console.log('releases: ' + (Array.isArray(rel.json) ? rel.json.map((x) => x.tag_name + (x.draft ? ' (draft)' : '')).join(', ') || 'none' : 'status ' + rel.status));
    } else console.log('usage: node tools\\github-api.js repo');
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
