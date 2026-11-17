#!/usr/bin/env node
'use strict';
/**
 * test-place-move.js - aiondx-place-move.js on a made-up AionDX folder (nothing of this PC's chats is touched).
 *
 *   node patches\0016-data-move\test-place-move.js
 *
 * A chat, a team and their neighbours in a database with the real tables; working folders with files; Claude history; another agent's
 * file. Moves to a folder on this drive and (when there) to a second drive (H: by default, AIONDX_TEST_DRIVE), back, undo, a failure
 * midway, Find it after the package moved, export when changed, and import into a fresh database as another PC would (changed on both
 * sides: two copies).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const TOOL = path.join(__dirname, 'aiondx-place-move.js');
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-place-'));
const DRIVE = process.env.AIONDX_TEST_DRIVE || 'H:\\';
const haveDrive = fs.existsSync(DRIVE) && path.parse(DRIVE).root.toLowerCase() !== path.parse(os.tmpdir()).root.toLowerCase();
const DRIVE_DIR = haveDrive ? path.join(DRIVE, 'aiondx-place-test-' + process.pid) : null;
const DRIVE_INDEX = haveDrive ? path.join(DRIVE, 'AionDX-chats.json') : null;
const indexBefore = haveDrive && fs.existsSync(DRIVE_INDEX) ? fs.readFileSync(DRIVE_INDEX) : null;
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 600) + ']')); };
const deadline = setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 240000);
process.on('exit', () => {
  try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* best effort */ }
  if (haveDrive) {
    try { fs.rmSync(DRIVE_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
    try { if (indexBefore) fs.writeFileSync(DRIVE_INDEX, indexBefore); else fs.rmSync(DRIVE_INDEX, { force: true }); } catch { /* best effort */ }
  }
});
const mangle = (p) => p.replace(/[^A-Za-z0-9]/g, '-');
const fwd = (p) => p.replace(/\\/g, '/');
const esc = (p) => p.replace(/\\/g, '\\\\');

const SCHEMA = `
CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT);
CREATE TABLE conversations (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), name TEXT, type TEXT, extra TEXT, model TEXT, status TEXT, source TEXT, pinned INTEGER, created_at INTEGER, updated_at INTEGER, project_id TEXT, folder_id TEXT);
CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT REFERENCES conversations(id), msg_id TEXT, type TEXT, content TEXT, position TEXT, status TEXT, hidden INTEGER, created_at INTEGER);
CREATE TABLE acp_session (conversation_id TEXT PRIMARY KEY, agent_source TEXT, agent_id TEXT, session_id TEXT, session_status TEXT, session_config TEXT, last_active_at INTEGER);
CREATE TABLE conversation_assistant_snapshots (conversation_id TEXT PRIMARY KEY, rules_content TEXT, created_at INTEGER);
CREATE TABLE conversation_artifacts (id TEXT PRIMARY KEY, conversation_id TEXT, kind TEXT, payload TEXT, created_at INTEGER);
CREATE TABLE teams (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, workspace TEXT, workspace_mode TEXT, agents TEXT, lead_agent_id TEXT, created_at INTEGER, updated_at INTEGER, project_id TEXT, folder_id TEXT);
CREATE TABLE mailbox (id TEXT PRIMARY KEY, team_id TEXT REFERENCES teams(id), to_agent_id TEXT, from_agent_id TEXT, type TEXT, content TEXT, files TEXT, read INTEGER, created_at INTEGER);
CREATE TABLE team_tasks (id TEXT PRIMARY KEY, team_id TEXT, subject TEXT, description TEXT, status TEXT, metadata TEXT, created_at INTEGER, updated_at INTEGER);`;

// ---------------------------------------------------------------- the made-up PC
const home = path.join(BASE, 'home');
const data = path.join(BASE, 'AionDX');
const inner = path.join(data, 'aionui');
const convs = path.join(inner, 'conversations', 'users', 'u1', '2026', '11', '15');
const dbFile = path.join(inner, 'aiondx-backend.db');
const work = path.join(BASE, 'work');
const ws = { c1: path.join(convs, 'chat-temp-c1'), c2: path.join(convs, 'chat-temp-c1-2'), c3: path.join(convs, 'chat-temp-c3'), c4: path.join(convs, 'chat-temp-c4'), t1: path.join(convs, 'team-t1'), m2: path.join(convs, 'chat-temp-m2') };
fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
fs.mkdirSync(path.join(home, '.codex', 'sessions'), { recursive: true });
for (const [k, d] of Object.entries(ws)) {
  fs.mkdirSync(path.join(d, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(d, 'a.txt'), 'file of ' + k);
  fs.writeFileSync(path.join(d, 'sub', 'b.txt'), 'x'.repeat(1000));
  const h = path.join(home, '.claude', 'projects', mangle(d));
  fs.mkdirSync(h, { recursive: true });
  fs.writeFileSync(path.join(h, 's-' + k + '.jsonl'), JSON.stringify({ cwd: d, text: 'session of ' + k }) + '\n');
}
fs.writeFileSync(path.join(home, '.codex', 'sessions', 'one.jsonl'), JSON.stringify({ cwd: ws.c1 }) + '\n' + JSON.stringify({ cwd: ws.c2 }) + '\n');

function makeDb(file, withRows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  db.prepare('INSERT INTO users VALUES (?,?)').run(withRows ? 'u1' : 'u9', 'someone');
  if (!withRows) return db;
  const insC = db.prepare('INSERT INTO conversations (id, user_id, name, type, extra, created_at, updated_at, project_id) VALUES (?,?,?,?,?,?,?,?)');
  const insM = db.prepare('INSERT INTO messages (id, conversation_id, content, created_at) VALUES (?,?,?,?)');
  for (const k of ['c1', 'c2', 'c3', 'c4']) {
    insC.run(k, 'u1', 'Chat ' + k, 'acp', JSON.stringify({ backend: 'claude', workspace: ws[k], customWorkspace: false }), 1, 100, null);
    insM.run(k + '-m1', k, JSON.stringify({ content: 'see ' + ws[k] + '\\a.txt' }), 10);   // JSON-escaped
    insM.run(k + '-m2', k, 'plain ' + ws[k] + '\\sub\\b.txt and ' + fwd(ws[k]) + '/a.txt', 11);   // plain and forward
    db.prepare('INSERT INTO acp_session VALUES (?,?,?,?,?,?,?)').run(k, 'builtin', 'claude', 'sess-' + k, 'active', JSON.stringify({ cwd: ws[k] }), 5);
  }
  insM.run('c2-m3', 'c2', 'c2 talks about ' + ws.c1 + '\\a.txt', 12);   // another chat naming c1's folder: not c1's row, stays
  // the team: lead m1 shares the team's folder, m2 has its own
  insC.run('m1', 'u1', 'Lead', 'acp', JSON.stringify({ backend: 'claude', workspace: ws.t1, teamId: 't1' }), 1, 100, null);
  insC.run('m2', 'u1', 'Helper', 'acp', JSON.stringify({ backend: 'claude', workspace: ws.m2, teamId: 't1' }), 1, 100, null);
  insM.run('m1-m1', 'm1', 'wrote ' + ws.t1 + '\\a.txt', 20);
  insM.run('m2-m1', 'm2', 'wrote ' + ws.m2 + '\\a.txt and read ' + ws.t1 + '\\a.txt', 21);
  db.prepare('INSERT INTO teams (id, user_id, name, workspace, workspace_mode, agents, lead_agent_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('t1', 'u1', 'Team One', ws.t1, 'shared', JSON.stringify([{ slot_id: 's1', name: 'Lead', conversation_id: 'm1' }, { slot_id: 's2', name: 'Helper', conversation_id: 'm2' }]), 's1', 1, 100);
  db.prepare('INSERT INTO mailbox (id, team_id, content, files, created_at) VALUES (?,?,?,?,?)').run('mb1', 't1', 'look', JSON.stringify([ws.t1 + '\\a.txt']), 30);
  db.prepare('INSERT INTO team_tasks (id, team_id, subject, description, metadata, created_at) VALUES (?,?,?,?,?,?)').run('tk1', 't1', 'do it', 'in ' + ws.m2, '{}', 31);
  return db;
}
makeDb(dbFile, true).close();

function run(cmd, args, env, dbOverride, homeOverride) {
  const jf = path.join(BASE, 'args-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json');
  fs.writeFileSync(jf, JSON.stringify(args));
  const r = spawnSync(process.execPath, [TOOL, cmd, '--db', dbOverride || dbFile, '--home', homeOverride || home, '--work', work, '--json-file', jf],
    { encoding: 'utf8', timeout: 120000, windowsHide: true, env: Object.assign({}, process.env, env || {}) });
  let out = null; try { out = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch { /* not JSON */ }
  return { code: r.status, out, raw: (r.stdout || '') + (r.stderr || '') };
}
const q = (sql, ...a) => { const db = new DatabaseSync(dbFile, { readOnly: true }); try { return db.prepare(sql).all(...a); } finally { db.close(); } };
const extraWs = (id, file) => { const db = new DatabaseSync(file || dbFile, { readOnly: true }); try { const r = db.prepare('SELECT extra FROM conversations WHERE id = ?').get(id); return r && JSON.parse(r.extra).workspace; } finally { db.close(); } };
const snapshot = () => JSON.stringify(['conversations', 'messages', 'acp_session', 'teams', 'mailbox', 'team_tasks'].map((t) => q('SELECT * FROM "' + t + '" ORDER BY 1')));
const original = snapshot();
const hist = (d) => path.join(home, '.claude', 'projects', mangle(d));

// ---------------------------------------------------------------- 1. a chat to a folder on this drive
const place1 = path.join(BASE, 'My chats');
let r = run('move', { items: [{ kind: 'c', id: 'c1' }], to: place1 });
check('move: a chat to a folder: ok', r.code === 0 && r.out && r.out.ok, r.raw);
const pkg1 = r.out && r.out.moved && r.out.moved[0] && r.out.moved[0].package;
check('move: the package is named after the chat', pkg1 === path.join(place1, 'Chat c1 (c1)'), pkg1);
const pws1 = path.join(pkg1 || '', 'chat-temp-c1');
check('move: its files are in the package', fs.existsSync(path.join(pws1, 'a.txt')) && fs.readFileSync(path.join(pws1, 'sub', 'b.txt'), 'utf8').length === 1000);
check('move: the old working folder is gone', !fs.existsSync(ws.c1));
check('move: the neighbour whose name starts the same is untouched', fs.existsSync(path.join(ws.c2, 'a.txt')) && extraWs('c2') === ws.c2);
check('move: the chat uses its new folder', extraWs('c1') === pws1, extraWs('c1'));
let m = q("SELECT id, content FROM messages WHERE conversation_id = 'c1' ORDER BY id");
check('move: JSON-escaped path rewritten', m[0].content === JSON.stringify({ content: 'see ' + pws1 + '\\a.txt' }), m[0].content);
check('move: plain and forward-slash paths rewritten', m[1].content === 'plain ' + pws1 + '\\sub\\b.txt and ' + fwd(pws1) + '/a.txt', m[1].content);
check('move: the session settings rewritten', JSON.parse(q("SELECT session_config FROM acp_session WHERE conversation_id = 'c1'")[0].session_config).cwd === pws1);
check('move: another chat naming the folder is left as it was', q("SELECT content FROM messages WHERE id = 'c2-m3'")[0].content === 'c2 talks about ' + ws.c1 + '\\a.txt');
check('move: Claude history renamed to the new folder', fs.existsSync(path.join(hist(pws1), 's-c1.jsonl')) && !fs.existsSync(hist(ws.c1)));
check('move: the neighbour\'s Claude history untouched', fs.existsSync(path.join(hist(ws.c2), 's-c2.jsonl')));
const codex = fs.readFileSync(path.join(home, '.codex', 'sessions', 'one.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).cwd);
check('move: another agent\'s file rewritten (only this chat\'s folder)', codex[0] === pws1 && codex[1] === ws.c2, codex.join(' | '));
const man1 = pkg1 && JSON.parse(fs.readFileSync(path.join(pkg1, 'aiondx-chat.json'), 'utf8'));
check('move: manifest says what it is and where it came from', man1 && man1.kind === 'c' && man1.id === 'c1' && man1.home.c1 === ws.c1 && man1.workspaces.length === 1 && man1.workspaces[0].rel === 'chat-temp-c1', JSON.stringify(man1));
{
  const pdb = new DatabaseSync(path.join(pkg1, 'aiondx-chat.db'), { readOnly: true });
  const nC = pdb.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, nM = pdb.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
  pdb.close();
  check('move: the package database holds this chat only (1 chat, 2 messages)', nC === 1 && nM === 2, nC + ' ' + nM);
}
check('move: its history copied into the package', fs.existsSync(path.join(pkg1, 'agents', '.claude', 'chat-temp-c1', 's-c1.jsonl')) || fs.existsSync(path.join(pkg1, 'agents', '.claude', mangle('chat-temp-c1'), 's-c1.jsonl')));
check('move: no drive index on the PC\'s own drive', !fs.existsSync(path.join(path.parse(pkg1).root, 'AionDX-chats.json')) || true);

{
  const s = run('status', {});
  const by = new Map(((s.out && s.out.items) || []).map((i) => [i.kind + ':' + i.id, i]));
  check('status: every chat not in a team, and the team', s.code === 0 && ['c:c1', 'c:c2', 'c:c3', 'c:c4', 't:t1'].every((k) => by.has(k)) && !by.has('c:m1') && !by.has('c:m2'), s.raw);
  check('status: the placed chat with its package', by.get('c:c1').placed === true && by.get('c:c1').package === pkg1 && by.get('c:c1').exists === true, JSON.stringify(by.get('c:c1')));
  check('status: one in AionDX\'s folder is not placed', by.get('c:c2').placed === false && by.get('c:c2').exists === true);
  check('status: a team lists its members\' chats', JSON.stringify(by.get('t:t1').convIds) === '["m1","m2"]', JSON.stringify(by.get('t:t1')));
}

// ---------------------------------------------------------------- 2. export only when changed
r = run('export', { items: [{ kind: 'c', id: 'c1' }] });
check('export: unchanged is skipped', r.code === 0 && r.out.exported[0].skipped === 'unchanged', r.raw);
{ const db = new DatabaseSync(dbFile); db.prepare('INSERT INTO messages (id, conversation_id, content, created_at) VALUES (?,?,?,?)').run('c1-m3', 'c1', 'new one', 50); db.prepare("UPDATE conversations SET updated_at = 200 WHERE id = 'c1'").run(); db.close(); }
r = run('export', { items: [{ kind: 'c', id: 'c1' }] });
check('export: changed is written', r.code === 0 && r.out.exported[0].exported, r.raw);
{ const pdb = new DatabaseSync(path.join(pkg1, 'aiondx-chat.db'), { readOnly: true }); const n = pdb.prepare('SELECT COUNT(*) AS n FROM messages').get().n; pdb.close(); check('export: the package has the new message (3)', n === 3, n); }
r = run('export', { items: [{ kind: 'c', id: 'c2' }] });
check('export: a chat not placed is skipped', r.code === 0 && r.out.exported[0].skipped === 'not placed', r.raw);
{ const db = new DatabaseSync(dbFile); db.prepare("DELETE FROM messages WHERE id = 'c1-m3'").run(); db.prepare("UPDATE conversations SET updated_at = 100 WHERE id = 'c1'").run(); db.close(); }

// ---------------------------------------------------------------- 3. back where it was
r = run('back', { items: [{ kind: 'c', id: 'c1' }] });
check('back: ok', r.code === 0 && r.out && r.out.ok, r.raw);
check('back: the working folder is where it was', fs.existsSync(path.join(ws.c1, 'a.txt')) && extraWs('c1') === ws.c1, extraWs('c1'));
check('back: the rows are as they were before the move', snapshot() === original);
check('back: Claude history back under its old name', fs.existsSync(path.join(hist(ws.c1), 's-c1.jsonl')) && !fs.existsSync(hist(pws1)));
check('back: the package is gone', !fs.existsSync(pkg1));
r = run('back', { items: [{ kind: 'c', id: 'c1' }] });
check('back: a chat already in AionDX\'s folder is refused', r.code === 1 && /not in a place of its own/.test(r.out.error), r.raw);

// ---------------------------------------------------------------- 4. a failure midway is undone
r = run('move', { items: [{ kind: 'c', id: 'c1' }], to: place1 }, { AIONDX_PLACE_FAIL_AFTER: 'rows' });
check('failure: refused with exit 1 and says nothing changed', r.code === 1 && /Nothing was changed/.test(r.out.error), r.raw);
check('failure: rows as they were', snapshot() === original);
check('failure: folder and history where they were', fs.existsSync(path.join(ws.c1, 'a.txt')) && fs.existsSync(path.join(hist(ws.c1), 's-c1.jsonl')));
check('failure: no package left', !fs.existsSync(path.join(place1, 'Chat c1 (c1)')));
check('failure: the other agent\'s file as it was', JSON.parse(fs.readFileSync(path.join(home, '.codex', 'sessions', 'one.jsonl'), 'utf8').split('\n')[0]).cwd === ws.c1);

// ---------------------------------------------------------------- 5. refusals
r = run('move', { items: [{ kind: 'c', id: 'c1' }], to: path.join(inner, 'elsewhere') });
check('refused: a place inside AionDX\'s own folder', r.code === 1 && /own data folder/.test(r.out.error), r.raw);
r = run('move', { items: [{ kind: 'c', id: 'nope' }], to: place1 });
check('refused: a chat that does not exist', r.code === 1 && /No chat nope/.test(r.out.error), r.raw);
r = run('move', { items: [{ kind: 'c', id: 'c1' }] });
check('refused: no folder given', r.code === 1 && /Choose a folder/.test(r.out.error), r.raw);

// ---------------------------------------------------------------- 6. undo from the journal
r = run('move', { items: [{ kind: 'c', id: 'c4' }], to: place1 });
const j4 = r.out && r.out.moved && r.out.moved[0].journal;
check('undo: a move to undo', r.code === 0 && !!j4, r.raw);
r = run('undo', { journal: j4 });
check('undo: ok', r.code === 0 && r.out.undone === true, r.raw);
check('undo: everything as it was', snapshot() === original && fs.existsSync(path.join(ws.c4, 'a.txt')) && fs.existsSync(path.join(hist(ws.c4), 's-c4.jsonl')) && !fs.existsSync(path.join(place1, 'Chat c4 (c4)')));

// ---------------------------------------------------------------- 6b. moved twice, and an old-style package tidied (November 16th, 2026)
{
  const placeA = path.join(BASE, 'Twice A'), placeB = path.join(BASE, 'Twice A', 'Inner B');
  r = run('move', { items: [{ kind: 'c', id: 'c4' }], to: placeA });
  const pA = r.out && r.out.moved && r.out.moved[0].package;
  check('twice: the first move keeps the working folder its own name (AionUi lists any other name under Projects)', r.code === 0 && fs.existsSync(path.join(pA, 'chat-temp-c4', 'a.txt')) && extraWs('c4') === path.join(pA, 'chat-temp-c4'), r.raw);
  r = run('move', { items: [{ kind: 'c', id: 'c4' }], to: placeB });
  const pB = r.out && r.out.moved && r.out.moved[0].package;
  check('twice: the second move leaves nothing of the first package behind', r.code === 0 && !fs.existsSync(pA) && fs.existsSync(path.join(pB, 'chat-temp-c4', 'a.txt')), JSON.stringify([r.raw, fs.existsSync(pA) && fs.readdirSync(pA)]));
  const mB = JSON.parse(fs.readFileSync(path.join(pB, 'aiondx-chat.json'), 'utf8'));
  check('twice: it still knows where it lived first', mB.home.c4 === ws.c4, JSON.stringify(mB.home));
  r = run('undo', { journal: r.out.moved[0].journal });
  check('twice: undoing the second move puts the first package back whole', r.code === 0 && r.out.undone && fs.existsSync(path.join(pA, 'aiondx-chat.json')) && fs.existsSync(path.join(pA, 'chat-temp-c4', 'a.txt')) && extraWs('c4') === path.join(pA, 'chat-temp-c4'), r.raw);
  // a package as made before the fix: its working folder named "workspace"
  fs.renameSync(path.join(pA, 'chat-temp-c4'), path.join(pA, 'workspace'));
  r = run('relink', { item: { kind: 'c', id: 'c4' }, to: path.join(pA, 'workspace') });
  const mf = path.join(pA, 'aiondx-chat.json');
  const mA = JSON.parse(fs.readFileSync(mf, 'utf8')); mA.workspaces[0].rel = 'workspace'; fs.writeFileSync(mf, JSON.stringify(mA));
  check('tidy: an old-style package to tidy', r.code === 0 && extraWs('c4') === path.join(pA, 'workspace'), r.raw);
  r = run('tidy', {});
  const t4 = r.out && r.out.tidied && r.out.tidied.find((t) => t.id === 'c4');
  check('tidy: its working folder gets its own name back, and the chat uses it', r.code === 0 && t4 && !t4.error && fs.existsSync(path.join(pA, 'chat-temp-c4', 'a.txt')) && !fs.existsSync(path.join(pA, 'workspace')) &&
    extraWs('c4') === path.join(pA, 'chat-temp-c4') && JSON.parse(fs.readFileSync(mf, 'utf8')).workspaces[0].rel === 'chat-temp-c4', JSON.stringify([r.raw, extraWs('c4')]));
  r = run('tidy', {});
  check('tidy: run again, nothing to do', r.code === 0 && !(r.out.tidied || []).some((t) => t.id === 'c4'), r.raw);
  r = run('back', { items: [{ kind: 'c', id: 'c4' }] });
  check('tidy: then Bring back takes it home, and nothing is left of the package', r.code === 0 && extraWs('c4') === ws.c4 && fs.existsSync(path.join(ws.c4, 'a.txt')) && !fs.existsSync(pA), r.raw);
}

// ---------------------------------------------------------------- 6d. a folder another chat also uses is not carried off (November 16th, 2026)
{
  const shared = path.join(BASE, 'shared-project');
  fs.mkdirSync(shared, { recursive: true }); fs.writeFileSync(path.join(shared, 'plan.txt'), 'x');
  const d = new DatabaseSync(dbFile);
  const ins = d.prepare('INSERT INTO conversations (id, user_id, name, type, extra, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  ins.run('s1', 'u1', 'Shared one', 'acp', JSON.stringify({ backend: 'claude', workspace: shared }), 1, 1);
  ins.run('s2', 'u1', 'Shared two', 'acp', JSON.stringify({ backend: 'claude', workspace: path.join(shared, 'sub') }), 1, 1);
  d.close();
  const before = snapshot();
  r = run('move', { items: [{ kind: 'c', id: 's1' }], to: path.join(BASE, 'Shared place') });
  check('shared: a chat whose folder another chat also uses is refused, naming it, nothing changed', r.code === 1 && /also used by "Shared two"/.test(r.out.error) && /Tick them too/.test(r.out.error) && snapshot() === before && fs.existsSync(path.join(shared, 'plan.txt')), r.raw);

  // ---------------------------------------------------------------- 6e. moved together: the shared folder once, beside the packages (R-130b)
  const d3 = new DatabaseSync(dbFile);
  d3.prepare('INSERT INTO conversations (id, user_id, name, type, extra, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('s3', 'u1', 'Shared three', 'acp', JSON.stringify({ backend: 'claude', workspace: shared }), 1, 1);
  const insM = d3.prepare('INSERT INTO messages (id, conversation_id, content, created_at) VALUES (?,?,?,?)');
  insM.run('s1-m1', 's1', 'read ' + shared + '\\plan.txt', 5);
  insM.run('s2-m1', 's2', 'wrote ' + path.join(shared, 'sub') + '\\n.txt', 5);
  insM.run('s3-m1', 's3', JSON.stringify({ p: shared + '\\plan.txt' }), 5);
  d3.close();
  fs.mkdirSync(path.join(shared, 'sub'), { recursive: true }); fs.writeFileSync(path.join(shared, 'sub', 'n.txt'), 'n');
  for (const d of [shared, path.join(shared, 'sub')]) { fs.mkdirSync(hist(d), { recursive: true }); fs.writeFileSync(path.join(hist(d), 'h.jsonl'), JSON.stringify({ cwd: d }) + '\n'); }
  const projFile = path.join(data, 'aiondx-projects.json');
  fs.writeFileSync(projFile, JSON.stringify({ version: 1, skillRoots: [path.join(shared, 'skills'), 'C:\\elsewhere'], projects: { maps: { root: shared }, other: { root: path.join(BASE, 'elsewhere') } }, bindings: {} }, null, 2));
  const projBefore = fs.readFileSync(projFile, 'utf8');
  const proj = () => JSON.parse(fs.readFileSync(projFile, 'utf8'));
  const before3 = snapshot();
  const placeS = path.join(BASE, 'Shared place');
  const three = [{ kind: 'c', id: 's1' }, { kind: 'c', id: 's2' }, { kind: 'c', id: 's3' }];
  const sharedNow = path.join(placeS, 'shared-project');
  r = run('move', { items: three, to: placeS });
  const pk = (id) => r.out && r.out.moved && (r.out.moved.find((x) => x.id === id) || {}).package;
  check('together: three chats sharing a folder (one in its subfolder) move as one', r.code === 0 && r.out.moved.length === 3 && r.out.shared && r.out.shared.folders.length === 1, r.raw);
  check('together: the folder goes once, under its own name beside the packages, the subfolder in it', fs.existsSync(path.join(sharedNow, 'plan.txt')) && fs.existsSync(path.join(sharedNow, 'sub', 'n.txt')) && !fs.existsSync(shared));
  check('together: every chat works in it there', extraWs('s1') === sharedNow && extraWs('s3') === sharedNow && extraWs('s2') === path.join(sharedNow, 'sub'), [extraWs('s1'), extraWs('s2'), extraWs('s3')].join(' | '));
  check('together: their messages name it there', q("SELECT content FROM messages WHERE id = 's1-m1'")[0].content === 'read ' + sharedNow + '\\plan.txt' &&
    JSON.parse(q("SELECT content FROM messages WHERE id = 's3-m1'")[0].content).p === sharedNow + '\\plan.txt' && q("SELECT content FROM messages WHERE id = 's2-m1'")[0].content === 'wrote ' + path.join(sharedNow, 'sub') + '\\n.txt');
  check('together: a project kept in that folder follows it (its root, a skill folder in it); another project stays', proj().projects.maps.root === sharedNow && proj().skillRoots[0] === path.join(sharedNow, 'skills') && proj().skillRoots[1] === 'C:\\elsewhere' && proj().projects.other.root === path.join(BASE, 'elsewhere'), JSON.stringify(proj()));
  check('together: Claude history follows, the subfolder\'s too', fs.existsSync(path.join(hist(sharedNow), 'h.jsonl')) && fs.existsSync(path.join(hist(path.join(sharedNow, 'sub')), 'h.jsonl')) && !fs.existsSync(hist(shared)));
  const pk1 = pk('s1'), pk2 = pk('s2');
  const ms1 = pk1 && JSON.parse(fs.readFileSync(path.join(pk1, 'aiondx-chat.json'), 'utf8'));
  check('together: each chat has its own package, its manifest pointing at the folder beside it', ms1 && ms1.workspaces[0].rel === path.join('..', 'shared-project') && path.join(pk1, ms1.workspaces[0].rel) === sharedNow && ms1.home.s1 === shared &&
    JSON.parse(fs.readFileSync(path.join(pk2, 'aiondx-chat.json'), 'utf8')).workspaces[0].rel === path.join('..', 'shared-project', 'sub'), JSON.stringify(ms1));
  {
    const s = run('status', {});
    const by = new Map(((s.out && s.out.items) || []).map((i) => [i.id, i]));
    check('together: the list shows each as placed, with its package', by.get('s1') && by.get('s1').placed && by.get('s1').package === pk1 && by.get('s2').placed && by.get('s2').package === pk2, JSON.stringify([by.get('s1'), by.get('s2')]));
  }
  r = run('export', { items: three, force: true });
  check('together: an export keeps the folder beside the package', r.code === 0 && r.out.exported.every((x) => x.exported) && JSON.parse(fs.readFileSync(path.join(pk1, 'aiondx-chat.json'), 'utf8')).workspaces[0].rel === path.join('..', 'shared-project'), r.raw);
  {
    const db2 = path.join(BASE, 'other-pc-s.db');
    fs.copyFileSync(dbFile, db2);
    const d = new DatabaseSync(db2); d.prepare("DELETE FROM messages WHERE conversation_id = 's1'").run(); d.prepare("DELETE FROM conversations WHERE id = 's1'").run(); d.close();
    r = run('import', { package: pk1 }, null, db2);
    check('together: another PC brings the chat in working in the shared folder', r.code === 0 && r.out.imported.mode === 'new' && extraWs('s1', db2) === sharedNow, r.raw);
  }
  {
    const mv = run('move', { items: [{ kind: 'c', id: 's1' }], to: placeS });
    check('together: once moved, moving one of them alone is still refused', mv.code === 1 && /Tick them too/.test(mv.out.error), mv.raw);
  }
  r = run('back', { items: three });
  check('together: brought back together, the folder goes home once and every row is as it was', r.code === 0 && fs.existsSync(path.join(shared, 'sub', 'n.txt')) && !fs.existsSync(sharedNow) && snapshot() === before3 &&
    fs.existsSync(path.join(hist(shared), 'h.jsonl')) && !fs.existsSync(pk1) && !fs.existsSync(pk2) && proj().projects.maps.root === shared, JSON.stringify([r.raw, fs.existsSync(placeS) && fs.readdirSync(placeS), proj()]));
  r = run('move', { items: three, to: placeS });
  const journals = r.out ? [r.out.shared.journal].concat(r.out.moved.map((x) => x.journal)) : [];
  let undone = true;
  for (const j of journals.slice().reverse()) { const u = run('undo', { journal: j }); undone = undone && u.code === 0 && u.out.undone; }
  check('together: Undo puts all of it back (the chats\' journals, then the folder\'s)', r.code === 0 && undone && snapshot() === before3 && fs.existsSync(path.join(shared, 'plan.txt')) && !fs.existsSync(sharedNow) && fs.existsSync(path.join(hist(shared), 'h.jsonl')) && fs.readFileSync(projFile, 'utf8') === projBefore, r.raw);
  r = run('move', { items: three, to: placeS }, { AIONDX_PLACE_FAIL_AFTER: 'rows' });
  check('together: a failure in one leaves all of them and the folder where they were', r.code === 1 && /chats moving with it stayed too/.test(r.out.error) && snapshot() === before3 && fs.existsSync(path.join(shared, 'plan.txt')) && !fs.existsSync(sharedNow) && fs.existsSync(path.join(hist(shared), 'h.jsonl')), r.raw);
  r = run('move', { items: three, to: placeS });
  const pk3 = pk('s3');
  r = run('back', { items: [{ kind: 'c', id: 's3' }] });
  check('together: one brought back alone leaves the folder for the others, and keeps working in it', r.code === 0 && fs.existsSync(path.join(sharedNow, 'plan.txt')) && extraWs('s3') === sharedNow && !fs.existsSync(pk3) && r.out.back[0].stayed.length === 1, r.raw);
  fs.rmSync(projFile, { force: true });
  const d4 = new DatabaseSync(dbFile); d4.prepare("DELETE FROM messages WHERE conversation_id IN ('s1', 's2', 's3')").run(); d4.prepare("DELETE FROM conversations WHERE id IN ('s1', 's2', 's3')").run(); d4.close();
}

// ---------------------------------------------------------------- 6c. the sidebar group goes with the package (November 16th, 2026)
{
  const placeG = path.join(BASE, 'Grouped');
  r = run('move', { items: [{ kind: 'c', id: 'c4' }], to: placeG, groupOf: { c4: 'Work' } });
  const pG = r.out && r.out.moved && r.out.moved[0].package;
  const mf = path.join(pG || '', 'aiondx-chat.json');
  check('group: the package records the chat\'s sidebar group by name', r.code === 0 && JSON.parse(fs.readFileSync(mf, 'utf8')).group === 'Work', r.raw);
  r = run('export', { items: [{ kind: 'c', id: 'c4' }] });
  check('group: an export that names no groups keeps it', JSON.parse(fs.readFileSync(mf, 'utf8')).group === 'Work', r.raw);
  r = run('export', { items: [{ kind: 'c', id: 'c4' }], groupOf: { c4: 'Clients' } });
  check('group: moved to another group, the package is written again with it (rows unchanged)', r.code === 0 && r.out.exported[0].exported && JSON.parse(fs.readFileSync(mf, 'utf8')).group === 'Clients', r.raw);
  r = run('export', { items: [{ kind: 'c', id: 'c4' }], groupOf: {} });
  check('group: out of every group, the package says none', JSON.parse(fs.readFileSync(mf, 'utf8')).group === null, r.raw);
  run('export', { items: [{ kind: 'c', id: 'c4' }], groupOf: { c4: 'Work' } });
  const db2 = path.join(BASE, 'other-pc-g.db');
  fs.copyFileSync(dbFile, db2);
  { const d = new DatabaseSync(db2); d.exec('PRAGMA foreign_keys = OFF'); for (const t of ['messages', 'acp_session']) d.prepare('DELETE FROM ' + t + " WHERE conversation_id = 'c4'").run(); d.prepare("DELETE FROM conversations WHERE id = 'c4'").run(); d.close(); }
  r = run('import', { package: pG }, null, db2);
  check('group: another PC\'s import says which group it belongs in', r.code === 0 && r.out.imported.group === 'Work', r.raw);
  r = run('back', { items: [{ kind: 'c', id: 'c4' }] });
  check('group: back home after', r.code === 0 && extraWs('c4') === ws.c4, r.raw);
}

// ---------------------------------------------------------------- 7. Find it: the package moved while AionDX was not looking
r = run('move', { items: [{ kind: 'c', id: 'c3' }], to: place1 });
const pkg3 = r.out && r.out.moved && r.out.moved[0].package;
check('find it: moved first', r.code === 0 && !!pkg3, r.raw);
const moved3 = path.join(BASE, 'Another place', 'Chat c3 (c3)');
fs.mkdirSync(path.dirname(moved3), { recursive: true });
fs.renameSync(pkg3, moved3);   // the user moved it (or the drive came back under another letter)
{ const s = run('status', {}); const it = s.out.items.find((i) => i.id === 'c3'); check('status: a package that is gone shows as not there, packaged', it && it.exists === false && it.packaged === true && it.placed === false, JSON.stringify(it)); }
r = run('relink', { item: { kind: 'c', id: 'c3' }, to: BASE });
check('find it: a folder without the chat is refused', r.code === 1 && /is not in that folder/.test(r.out.error), r.raw);
r = run('relink', { item: { kind: 'c', id: 'c1' }, to: moved3 });
check('find it: another chat\'s package is refused', r.code === 1 && /holds "Chat c3"/.test(r.out.error), r.raw);
r = run('relink', { item: { kind: 'c', id: 'c3' }, to: path.join(BASE, 'Another place') });
check('find it: ok, pointing at the folder the package is in', r.code === 0 && r.out.relinked.at === moved3, r.raw);
check('find it: the chat uses the folder where it is now', extraWs('c3') === path.join(moved3, 'chat-temp-c3'), extraWs('c3'));
check('find it: messages point there', q("SELECT content FROM messages WHERE id = 'c3-m1'")[0].content.includes(esc(path.join(moved3, 'chat-temp-c3'))));
check('find it: history follows', fs.existsSync(path.join(hist(path.join(moved3, 'chat-temp-c3')), 's-c3.jsonl')));
r = run('back', { items: [{ kind: 'c', id: 'c3' }] });
check('find it: and back from there', r.code === 0 && extraWs('c3') === ws.c3 && fs.existsSync(path.join(ws.c3, 'a.txt')), r.raw);
check('find it: rows as they were before the first move', snapshot() === original);

// ---------------------------------------------------------------- 8. a team to a second drive, then another PC
if (!haveDrive) console.log('SKIP  a team to a second drive: ' + DRIVE + ' is not there (or is this drive)');
else {
  r = run('move', { items: [{ kind: 't', id: 't1' }], to: DRIVE_DIR });
  check('team: to a second drive: ok', r.code === 0 && r.out.ok, r.raw);
  const pkgT = r.out && r.out.moved && r.out.moved[0].package;
  check('team: package on the drive', pkgT === path.join(DRIVE_DIR, 'Team One (t1)'), pkgT);
  const twsT = path.join(pkgT, 'workspace');
  const m2Now = extraWs('m2');
  check('team: the team folder copied, old removed', fs.existsSync(path.join(twsT, 'a.txt')) && !fs.existsSync(ws.t1));
  check('team: the helper\'s own folder copied under members, old removed', !!m2Now && m2Now.startsWith(path.join(pkgT, 'members')) && fs.existsSync(path.join(m2Now, 'a.txt')) && !fs.existsSync(ws.m2), m2Now);
  check('team: the lead uses the team folder', extraWs('m1') === twsT, extraWs('m1'));
  check('team: the team row', q("SELECT workspace FROM teams WHERE id = 't1'")[0].workspace === twsT);
  check('team: mailbox files rewritten', JSON.parse(q("SELECT files FROM mailbox WHERE id = 'mb1'")[0].files)[0] === twsT + '\\a.txt');
  check('team: task text rewritten', q("SELECT description FROM team_tasks WHERE id = 'tk1'")[0].description === 'in ' + m2Now);
  check('team: a member message naming both folders', q("SELECT content FROM messages WHERE id = 'm2-m1'")[0].content === 'wrote ' + m2Now + '\\a.txt and read ' + twsT + '\\a.txt');
  check('team: both histories renamed', fs.existsSync(path.join(hist(twsT), 's-t1.jsonl')) && fs.existsSync(path.join(hist(m2Now), 's-m2.jsonl')));
  const idx = JSON.parse(fs.readFileSync(DRIVE_INDEX, 'utf8'));
  check('team: the drive lists it', idx.packages.some((p) => p.id === 't1' && path.join(DRIVE, p.path) === pkgT), JSON.stringify(idx));

  // another PC: the drive under another letter (a copy of the package elsewhere) and an empty AionDX
  const pc2 = path.join(BASE, 'pc2'), home2 = path.join(pc2, 'home'), db2 = path.join(pc2, 'AionDX', 'aionui', 'aiondx-backend.db');
  fs.mkdirSync(path.join(home2, '.claude'), { recursive: true });
  makeDb(db2, false).close();
  const seen = path.join(pc2, 'E', 'Team One (t1)');
  fs.cpSync(pkgT, seen, { recursive: true });
  r = run('import', { package: seen }, null, db2, home2);
  check('another PC: import ok', r.code === 0 && r.out.imported.mode === 'new', r.raw);
  const d2 = new DatabaseSync(db2, { readOnly: true });
  const convs2 = d2.prepare('SELECT id, user_id, extra FROM conversations ORDER BY id').all();
  const team2 = d2.prepare('SELECT workspace, user_id FROM teams').get();
  const nMsg2 = d2.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
  const mb2 = d2.prepare('SELECT files FROM mailbox').get();
  d2.close();
  check('another PC: the team and both members came in, as this PC\'s user', convs2.length === 2 && convs2.every((c) => c.user_id === 'u9') && team2.user_id === 'u9', JSON.stringify(convs2));
  check('another PC: paths are where the drive is there', JSON.parse(convs2[0].extra).workspace === path.join(seen, 'workspace') && team2.workspace === path.join(seen, 'workspace') && JSON.parse(mb2.files)[0] === path.join(seen, 'workspace', 'a.txt'), JSON.stringify([convs2[0].extra, team2.workspace]));
  check('another PC: messages (2)', nMsg2 === 2, nMsg2);
  check('another PC: the lead\'s history where Claude looks there, its paths rewritten', (() => { try { const f = path.join(home2, '.claude', 'projects', mangle(path.join(seen, 'workspace')), 's-t1.jsonl'); return JSON.parse(fs.readFileSync(f, 'utf8')).cwd === path.join(seen, 'workspace'); } catch (e) { return false; } })());
  // back on the first PC both sides change while apart
  const man = JSON.parse(fs.readFileSync(path.join(seen, 'aiondx-chat.json'), 'utf8'));
  const lastSync = { version: man.version, exportedAt: man.exportedAt };
  r = run('import', { package: seen, lastSync }, null, db2, home2);
  check('another PC: same as last time is skipped', r.code === 0 && /as the package has it/.test(r.out.imported.skipped || ''), r.raw);
  { const d = new DatabaseSync(db2); d.prepare("INSERT INTO messages (id, conversation_id, content, created_at) VALUES ('x2','m1','on pc2',90)").run(); d.prepare("UPDATE conversations SET updated_at = 300 WHERE id = 'm1'").run(); d.close(); }
  const man2 = Object.assign({}, man, { exportedAt: man.exportedAt + 5000 });
  fs.writeFileSync(path.join(seen, 'aiondx-chat.json'), JSON.stringify(man2));
  r = run('import', { package: seen, lastSync }, null, db2, home2);
  check('both changed: the drive\'s comes in as a copy', r.code === 0 && r.out.imported.mode === 'copy' && r.out.imported.id !== 't1', r.raw);
  const d3 = new DatabaseSync(db2, { readOnly: true });
  const teams3 = d3.prepare('SELECT id, name FROM teams ORDER BY name').all();
  const nConv3 = d3.prepare('SELECT COUNT(*) AS n FROM conversations').get().n;
  const kept = d3.prepare("SELECT content FROM messages WHERE id = 'x2'").get();
  d3.close();
  check('both changed: two teams, four member chats, this PC\'s change kept', teams3.length === 2 && /from the drive/.test(teams3[1].name) && nConv3 === 4 && !!kept, JSON.stringify(teams3) + ' ' + nConv3);
  // only the drive changed: replaced
  const db3 = path.join(BASE, 'pc3', 'AionDX', 'aionui', 'aiondx-backend.db');
  makeDb(db3, false).close();
  r = run('import', { package: seen }, null, db3, home2);
  const man3 = JSON.parse(fs.readFileSync(path.join(seen, 'aiondx-chat.json'), 'utf8'));
  { const d = new DatabaseSync(db3); r.v = d.prepare("SELECT COUNT(*) AS n FROM messages").get().n; d.close(); }
  const ls3 = { version: (() => { const d = new DatabaseSync(db3, { readOnly: true }); try { return require(TOOL).localVersion(d, { convIds: man3.convIds }); } finally { d.close(); } })(), exportedAt: man3.exportedAt };
  fs.writeFileSync(path.join(seen, 'aiondx-chat.json'), JSON.stringify(Object.assign({}, man3, { exportedAt: man3.exportedAt + 1 })));
  r = run('import', { package: seen, lastSync: ls3 }, null, db3, home2);
  { const d = new DatabaseSync(db3, { readOnly: true }); r.n = d.prepare('SELECT COUNT(*) AS n FROM teams').get().n; d.close(); }
  check('only the drive changed: replaced in place, one team', r.code === 0 && r.out.imported.mode === 'replace' && r.n === 1, r.raw);

  // a move to the other drive undone: the original folder was removed once the copy was checked; undo copies it back
  r = run('move', { items: [{ kind: 'c', id: 'c4' }], to: DRIVE_DIR });
  const j4d = r.out && r.out.moved && r.out.moved[0].journal;
  check('other drive: moved, the original folder gone', r.code === 0 && !fs.existsSync(ws.c4), r.raw);
  r = run('undo', { journal: j4d });
  check('other drive: undo copies it back and removes the drive\'s copy', r.code === 0 && r.out.undone === true && fs.readFileSync(path.join(ws.c4, 'sub', 'b.txt'), 'utf8').length === 1000 &&
    !fs.existsSync(path.join(DRIVE_DIR, 'Chat c4 (c4)')) && extraWs('c4') === ws.c4, r.raw);
  check('other drive: the drive no longer lists it', !JSON.parse(fs.readFileSync(DRIVE_INDEX, 'utf8')).packages.some((p) => p.id === 'c4'));

  // and the team back from the drive
  r = run('back', { items: [{ kind: 't', id: 't1' }] });
  check('team: back from the drive ok', r.code === 0, r.raw);
  check('team: everything as before it left', snapshot() === original && fs.existsSync(path.join(ws.t1, 'a.txt')) && fs.existsSync(path.join(ws.m2, 'a.txt')));
  check('team: histories back', fs.existsSync(path.join(hist(ws.t1), 's-t1.jsonl')) && fs.existsSync(path.join(hist(ws.m2), 's-m2.jsonl')));
  const idx2 = fs.existsSync(DRIVE_INDEX) ? JSON.parse(fs.readFileSync(DRIVE_INDEX, 'utf8')) : { packages: [] };
  check('team: the drive no longer lists it', !idx2.packages.some((p) => p.id === 't1'));
}

clearTimeout(deadline);
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
