'use strict';
/* rehome.js - after a restore under another Windows account, points every stored path at the new user folder.
 *
 *   node rehome.js --from "<old user folder>" --to "<new user folder>" --root DIR [--root DIR ...] [--root-file FILE ...] [--db FILE ...] [--dry]
 *
 * What it changes, under each --root (links are never followed):
 *   - text files: every form of the old user folder followed by a separator or the end of a string:
 *       as written, JSON-escaped (doubled backslashes), with forward slashes, Git Bash style (/x/...), and Claude Code's folder key
 *       (the path with every character that is not a letter or a digit turned into a dash)
 *     case-insensitive. The user name on its own (in a team name, a sentence) is never touched. Files with a NUL byte are binary and are skipped,
 *     except UTF-16 text with a byte-order mark. Files over 64 MB (long transcripts) are rewritten line by line.
 *   - folder names: Claude Code keeps a folder per working folder, named after its path in that dash form; those are renamed
 *     (and merged into one of the new name if both exist).
 * And in each --db (SQLite): every text value in every table, the same rules.
 * Prints a summary as JSON on the last line. --dry changes nothing. */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const all = (n) => args.reduce((a, v, i) => (v === n && args[i + 1] ? a.concat(args[i + 1]) : a), []);
const FROM = path.resolve(opt('--from') || ''), TO = path.resolve(opt('--to') || '');
const ROOTS = all('--root'), FILES = all('--root-file'), DBS = all('--db'), DRY = args.includes('--dry');
if (!opt('--from') || !opt('--to')) { console.error('usage: node rehome.js --from OLD --to NEW --root DIR [--db FILE] [--dry]'); process.exit(2); }
const BIG = 64 * 1024 * 1024;
const BINARY_EXT = new Set(['.exe', '.dll', '.node', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.zip', '.7z', '.gz', '.tgz', '.xz', '.br', '.db', '.sqlite', '.wasm', '.pdf', '.woff', '.woff2', '.ttf', '.otf', '.pak', '.bin', '.dat', '.lnk', '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.jar', '.pyc', '.msi', '.cab', '.pdb', '.lib', '.a', '.so', '.dylib']);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const enc = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');           // Claude Code's folder key for a path
const fromParts = FROM.split('\\'), toParts = TO.split('\\');
const fromDrive = fromParts[0].replace(':', ''), toDrive = toParts[0].replace(':', '');
const fromRest = fromParts.slice(1), toRest = toParts.slice(1);
// [regex, replacement]; each regex ends at a separator or a string's end, so a user folder never matches a longer name that starts with it
const END = '(?=[\\\\/"\'`\\s;,:.…)\\]}<>|*?]|$)';      // a separator, a quote, a full stop or an ellipsis, or the end
const forms = [
  [fromParts.join('\\\\'), toParts.join('\\\\')],                              // JSON-escaped
  [fromParts.join('\\'), toParts.join('\\')],                                  // as written
  [fromParts.join('/'), toParts.join('/')],                                    // forward slashes
  ['/' + fromDrive.toLowerCase() + '/' + fromRest.join('/'), '/' + toDrive.toLowerCase() + '/' + toRest.join('/')],   // Git Bash
];
const rules = forms.map(([f, t]) => [new RegExp(esc(f) + END, 'gi'), t]);
rules.push([new RegExp(esc(enc(FROM)) + '(?=-|$|["\\\\/])', 'gi'), enc(TO)]);   // Claude Code's folder key
const needles = forms.map(([f]) => f.toLowerCase()).concat([enc(FROM).toLowerCase()]);
const hasNeedle = (s) => { const l = s.toLowerCase(); return needles.some((n) => l.includes(n)); };
const rewrite = (s) => { let o = s; for (const [re, t] of rules) o = o.replace(re, () => t); return o; };

const sum = { from: FROM, to: TO, dry: DRY, filesScanned: 0, filesChanged: 0, bigFilesChanged: 0, foldersRenamed: 0, foldersMerged: 0, dbValuesChanged: 0, errors: [] };
if (FROM.toLowerCase() === TO.toLowerCase()) { sum.note = 'same user folder: nothing to do'; console.log(JSON.stringify(sum)); process.exit(0); }

function isBinary(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return false;    // UTF-16 LE text
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

async function rewriteBig(file) {
  const tmp = file + '.rehome-tmp';
  let changed = false;
  await new Promise((resolve, reject) => {
    const out = DRY ? null : fs.createWriteStream(tmp);
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    let first = true;
    rl.on('line', (line) => {
      const n = hasNeedle(line) ? rewrite(line) : line;
      if (n !== line) changed = true;
      if (out) { out.write((first ? '' : '\n') + n); first = false; }
    });
    rl.on('close', () => { if (out) out.end(resolve); else resolve(); });
    rl.on('error', reject);
  });
  if (DRY) return changed;
  if (changed) {
    // keep a final newline if the original had one
    const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(1); const st = fs.fstatSync(fd);
    if (st.size > 0) fs.readSync(fd, b, 0, 1, st.size - 1); fs.closeSync(fd);
    if (b[0] === 0x0a) fs.appendFileSync(tmp, '\n');
    fs.renameSync(tmp, file);
  } else fs.rmSync(tmp, { force: true });
  return changed;
}

async function rewriteFile(file, st) {
  sum.filesScanned++;
  if (BINARY_EXT.has(path.extname(file).toLowerCase())) return;
  try {
    if (st.size > BIG) {
      const fd = fs.openSync(file, 'r'); const head = Buffer.alloc(8192); const n = fs.readSync(fd, head, 0, 8192, 0); fs.closeSync(fd);
      if (isBinary(head.subarray(0, n))) return;
      if (await rewriteBig(file)) { sum.filesChanged++; sum.bigFilesChanged++; }
      return;
    }
    const buf = fs.readFileSync(file);
    if (isBinary(buf)) return;
    const utf16 = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe;
    const text = utf16 ? buf.subarray(2).toString('utf16le') : buf.toString('utf8');
    if (!hasNeedle(text)) return;
    const out = rewrite(text);
    if (out === text) return;
    sum.filesChanged++;
    if (DRY) return;
    const data = utf16 ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(out, 'utf16le')]) : Buffer.from(out, 'utf8');
    fs.writeFileSync(file, data);
    try { fs.utimesSync(file, st.atime, st.mtime); } catch (e) { /* keep going */ }
  } catch (e) { sum.errors.push(file + ': ' + e.message); }
}

/** Moves everything from a into b (b wins nothing: a file already in b is kept, a's copy is dropped only if identical in size). */
function mergeInto(a, b) {
  for (const ent of fs.readdirSync(a, { withFileTypes: true })) {
    const s = path.join(a, ent.name), d = path.join(b, ent.name);
    if (ent.isDirectory()) { if (!fs.existsSync(d)) fs.renameSync(s, d); else mergeInto(s, d); }
    else if (!fs.existsSync(d)) fs.renameSync(s, d);
    else { const x = fs.statSync(s), y = fs.statSync(d); if (x.mtimeMs > y.mtimeMs) { fs.rmSync(d); fs.renameSync(s, d); } }
  }
  try { fs.rmSync(a, { recursive: true, force: true }); } catch (e) { /* in use */ }
}

async function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { sum.errors.push(dir + ': ' + e.message); return; }
  for (const ent of entries) {
    let p = path.join(dir, ent.name);
    let st; try { st = fs.lstatSync(p); } catch (e) { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      const renamed = rewrite(ent.name);
      if (renamed !== ent.name && enc(ent.name) === ent.name) {      // only Claude-style folder keys (letters, digits and dashes)
        const q = path.join(dir, renamed);
        if (!DRY) { try { if (fs.existsSync(q)) { mergeInto(p, q); sum.foldersMerged++; } else fs.renameSync(p, q); p = q; } catch (e) { sum.errors.push(p + ': ' + e.message); } }
        sum.foldersRenamed++;
      }
      await walk(p);
    } else if (st.isFile()) await rewriteFile(p, st);
  }
}

function rehomeDb(file) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: DRY, timeout: 60000 });
  const tables = db.prepare("select name, sql from sqlite_master where type='table' and name not like 'sqlite_%'").all();
  if (!DRY) db.exec('BEGIN');
  try {
    for (const { name, sql } of tables) {
      if (/without\s+rowid/i.test(sql || '')) { sum.errors.push('table ' + name + ' has no rowid; skipped'); continue; }
      const cols = db.prepare('pragma table_info("' + name.replace(/"/g, '""') + '")').all().map((c) => c.name);
      for (const col of cols) {
        const q = '"' + col.replace(/"/g, '""') + '"', t = '"' + name.replace(/"/g, '""') + '"';
        const where = needles.map(() => 'instr(lower(' + q + '), ?) > 0').join(' or ');
        const rows = db.prepare('select rowid as r, ' + q + ' as v from ' + t + " where typeof(" + q + ") = 'text' and (" + where + ')').all(...needles);
        if (!rows.length) continue;
        const upd = DRY ? null : db.prepare('update ' + t + ' set ' + q + ' = ? where rowid = ?');
        for (const { r, v } of rows) { const n = rewrite(v); if (n !== v) { sum.dbValuesChanged++; if (upd) upd.run(n, r); } }
      }
    }
    if (!DRY) db.exec('COMMIT');
  } catch (e) { if (!DRY) db.exec('ROLLBACK'); throw e; }
  db.close();
}

(async () => {
  const t0 = Date.now();
  for (const r of ROOTS) if (fs.existsSync(r)) await walk(path.resolve(r));
  for (const f of FILES) { try { const st = fs.lstatSync(f); if (st.isFile()) await rewriteFile(path.resolve(f), st); } catch (e) { /* not there */ } }
  for (const d of DBS) { try { if (fs.existsSync(d)) rehomeDb(d); } catch (e) { sum.errors.push(d + ': ' + e.message); } }
  sum.seconds = Math.round((Date.now() - t0) / 1000);
  console.log(JSON.stringify(sum));
  process.exit(sum.errors.filter((e) => !/no rowid/.test(e)).length ? 1 : 0);
})().catch((e) => { console.log(JSON.stringify({ ...sum, fatal: String(e && e.stack || e) })); process.exit(2); });
