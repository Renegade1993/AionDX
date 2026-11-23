#!/usr/bin/env node
/**
 * github-release.js - publishes a release of github.com/Renegade1993/AionDX with the sign-in git already has on this PC.
 * It makes a DRAFT (nobody sees it), uploads the assets, downloads each one back and compares its SHA-256 with the file, and only
 * then, with --publish, makes it public. Without --publish it stops at the draft.
 *
 *   node tools\github-release.js --tag v0.25.0-beta --title "AionDX beta v.25" --notes FILE --asset F [--asset F ...] [--prerelease] [--publish]
 *   ... --check-only        run the checks (committed and pushed; a what's-new pop-up for every new feature) and stop; GitHub is not touched
 *   ... --no-whats-new      a release with no feature a user sees; --allow-unpushed skips the committed-and-pushed check
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

// The code the installer was built from must be the code on GitHub: nothing tracked left uncommitted, and the branch pushed. On November 13th,
// 2026 a commit refused by the privacy hook went unnoticed and 0.27.5 was published over the 0.27.4 commit. --allow-unpushed skips this.
if (!args.includes('--allow-unpushed')) {
  const { execFileSync } = require('child_process');
  const git = (a) => execFileSync('git', a, { cwd: path.join(__dirname, '..'), encoding: 'utf8', windowsHide: true }).trim();
  // the click suite rewrites its own screenshots (tools\dx-harness\shots) on every run: pictures, not code
  const dirty = git(['status', '--porcelain', '--untracked-files=no', '--', 'patches', 'tools', ':(exclude)tools/dx-harness/shots']);
  if (dirty) { console.error('github-release: tracked changes are not committed (the commit was refused or never made):\n' + dirty.split('\n').slice(0, 10).join('\n')); process.exit(3); }
  git(['fetch', '-q', 'origin']);
  const head = git(['rev-parse', 'HEAD']), remote = git(['rev-parse', 'origin/main']);
  if (head !== remote) { console.error('github-release: HEAD ' + head.slice(0, 7) + ' is not what origin/main has (' + remote.slice(0, 7) + '); push first.'); process.exit(3); }
}

// Every new feature gets its pop-up for every user, until they press Got it (a rule since November 13th, 2026). Each top-level bullet under
// "## New" in the notes (its bold name) must be an item of WHATS_NEW in the renderer, and WHATS_NEW.release must be this version. A bullet
// that starts "For agents" is for agents, not a control a user sees, and is skipped. --no-whats-new skips the check (a release with no
// user-facing feature needs no "## New" section at all).
if (!args.includes('--no-whats-new')) {
  const notes = fs.readFileSync(notesFile, 'utf8').replace(/\r\n/g, '\n');
  const sec = /^## New\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(notes);
  if (sec) {
    // "- **Name** ..." or, without bold (the house style bans bold bullet intros), "- Name: ..."
    const wanted = [...sec[1].matchAll(/^- (?:\*\*([^*]+?)\*\*|([^:\n]{2,80}):\s)/gm)].map((m) => (m[1] || m[2]).replace(/[.:]$/, '').trim()).filter((n) => !/^For agents/i.test(n));
    const ui = fs.readFileSync(path.join(__dirname, '..', 'patches', '0001-renderer-dx', 'aiondx-ui.js'), 'utf8');
    // comment lines may come before release:, and date: follows it on the same line (0.28.5's check found no list, November 20th, 2026)
    const wn = /var WHATS_NEW = \{\s*(?:\/\/[^\n]*\n\s*)*release: '([^']+)',[^\n]*\n\s*items: \[([\s\S]*?)\n\s*\],/.exec(ui);
    const version = tag.replace(/^v/, '').replace(/-.*$/, '');
    const names = wn ? [...wn[2].matchAll(/\[\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].toLowerCase()) : [];
    const missing = wanted.filter((w) => !names.some((n) => n.length > 2 && (w.toLowerCase().includes(n) || n.includes(w.toLowerCase().split(':')[0]))));
    if (!wn || wn[1] !== version || missing.length) {
      console.error('github-release: every new feature needs its what\'s-new pop-up (WHATS_NEW in aiondx-ui.js) for this version.\n' +
        '  WHATS_NEW.release: ' + (wn ? wn[1] : 'not found') + ' (this release: ' + version + ')\n' +
        (missing.length ? '  no pop-up item for: ' + missing.join('; ') + '\n' : '') + '  (add them, or pass --no-whats-new for a release with no feature a user sees)');
      process.exit(4);
    }
  }
}

// The renderer's BUILD stamp changes with every release: agents read it (aiondx loop status) to know which AionDX they run, and it stayed
// 2026-11-13.1 through 0.27.10 and 0.27.11 (a team lead could not tell its build, November 15th). Compared with the newest earlier v* tag.
// --same-build allows it (a release with no renderer change).
const spawnGit = (a) => { try { return require('child_process').execFileSync('git', a, { cwd: path.join(__dirname, '..'), encoding: 'utf8', windowsHide: true, timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return ''; } };
if (!args.includes('--same-build')) {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'patches', '0001-renderer-dx', 'aiondx-ui.js'), 'utf8');
  const now = (/var BUILD = '([^']+)'/.exec(ui) || [])[1];
  spawnGit(['fetch', '--tags', '--quiet']);   // releases are tagged on GitHub; their tags may not be here yet
  const tags = spawnGit(['tag', '--list', 'v*', '--sort=-creatordate']).split('\n').map((t) => t.trim()).filter((t) => t && t !== tag);
  const prevTag = tags[0];
  if (prevTag) {
    const before = (/var BUILD = '([^']+)'/.exec(spawnGit(['show', prevTag + ':patches/0001-renderer-dx/aiondx-ui.js'])) || [])[1];
    if (now && before && now === before) {
      console.error('github-release: the renderer\'s BUILD (' + now + ') is the same as in ' + prevTag + '. Give this release its own (var BUILD in aiondx-ui.js), or pass --same-build when the renderer did not change.');
      process.exit(5);
    }
  }
}

// R-127: no release while an ask of this cycle is unaccounted for. The chat running this (AIONDX_CONVERSATION_ID, set in every AionDX
// chat) keeps the user's requests in its asks ledger (aiondx asks); any still open is listed and the release refused. --asks-ok overrides.
if (!args.includes('--asks-ok')) {
  const dataDir = process.env.AIONDX_DATA_DIR || path.join(process.env.APPDATA || '', 'AionDX');
  const conv = process.env.AIONDX_CONVERSATION_ID || '', team = process.env.AIONDX_TEAM_ID || '';
  const open = [];
  for (const k of [conv && 'c-' + conv, team && 't-' + team].filter(Boolean)) {
    try { for (const a of (JSON.parse(fs.readFileSync(path.join(dataDir, 'aiondx-asks', k + '.json'), 'utf8')).asks || [])) if (a.state === 'open') open.push(a); } catch (e) { /* no ledger */ }
  }
  if (open.length) {
    console.error('github-release: ' + open.length + ' ask' + (open.length === 1 ? ' is' : 's are') + ' still open in this chat\'s ledger. Build, defer (with the reason) or reject each first (aiondx asks mark ID ...):\n' +
      open.map((a) => '  #' + a.id + ' "' + String(a.words).slice(0, 160) + '"').join('\n') + '\nOr pass --asks-ok.');
    process.exit(6);
  }
}

// --check-only: the checks above, then stop before GitHub is touched (testing this tool once made a real draft release, November 13th).
if (args.includes('--check-only')) { console.log('github-release: checks passed for ' + tag + ' (--check-only: nothing sent to GitHub)'); process.exit(0); }

(async () => {
  for (const f of assets) if (!fs.existsSync(f)) throw new Error('no such file: ' + f);
  const repo = '/repos/' + OWNER + '/' + REPO;
  const existing = await api('GET', repo + '/releases?per_page=100');
  const had = existing.ok ? existing.json.find((r) => r.tag_name === tag) : null;
  // --resume: a draft an earlier run left (it stalled reading back, November 16th, 2026) is finished, not made again; its assets are
  // kept when they have the files' sizes, and everything is still read back and compared before publishing
  if (had && !(args.includes('--resume') && had.draft)) throw new Error('a release for ' + tag + ' already exists (draft or published); not touching it' + (had.draft ? ' (--resume finishes a draft)' : ''));
  let rel = had;
  if (!rel) {
    const created = await api('POST', repo + '/releases', { tag_name: tag, target_commitish: 'main', name: title, body: fs.readFileSync(notesFile, 'utf8'), draft: true, prerelease: args.includes('--prerelease') });
    if (!created.ok) throw new Error('could not create the draft: ' + created.status + ' ' + (created.json && created.json.message));
    rel = created.json;
    console.log('draft ' + rel.id + ' created for ' + tag);
  } else console.log('draft ' + rel.id + ' for ' + tag + ' resumed');
  const uploadBase = rel.upload_url.replace(/\{.*$/, '');
  for (const f of assets) {
    const name = path.basename(f);
    const size = fs.statSync(f).size;
    const there = (rel.assets || []).find((x) => x.name === name);
    if (there && there.size === size && there.state === 'uploaded') { console.log(name + ' is already on the draft (' + size + ' bytes)'); continue; }
    if (there) { const d = await api('DELETE', repo + '/releases/assets/' + there.id); if (!d.ok) throw new Error('could not replace ' + name + ' on the draft: ' + d.status); }
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
    // a stalled download ended both 0.28.1 and 0.28.2's first runs (no time limit): 20 minutes a try, three tries
    let got = null, lastErr = null;
    for (let attempt = 1; attempt <= 3 && got === null; attempt++) {
      try {
        const dl = await fetch(a.url, { headers: { Authorization: 'Bearer ' + token(), Accept: 'application/octet-stream', 'User-Agent': 'AionDX-release' }, redirect: 'follow', signal: AbortSignal.timeout(20 * 60000) });
        if (!dl.ok) throw new Error('status ' + dl.status);
        const h = crypto.createHash('sha256');
        for await (const chunk of dl.body) h.update(chunk);
        got = h.digest('hex');
      } catch (e) { lastErr = e; console.log('  reading ' + name + ' back failed (try ' + attempt + ' of 3): ' + (e && e.message || e)); }
    }
    if (got === null) throw new Error('could not read ' + name + ' back: ' + (lastErr && lastErr.message));
    const want = await sha(f);
    if (got !== want) throw new Error(name + ' came back different from what was sent');
    console.log('  ' + name + ' read back, SHA-256 ' + got.slice(0, 16) + '... matches');
  }
  if (!args.includes('--publish')) { console.log('draft left as it is (no --publish): ' + rel.html_url); return; }
  const pub = await api('PATCH', repo + '/releases/' + rel.id, { draft: false, prerelease: args.includes('--prerelease') });
  if (!pub.ok) throw new Error('could not publish: ' + pub.status + ' ' + (pub.json && pub.json.message));
  console.log('published: ' + pub.json.html_url);
})().catch((e) => { console.error('github-release: ' + e.message); process.exit(1); });
