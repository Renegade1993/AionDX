#!/usr/bin/env node
/**
 * test-migrate.js - `aiondx migrate`: the move from AionUi to AionDX (Loop tool 1.12.0), against a made-up AionUi in a temp folder.
 *
 * Builds the tool from aiondx-loop.cs, builds a stand-in for AionUi's NSIS uninstaller (it takes /S, /allusers or /currentuser and
 * _?=<folder> as the real one does, and removes the program files), and runs `migrate run --dir ... --data ...` against a fake install
 * and a fake data folder. Every call names --dir and --data, so nothing here can reach a real AionUi or the real %APPDATA%\AionUi.
 * The one call without them, `migrate detect`, only reads.
 *
 *   node patches\0007-loop-tool\test-migrate.js
 *
 * 180 s deadline.
 */
'use strict';
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const deadline = setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 180000);
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-migrate-test-'));
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) { pass++; console.log('PASS  ' + name); } else { fail++; console.log('FAIL  ' + name + (detail !== undefined ? '   [' + String(detail).slice(0, 1200) + ']' : '')); } };
const children = [];
const cleanup = () => { children.forEach((c) => { try { c.kill(); } catch (e) { /* gone */ } }); try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) { /* best effort */ } };
process.on('exit', cleanup);

function compile(src, out, target) {
  const r = spawnSync(CSC, ['/nologo', '/optimize+', '/target:' + target, '/platform:x64', '/r:System.Web.Extensions.dll', '/out:' + out, src], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) { console.log(r.stdout + r.stderr); process.exit(1); }
}

// ---- the programs
const TOOL = path.join(ROOT, 'aiondx.exe');
compile(path.join(__dirname, 'aiondx-loop.cs'), TOOL, 'exe');
const fakeSrc = path.join(ROOT, 'fake-uninstall.cs');
fs.writeFileSync(fakeSrc, `
using System; using System.IO; using System.Linq;
static class P {
  static int Main(string[] a) {
    string log = Environment.GetEnvironmentVariable("FAKE_UNINSTALL_LOG");
    if (log != null) File.AppendAllText(log, string.Join(" ", a) + "\\n");
    string last = a.Length > 0 ? a[a.Length - 1] : "";
    if (!last.StartsWith("_?=")) return 9;
    string dir = last.Substring(3);
    string exit = Environment.GetEnvironmentVariable("FAKE_UNINSTALL_EXIT");
    if (exit != null && exit != "0") return int.Parse(exit);
    string self = System.Reflection.Assembly.GetExecutingAssembly().Location;
    foreach (var f in Directory.GetFiles(dir)) if (!string.Equals(f, self, StringComparison.OrdinalIgnoreCase)) File.Delete(f);
    foreach (var d in Directory.GetDirectories(dir)) Directory.Delete(d, true);
    string kill = Environment.GetEnvironmentVariable("FAKE_UNINSTALL_DELETE_DB");
    if (kill != null && File.Exists(kill)) File.Delete(kill);
    return 0;
  }
}`);
const FAKE_UNINSTALLER = path.join(ROOT, 'fake-uninstall.exe');
compile(fakeSrc, FAKE_UNINSTALLER, 'exe');

// ---- a fake AionUi and its data
function makeAionUi(name) {
  const dir = path.join(ROOT, name, 'AionUi');
  fs.mkdirSync(path.join(dir, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'AionUi.exe'), 'not a real program');
  fs.writeFileSync(path.join(dir, 'resources', 'app.asar'), 'x');
  fs.copyFileSync(FAKE_UNINSTALLER, path.join(dir, 'Uninstall AionUi.exe'));
  return dir;
}
function makeData(name) {
  const d = path.join(ROOT, name, 'data');
  fs.mkdirSync(path.join(d, 'aionui', 'assistant-rules'), { recursive: true });
  fs.mkdirSync(path.join(d, 'config'), { recursive: true });
  fs.mkdirSync(path.join(d, 'Local Storage', 'leveldb'), { recursive: true });
  fs.mkdirSync(path.join(d, 'Cache'), { recursive: true });
  fs.writeFileSync(path.join(d, 'aionui', 'aionui-backend.db'), crypto.randomBytes(3 * 1024 * 1024));
  fs.writeFileSync(path.join(d, 'aionui', 'aionui-backend.db-wal'), crypto.randomBytes(4096));
  fs.writeFileSync(path.join(d, 'aionui', 'aionui-backend.db.bak-old'), crypto.randomBytes(2048));
  fs.writeFileSync(path.join(d, 'aionui', 'assistant-rules', 'mine.md'), 'my rules');
  fs.writeFileSync(path.join(d, 'config', 'settings.json'), '{"a":1}');
  fs.writeFileSync(path.join(d, 'Local Storage', 'leveldb', '000003.log'), 'ls');
  fs.writeFileSync(path.join(d, 'Cache', 'junk.bin'), crypto.randomBytes(1000));
  fs.writeFileSync(path.join(d, 'Preferences'), '{}');
  return d;
}
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const run = (args, env) => spawnSync(TOOL, args, { encoding: 'utf8', windowsHide: true, env: Object.assign({}, process.env, env || {}), timeout: 60000 });
const kv = (file) => { const o = {}; if (fs.existsSync(file)) fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((l) => { const i = l.indexOf('='); if (i > 0) o[l.slice(0, i)] = l.slice(i + 1); }); return o; };

// ---- detect
{
  const dir = makeAionUi('detect'), data = makeData('detect');
  let r = run(['migrate', 'detect', '--dir', dir, '--uninstaller', path.join(dir, 'Uninstall AionUi.exe'), '--data', data]);
  const o = {}; r.stdout.split(/\r?\n/).forEach((l) => { const i = l.indexOf('='); if (i > 0) o[l.slice(0, i)] = l.slice(i + 1); });
  check('detect finds an AionUi folder it is given, with its uninstaller, scope and data folder', r.status === 0 && o.found === '1' && o.dir === dir && o.scope === 'user' && /Uninstall AionUi\.exe$/.test(o.uninstaller) && o.data === data, r.stdout);
  check('and says how big the chats database is and what a backup would hold', Number(o.dbBytes) === 3 * 1024 * 1024 && Number(o.backupBytes) > 3 * 1024 * 1024 && Number(o.backupBytes) < 3 * 1024 * 1024 + 20000, r.stdout);
  r = run(['migrate', 'detect', '--dir', path.join(ROOT, 'nothing-here'), '--data', data]);
  check('a folder with no AionUi.exe is not an install', /^found=0/m.test(r.stdout), r.stdout);
  r = run(['migrate', 'detect']);
  check('with no arguments it only reads: it reports on this PC and changes nothing', r.status === 0 && /^found=[01]/m.test(r.stdout) && /^data=/m.test(r.stdout), r.stdout + r.stderr);
}

// ---- the move
{
  const dir = makeAionUi('move'), data = makeData('move'), backup = path.join(ROOT, 'move', 'backup'), log = path.join(ROOT, 'move', 'uninstall.log'), rf = path.join(ROOT, 'move', 'result.txt');
  const dbBefore = sha(path.join(data, 'aionui', 'aionui-backend.db'));
  const r = run(['migrate', 'run', '--dir', dir, '--uninstaller', path.join(dir, 'Uninstall AionUi.exe'), '--data', data, '--backup-dir', backup, '--no-elevate', '--result', rf, '--log', path.join(ROOT, 'move', 'run.log')], { FAKE_UNINSTALL_LOG: log });
  const res = kv(rf);
  check('migrate run backs up, removes AionUi, and reports it moved, exit 0', r.status === 0 && res.status === 'migrated' && /^AionUi .* was removed\. Your chats and settings in .* stay, and AionDX opens them\./.test(res.message), r.stdout + r.stderr + JSON.stringify(res));
  check("AionUi's own uninstaller ran silently, for this user, in place", fs.existsSync(log) && /^\/S \/currentuser _\?=.*AionUi\s*$/m.test(fs.readFileSync(log, 'utf8')), fs.existsSync(log) && fs.readFileSync(log, 'utf8'));
  check('the program is gone, its uninstaller and folder with it', !fs.existsSync(path.join(dir, 'AionUi.exe')) && !fs.existsSync(dir));
  check('the chats database is untouched, byte for byte', sha(path.join(data, 'aionui', 'aionui-backend.db')) === dbBefore);
  check('the backup holds the database (checked by hash), its journal, the settings, the custom assistants and the preferences',
    sha(path.join(backup, 'aionui', 'aionui-backend.db')) === dbBefore && fs.existsSync(path.join(backup, 'aionui', 'aionui-backend.db-wal')) && fs.existsSync(path.join(backup, 'config', 'settings.json')) &&
    fs.existsSync(path.join(backup, 'aionui', 'assistant-rules', 'mine.md')) && fs.existsSync(path.join(backup, 'Local Storage', 'leveldb', '000003.log')) && fs.existsSync(path.join(backup, 'Preferences')));
  check('and leaves out caches and the older database copies', !fs.existsSync(path.join(backup, 'Cache')) && !fs.existsSync(path.join(backup, 'aionui', 'aionui-backend.db.bak-old')));
  const man = JSON.parse(fs.readFileSync(path.join(backup, 'backup.json'), 'utf8'));
  check('backup.json lists what was copied, with sizes and the database hash', man.schema === 'aiondx.migration-backup/1' && man.files.some((f) => /aionui-backend\.db$/.test(f.path) && f.sha256 === dbBefore), JSON.stringify(man).slice(0, 300));
  check('the log records the steps', /backing up/.test(fs.readFileSync(path.join(ROOT, 'move', 'run.log'), 'utf8')) && /chats database is intact/.test(fs.readFileSync(path.join(ROOT, 'move', 'run.log'), 'utf8')));
  let v = run(['migrate', 'verify', '--backup', backup, '--data', data]);
  check('verify says the data folder matches the backup', v.status === 0 && /matches the backup/.test(v.stdout), v.stdout);
  fs.appendFileSync(path.join(data, 'aionui', 'aionui-backend.db'), 'x');
  v = run(['migrate', 'verify', '--backup', backup, '--data', data]);
  check('and says so, exit 7, when the database has changed', v.status === 7 && /differs from the backup/.test(v.stdout), v.stdout);
}

// ---- without a backup
{
  const dir = makeAionUi('nobackup'), data = makeData('nobackup'), rf = path.join(ROOT, 'nobackup', 'result.txt');
  const r = run(['migrate', 'run', '--dir', dir, '--uninstaller', path.join(dir, 'Uninstall AionUi.exe'), '--data', data, '--no-backup', '--no-elevate', '--result', rf]);
  check('--no-backup moves without copying, and still checks the database afterwards', r.status === 0 && kv(rf).status === 'migrated' && /no backup, as asked/.test(r.stdout) && /chats database is intact/.test(r.stdout) && !/is in /.test(kv(rf).message), r.stdout + JSON.stringify(kv(rf)));
}

// ---- things that go wrong
{
  // The backup cannot be made: nothing is removed.
  let dir = makeAionUi('nobackupdir'), data = makeData('nobackupdir'), rf = path.join(ROOT, 'nobackupdir', 'result.txt'), log = path.join(ROOT, 'nobackupdir', 'u.log');
  const notADir = path.join(ROOT, 'nobackupdir', 'a-file'); fs.writeFileSync(notADir, 'x');
  let r = run(['migrate', 'run', '--dir', dir, '--uninstaller', path.join(dir, 'Uninstall AionUi.exe'), '--data', data, '--backup-dir', path.join(notADir, 'sub'), '--no-elevate', '--result', rf], { FAKE_UNINSTALL_LOG: log });
  check('a backup that cannot be made stops everything: exit 5, AionUi untouched, uninstaller never run', r.status === 5 && kv(rf).status === 'backup-failed' && /AionUi was not touched/.test(kv(rf).message) &&
    fs.existsSync(path.join(dir, 'AionUi.exe')) && !fs.existsSync(log), r.stdout + JSON.stringify(kv(rf)));

  // AionUi is running.
  dir = makeAionUi('running'); data = makeData('running'); rf = path.join(ROOT, 'running', 'result.txt');
  fs.copyFileSync(process.execPath, path.join(dir, 'AionUi.exe'));
  const live = spawn(path.join(dir, 'AionUi.exe'), ['-e', 'setTimeout(()=>{},60000)'], { windowsHide: true, stdio: 'ignore' });
  children.push(live);
  const t0 = Date.now(); while (Date.now() - t0 < 1000) { /* let it start */ }
  r = run(['migrate', 'run', '--dir', dir, '--uninstaller', path.join(dir, 'Uninstall AionUi.exe'), '--data', data, '--no-backup', '--no-elevate', '--result', rf]);
  check('a running AionUi is not touched: exit 4, and it says to close it', r.status === 4 && kv(rf).status === 'running' && /Close it/.test(kv(rf).message) && fs.existsSync(path.join(dir, 'Uninstall AionUi.exe')), r.stdout + JSON.stringify(kv(rf)));
  live.kill();

  // The uninstaller fails.
  dir = makeAionUi('uninstfail'); data = makeData('uninstfail'); rf = path.join(ROOT, 'uninstfail', 'result.txt');
  const backup = path.join(ROOT, 'uninstfail', 'backup');
  r = run(['migrate', 'run', '--dir', dir, '--uninstaller', path.join(dir, 'Uninstall AionUi.exe'), '--data', data, '--backup-dir', backup, '--no-elevate', '--result', rf], { FAKE_UNINSTALL_EXIT: '1' });
  check("a failing uninstaller: exit 6, the chats not touched, and the backup named", r.status === 6 && kv(rf).status === 'uninstall-failed' && /exit code 1/.test(kv(rf).message) &&
    new RegExp('the backup is in ' + backup.replace(/[\\.]/g, '\\$&')).test(kv(rf).message) && fs.existsSync(path.join(data, 'aionui', 'aionui-backend.db')), r.stdout + JSON.stringify(kv(rf)));

  // The removal takes the database with it.
  dir = makeAionUi('lost'); data = makeData('lost'); rf = path.join(ROOT, 'lost', 'result.txt');
  const b2 = path.join(ROOT, 'lost', 'backup');
  r = run(['migrate', 'run', '--dir', dir, '--uninstaller', path.join(dir, 'Uninstall AionUi.exe'), '--data', data, '--backup-dir', b2, '--no-elevate', '--result', rf], { FAKE_UNINSTALL_DELETE_DB: path.join(data, 'aionui', 'aionui-backend.db') });
  check('a removal that damages the chats is caught: exit 7, and the backup is named so they can be put back', r.status === 7 && kv(rf).status === 'data-changed' && /is missing/.test(kv(rf).message) && kv(rf).backup === b2 && fs.existsSync(path.join(b2, 'aionui', 'aionui-backend.db')), r.stdout + JSON.stringify(kv(rf)));

  // Nothing to remove.
  rf = path.join(ROOT, 'none-result.txt');
  r = run(['migrate', 'run', '--dir', path.join(ROOT, 'no-aionui-here'), '--data', makeData('none'), '--no-elevate', '--result', rf]);
  check('no AionUi: exit 2, the chats stay where they are', r.status === 2 && kv(rf).status === 'not-found' && /nothing to remove/.test(kv(rf).message), r.stdout + JSON.stringify(kv(rf)));

  // A new AionUi with no chats yet.
  dir = makeAionUi('nochats'); rf = path.join(ROOT, 'nochats', 'result.txt');
  fs.mkdirSync(path.join(ROOT, 'nochats', 'data'), { recursive: true });
  r = run(['migrate', 'run', '--dir', dir, '--uninstaller', path.join(dir, 'Uninstall AionUi.exe'), '--data', path.join(ROOT, 'nochats', 'data'), '--no-elevate', '--result', rf]);
  check('an AionUi with no chats database moves with nothing to back up', r.status === 0 && /nothing to back up/.test(r.stdout) && kv(rf).status === 'migrated', r.stdout + JSON.stringify(kv(rf)));
}

// ---- the shell form
{
  const r = run(['migrate', 'nonsense']);
  check('an unknown subcommand is refused with the help, exit 1', r.status === 1 && /Unknown command "migrate nonsense"/.test(r.stdout) && /aiondx migrate run/.test(r.stdout), r.stdout);
  const h = run(['migrate', 'help']);
  check('migrate help lists the exit codes', h.status === 0 && /3 the administrator prompt was declined/.test(h.stdout), h.stdout);
}

clearTimeout(deadline);
console.log('\n' + pass + '/' + (pass + fail) + ' passed');
process.exit(fail ? 1 : 0);
