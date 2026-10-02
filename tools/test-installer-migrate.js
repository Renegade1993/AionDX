#!/usr/bin/env node
/**
 * test-installer-migrate.js - the installer's "move from AionUi" step, run for real in a sandbox: a copy of installer\aiondx.iss with
 * its own AppId, registry key, data folder, shortcut and process names (so nothing of an installed AionDX, or of the real AionUi, is
 * touched), compiled with a tiny stage folder holding the real `aiondx.exe migrate` and a made-up AionUi (see test-migrate.js for
 * the pieces). Silent installs with /AIONUIDIR and /AIONUIDATA pointing at the made-up AionUi:
 *   - no /MIGRATE: AionUi stays, chats untouched;
 *   - /MIGRATE=yes: backup, AionUi removed, chats intact, the result in the run log;
 *   - /MIGRATE=yes /AIONUIBACKUP=no: no backup folder;
 *   - the uninstaller removes the sandbox install and its registry key.
 *
 *   node tools\test-installer-migrate.js
 *
 * Needs Inno Setup 6. 240 s deadline.
 */
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const deadline = setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 240000);
const REPO = path.join(__dirname, '..');
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const ISCC = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6', 'ISCC.exe');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-iss-test-'));
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) { pass++; console.log('PASS  ' + name); } else { fail++; console.log('FAIL  ' + name + (detail !== undefined ? '   [' + String(detail).slice(0, 1500) + ']' : '')); } };
const cleanup = () => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) { /* best effort */ } try { fs.rmSync(path.join(process.env.LOCALAPPDATA, 'AionDXTest'), { recursive: true, force: true }); } catch (e) { /* best effort */ } };
process.on('exit', cleanup);
const reg = (args) => spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });

if (!fs.existsSync(ISCC)) { console.log('Inno Setup 6 is not installed (' + ISCC + ')'); process.exit(2); }
const REAL_DATA_STAMP = (() => { const f = path.join(process.env.LOCALAPPDATA, 'AionDX', 'install.json'); return fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0; })();

function compile(src, out) {
  const r = spawnSync(CSC, ['/nologo', '/optimize+', '/target:exe', '/platform:x64', '/r:System.Web.Extensions.dll', '/out:' + out, src], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) { console.log(r.stdout + r.stderr); process.exit(1); }
}

// ---- the programs: the real helper, and a stand-in for AionUi's uninstaller
const STAGE = path.join(ROOT, 'stage');
fs.mkdirSync(path.join(STAGE, 'resources', 'aiondx', 'bin'), { recursive: true });
compile(path.join(REPO, 'patches', '0007-loop-tool', 'aiondx-loop.cs'), path.join(STAGE, 'resources', 'aiondx', 'bin', 'aiondx.exe'));
fs.writeFileSync(path.join(STAGE, 'AionDX.exe'), 'stand-in');
fs.writeFileSync(path.join(ROOT, 'fake.cs'), `
using System; using System.IO;
static class P { static int Main(string[] a) {
  string last = a.Length > 0 ? a[a.Length - 1] : ""; if (!last.StartsWith("_?=")) return 9;
  string dir = last.Substring(3); string self = System.Reflection.Assembly.GetExecutingAssembly().Location;
  string log = Environment.GetEnvironmentVariable("FAKE_UNINSTALL_LOG"); if (log != null) File.AppendAllText(log, string.Join(" ", a) + "\\n");
  foreach (var f in Directory.GetFiles(dir)) if (!string.Equals(f, self, StringComparison.OrdinalIgnoreCase)) File.Delete(f);
  foreach (var d in Directory.GetDirectories(dir)) Directory.Delete(d, true);
  return 0; } }`);
const FAKE = path.join(ROOT, 'fake-uninstall.exe');
compile(path.join(ROOT, 'fake.cs'), FAKE);

// ---- the installer, sandboxed
let iss = fs.readFileSync(path.join(REPO, 'installer', 'aiondx.iss'), 'utf8').replace(/\r\n/g, '\n');
const GUID = '6C1F4E2A-4B7D-4E0B-9C1E-AE1D0B5DC2A1';
iss = iss.split(GUID).join('6C1F4E2A-0000-4E0B-9C1E-AE1D0B5D0000')
  .split('Software\\AionDX').join('Software\\AionDXTest')
  .split('{localappdata}\\AionDX').join('{localappdata}\\AionDXTest')
  .split('Programs\\AionDX').join('Programs\\AionDXTest')
  .split('{userprograms}\\AionDX').join('{userprograms}\\AionDXTest')
  .split('{userdesktop}\\AionDX').join('{userdesktop}\\AionDXTest')
  .split("'AionDX.exe'").join("'AionDXTest.exe'")
  .split('/IM AionDX.exe').join('/IM AionDXTest.exe')
  .replace('Compression=lzma2/ultra64', 'Compression=none')
  .replace('AppName=AionDX', 'AppName=AionDXTest')
  .replace('OutputBaseFilename=AionDX-{#AppVer}-setup', 'OutputBaseFilename=sandbox-setup')
  .replace(/^Filename: .*$/gm, '');
if (/AionDX\.exe'/.test(iss.replace(/\{app\}\\AionDX\.exe/g, ''))) console.log('note: a process name in the sandbox copy still reads AionDX.exe');
const T = path.join(ROOT, 'iss');
fs.mkdirSync(T, { recursive: true });
fs.writeFileSync(path.join(T, 'aiondx.iss'), iss);
let gen = fs.readFileSync(path.join(REPO, 'installer', 'generated.iss'), 'utf8')
  .replace(/#define StageDir ".*"/, '#define StageDir "' + STAGE + '"')
  .replace(/#define OutputDir ".*"/, '#define OutputDir "' + path.join(T, 'out') + '"')
  .replace(/#define AionUiVer ".*"/, '#define AionUiVer "2.2.2"');
fs.writeFileSync(path.join(T, 'generated.iss'), gen);
const built = spawnSync(ISCC, ['/Q', path.join(T, 'aiondx.iss')], { encoding: 'utf8', windowsHide: true });
check('the installer script compiles', built.status === 0, built.stdout + built.stderr);
const SETUP = path.join(T, 'out', 'sandbox-setup.exe');
if (built.status !== 0 || !fs.existsSync(SETUP)) { console.log('\n' + pass + '/' + (pass + fail) + ' passed'); process.exit(1); }

// ---- a made-up AionUi and its data
function makeAionUi(name) {
  const dir = path.join(ROOT, name, 'AionUi');
  fs.mkdirSync(path.join(dir, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'AionUi.exe'), 'not a real program');
  fs.copyFileSync(FAKE, path.join(dir, 'Uninstall AionUi.exe'));
  const d = path.join(ROOT, name, 'data');
  fs.mkdirSync(path.join(d, 'aionui'), { recursive: true });
  fs.mkdirSync(path.join(d, 'config'), { recursive: true });
  fs.writeFileSync(path.join(d, 'aionui', 'aionui-backend.db'), crypto.randomBytes(2 * 1024 * 1024));
  fs.writeFileSync(path.join(d, 'config', 'settings.json'), '{"a":1}');
  return { dir, data: d };
}
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const SANDBOX_DATA = path.join(process.env.LOCALAPPDATA, 'AionDXTest');
function install(label, ai, extra) {
  const log = path.join(ROOT, label + '.log');
  const r = spawnSync(SETUP, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/DIR=' + path.join(ROOT, label, 'app'), '/LOG=' + log,
    '/AIONUIDIR=' + ai.dir, '/AIONUIDATA=' + ai.data].concat(extra || []), { encoding: 'utf8', windowsHide: true, env: Object.assign({}, process.env, { FAKE_UNINSTALL_LOG: path.join(ROOT, label + '.uninstall.log') }), timeout: 120000 });
  const runLogs = fs.existsSync(path.join(SANDBOX_DATA, 'logs')) ? fs.readdirSync(path.join(SANDBOX_DATA, 'logs')).filter((f) => /_install_v/.test(f)).sort() : [];
  const runLog = runLogs.length ? fs.readFileSync(path.join(SANDBOX_DATA, 'logs', runLogs[runLogs.length - 1]), 'utf8') : '';
  return { status: r.status, log, runLog, stderr: r.stderr };
}

// 1. silent, no /MIGRATE: AionUi stays.
{
  const ai = makeAionUi('keep');
  const before = sha(path.join(ai.data, 'aionui', 'aionui-backend.db'));
  const r = install('keep', ai);
  check('a silent install without /MIGRATE keeps AionUi', r.status === 0 && fs.existsSync(path.join(ai.dir, 'AionUi.exe')) && sha(path.join(ai.data, 'aionui', 'aionui-backend.db')) === before, r.status + ' ' + r.runLog);
  check('and installs AionDX, noting that AionUi was found and not touched', fs.existsSync(path.join(ROOT, 'keep', 'app', 'AionDX.exe')) && /AionUi: unknown version in .* \(user\)/.test(r.runLog) && !/moving from AionUi/.test(r.runLog), r.runLog);
  spawnSync(path.join(ROOT, 'keep', 'app', 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES'], { windowsHide: true, timeout: 60000 });
}

// 2. /MIGRATE=yes: moved.
{
  const ai = makeAionUi('move');
  const before = sha(path.join(ai.data, 'aionui', 'aionui-backend.db'));
  const r = install('move', ai, ['/MIGRATE=yes']);
  check('/MIGRATE=yes installs, backs up, and removes AionUi', r.status === 0 && !fs.existsSync(path.join(ai.dir, 'AionUi.exe')) && fs.existsSync(path.join(ROOT, 'move', 'app', 'AionDX.exe')), r.status + ' ' + r.runLog);
  check('the chats database is untouched', sha(path.join(ai.data, 'aionui', 'aionui-backend.db')) === before);
  const mig = fs.existsSync(path.join(SANDBOX_DATA, 'migration')) ? fs.readdirSync(path.join(SANDBOX_DATA, 'migration')) : [];
  check('a backup of the database is in the AionDX data folder, byte for byte', mig.length === 1 && sha(path.join(SANDBOX_DATA, 'migration', mig[0], 'aionui', 'aionui-backend.db')) === before, JSON.stringify(mig));
  check('AionUi\'s own uninstaller ran silently for this user', fs.existsSync(path.join(ROOT, 'move.uninstall.log')) && /\/S \/currentuser _\?=/.test(fs.readFileSync(path.join(ROOT, 'move.uninstall.log'), 'utf8')));
  check('the run log records the move and its result', /migration: migrated: AionUi .* was removed\./.test(r.runLog), r.runLog);
  spawnSync(path.join(ROOT, 'move', 'app', 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES'], { windowsHide: true, timeout: 60000 });
  fs.rmSync(path.join(SANDBOX_DATA, 'migration'), { recursive: true, force: true });
}

// 3. /MIGRATE=yes /AIONUIBACKUP=no: no backup.
{
  const ai = makeAionUi('nobackup');
  const r = install('nobackup', ai, ['/MIGRATE=yes', '/AIONUIBACKUP=no']);
  check('/AIONUIBACKUP=no moves without a backup folder', r.status === 0 && !fs.existsSync(path.join(ai.dir, 'AionUi.exe')) && !fs.existsSync(path.join(SANDBOX_DATA, 'migration')) && /no backup, as asked/.test(r.runLog), r.runLog);
  spawnSync(path.join(ROOT, 'nobackup', 'app', 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES'], { windowsHide: true, timeout: 60000 });
}

// 4. no AionUi at all: nothing to offer, nothing to do.
{
  const none = { dir: path.join(ROOT, 'absent'), data: path.join(ROOT, 'absent-data') };
  const r = install('noaionui', none, ['/MIGRATE=yes']);
  check('with no AionUi, /MIGRATE=yes does nothing and the install still succeeds', r.status === 0 && fs.existsSync(path.join(ROOT, 'noaionui', 'app', 'AionDX.exe')) && /AionUi: not found/.test(r.runLog) && !/moving from AionUi/.test(r.runLog), r.runLog);
  spawnSync(path.join(ROOT, 'noaionui', 'app', 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES'], { windowsHide: true, timeout: 60000 });
}

// 4b. AionUi was already removed but its chats are still in the data folder: AionDX opens them, nothing is copied or moved.
{
  const ai = makeAionUi('dataonly');
  fs.rmSync(ai.dir, { recursive: true, force: true });
  const before = sha(path.join(ai.data, 'aionui', 'aionui-backend.db'));
  const r = install('dataonly', ai, ['/MIGRATE=yes']);
  check('with AionUi gone and its chats left behind, the install succeeds and notes the chats', r.status === 0 && fs.existsSync(path.join(ROOT, 'dataonly', 'app', 'AionDX.exe')) && /AionUi: not found, but its chats database is in .* \(\d+ bytes\)/.test(r.runLog) && !/moving from AionUi/.test(r.runLog), r.runLog);
  check('and leaves the chats database exactly as it was, with no backup made', sha(path.join(ai.data, 'aionui', 'aionui-backend.db')) === before && !fs.existsSync(path.join(SANDBOX_DATA, 'migration')));
  spawnSync(path.join(ROOT, 'dataonly', 'app', 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES'], { windowsHide: true, timeout: 60000 });
}

// 5. the sandbox leaves nothing behind, and the real AionDX state was not touched.
{
  const left = reg(['query', 'HKCU\\Software\\AionDXTest']);
  check('the sandbox uninstall removed its registry key', left.status !== 0, left.stdout);
  const realNow = (() => { const f = path.join(process.env.LOCALAPPDATA, 'AionDX', 'install.json'); return fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0; })();
  check("this PC's real AionDX install record was not touched", realNow === REAL_DATA_STAMP);
  try { fs.rmSync(SANDBOX_DATA, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  const startMenu = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'AionDXTest.lnk');
  check('and no sandbox shortcut is left in the Start menu', !fs.existsSync(startMenu));
}

clearTimeout(deadline);
console.log('\n' + pass + '/' + (pass + fail) + ' passed');
process.exit(fail ? 1 : 0);
