'use strict';
// test-portable-move.js - aiondx-portable-move.js end to end (R-102, 2026-11-12): a made-up AionDX data folder is moved to a folder on a
// drive (H: by default; AIONDX_TEST_DRIVE to change) through the real engine, with made-up APPDATA, LOCALAPPDATA and USERPROFILE, so
// nothing of this PC's own data or pointer is touched. The drive folder and its marker are removed afterwards.
//   node patches\0016-data-move\test-portable-move.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 500) + ']')); };
const DRIVE = process.env.AIONDX_TEST_DRIVE || 'H:\\';
if (!fs.existsSync(DRIVE)) { console.log('SKIP: ' + DRIVE + ' is not there'); process.exit(0); }
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-portable-move-'));
const roaming = path.join(base, 'Roaming'), local = path.join(base, 'Local'), home = path.join(base, 'home');
const from = path.join(roaming, 'AionDX');
const testDir = path.join(DRIVE, 'AionDX-movetest-' + process.pid);
const to = path.join(testDir, 'AionDX-Data');
const driveMarker = path.join(DRIVE, 'AionDX-drive.json');
const hadMarker = fs.existsSync(driveMarker) ? fs.readFileSync(driveMarker) : null;
try {
  // a data folder: database with a conversation whose working folder is inside it, the working folder, a Claude history folder, page storage
  const ws = path.join(from, 'aionui', 'conversations', 'users', 'u1', '2026', '11', '12', 'chat-temp-abc');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'notes.md'), 'hello');
  fs.mkdirSync(path.join(from, 'Local Storage', 'leveldb'), { recursive: true });
  fs.writeFileSync(path.join(from, 'Local Storage', 'leveldb', '000001.log'), 'drafts and Loop states');
  const db = new DatabaseSync(path.join(from, 'aionui', 'aiondx-backend.db'));
  db.exec('CREATE TABLE conversations (id TEXT PRIMARY KEY, extra TEXT); CREATE TABLE messages (id INTEGER PRIMARY KEY, conversation_id TEXT, content TEXT); CREATE TABLE agent_metadata (id TEXT PRIMARY KEY, env TEXT, backend TEXT, name TEXT, command TEXT);');
  db.prepare('INSERT INTO conversations VALUES (?,?)').run('abc', JSON.stringify({ backend: 'claude', workspace: ws }));
  for (let i = 0; i < 50; i++) db.prepare('INSERT INTO messages (conversation_id, content) VALUES (?,?)').run('abc', 'message ' + i + ' about ' + ws + '\\a.png');
  db.close();
  const hist = path.join(home, '.claude', 'projects', ws.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(hist, { recursive: true });
  fs.writeFileSync(path.join(hist, 's1.jsonl'), '{"cwd":"x"}\n');
  const env = Object.assign({}, process.env, { APPDATA: roaming, LOCALAPPDATA: local, USERPROFILE: home, AIONDX_MOVER_SKIP_PROCESS_CHECK: '1' });
  const r = spawnSync(process.execPath, ['--no-warnings', path.join(__dirname, 'aiondx-portable-move.js'), '--from', from, '--to', to, '--wait-pid', '999999'],
    { encoding: 'utf8', windowsHide: true, timeout: 300000, env });
  const last = JSON.parse(fs.readFileSync(path.join(local, 'AionDX', 'data-move', 'portable-last.json'), 'utf8'));
  check('the mover runs the move and records it as done', r.status === 0 && last.state === 'done' && last.to === to, r.status + ' ' + JSON.stringify(last) + ' ' + String(r.stderr).slice(-300));
  const d2 = new DatabaseSync(path.join(to, 'aionui', 'aiondx-backend.db'), { readOnly: true });
  const extra = JSON.parse(d2.prepare("SELECT extra FROM conversations WHERE id = 'abc'").get().extra);
  const msgs = d2.prepare('SELECT COUNT(*) AS n FROM messages WHERE instr(content, ?) > 0').get(to).n;
  d2.close();
  const newWs = path.join(to, 'aionui', 'conversations', 'users', 'u1', '2026', '11', '12', 'chat-temp-abc');
  check("the chat's working folder, its file and its messages now point at the drive", extra.workspace === newWs && fs.readFileSync(path.join(newWs, 'notes.md'), 'utf8') === 'hello' && msgs === 50, JSON.stringify([extra, msgs]));
  check('the page storage (drafts, Loop states) went along', fs.existsSync(path.join(to, 'Local Storage', 'leveldb', '000001.log')));
  check("Claude's history folder is renamed for the new place", fs.existsSync(path.join(home, '.claude', 'projects', newWs.replace(/[^A-Za-z0-9]/g, '-'), 's1.jsonl')) && !fs.existsSync(hist));
  check('the old folder is kept, renamed, and this PC points at the drive', fs.readdirSync(roaming).some((n) => /^AionDX\.moved-/.test(n)) && !fs.existsSync(from) &&
    JSON.parse(fs.readFileSync(path.join(roaming, 'AionDX-location.json'), 'utf8')).path === to);
  // the mover refuses to start a move with nothing to move, and says so
  const r2 = spawnSync(process.execPath, ['--no-warnings', path.join(__dirname, 'aiondx-portable-move.js'), '--from', path.join(roaming, 'nothing-here'), '--to', path.join(testDir, 'Second')],
    { encoding: 'utf8', windowsHide: true, timeout: 120000, env });
  const last2 = JSON.parse(fs.readFileSync(path.join(local, 'AionDX', 'data-move', 'portable-last.json'), 'utf8'));
  check('a move with no data folder fails, is recorded as failed, and creates nothing', r2.status !== 0 && last2.state === 'failed' && !fs.existsSync(path.join(testDir, 'Second')), JSON.stringify(last2));
} catch (e) {
  check('no exception', false, e.stack);
} finally {
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  try { if (hadMarker) fs.writeFileSync(driveMarker, hadMarker); else fs.rmSync(driveMarker, { force: true }); } catch (e) { /* best effort */ }
  try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* temp */ }
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
}
