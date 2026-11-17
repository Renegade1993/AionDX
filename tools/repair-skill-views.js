'use strict';
// repair-skill-views.js - turns every chat's skill view (<data>\aionui\session-skills\<user>\<chat>\skills\<name>) from a junction into
// a real folder of hard links to the skill's files (a copy where a hard link cannot be made), the way core-0022 builds views. For an
// AionDX before 0.28.3: an agent under Windows' RedirectionGuard cannot follow a junction, so it saw none of its skills. AionCore keeps a
// view whose names match the chat's skills, so the repaired view stays until the chat's skill list changes.
//   node tools\repair-skill-views.js [--data <AionDX data folder>] [--go]      (without --go it only says what it would do)
// Only junctions are touched; a junction is removed as a link (its target is never entered) after its files are in place beside it.
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const GO = argv.includes('--go');
const data = opt('--data') || path.join(process.env.APPDATA || '', 'AionDX');
const root = path.join(data, 'aionui', 'session-skills');
const SKIP = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv']);
const deadline = Date.now() + 10 * 60 * 1000;

function isJunction(p) { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } }
function mirror(src, dst, depth) {
  fs.mkdirSync(dst, { recursive: true });
  if (depth > 16) return 0;
  let n = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(e.name.toLowerCase())) continue;
    const from = path.join(src, e.name), to = path.join(dst, e.name);
    const st = fs.statSync(from);
    if (st.isDirectory()) n += mirror(from, to, depth + 1);
    else if (st.isFile()) {
      try { fs.linkSync(from, to); } catch { fs.copyFileSync(from, to); fs.utimesSync(to, st.atime, st.mtime); }
      n++;
    }
  }
  return n;
}

const out = { views: 0, junctions: 0, repaired: 0, files: 0, skipped: [], failed: [] };
let users = [];
try { users = fs.readdirSync(root); } catch { console.log(JSON.stringify({ ok: false, error: 'No skill views at ' + root })); process.exit(1); }
for (const u of users) {
  let convs = [];
  try { convs = fs.readdirSync(path.join(root, u)); } catch { continue; }
  for (const c of convs) {
    if (Date.now() > deadline) { out.failed.push('stopped at the 10-minute limit'); break; }
    const skills = path.join(root, u, c, 'skills');
    let names = [];
    try { names = fs.readdirSync(skills); } catch { continue; }
    out.views++;
    for (const n of names) {
      const link = path.join(skills, n);
      if (!isJunction(link)) continue;
      out.junctions++;
      let target;
      try { target = fs.readlinkSync(link); } catch (e) { out.failed.push(link + ': ' + e.message); continue; }
      target = target.replace(/^\\\\\?\\/, '');
      if (!fs.existsSync(path.join(target, 'SKILL.md'))) { out.skipped.push(link + ' -> ' + target + ' (no SKILL.md there)'); continue; }
      if (!GO) continue;
      const tmp = link + '.aiondx-new';
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
        const files = mirror(target, tmp, 0);
        fs.rmdirSync(link);            // the junction itself; its target is not entered
        fs.renameSync(tmp, link);
        out.repaired++; out.files += files;
      } catch (e) {
        out.failed.push(link + ': ' + e.message);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* left */ }
        if (!fs.existsSync(link)) { try { fs.symlinkSync(target, link, 'junction'); } catch { /* the core rebuilds it at the chat's next start */ } }
      }
    }
  }
}
console.log(JSON.stringify(Object.assign({ ok: !out.failed.length, go: GO }, out), null, 1));
process.exit(out.failed.length ? 1 : 0);
