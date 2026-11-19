'use strict';
// test-place-move-second-pc.js - a chat placed on one PC and brought in on another (R-132, the laptop diagnosis package of November 17th,
// 2026), and archived chats kept where they are (November 19th, 2026). Made-up databases shaped like AionCore's (AionCore's built-in user
// made first, a custom agent with secrets), in a temporary folder. Nothing real is read or written.
//   node patches\0016-data-move\test-place-move-second-pc.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const TOOL = path.join(__dirname, 'aiondx-place-move.js');
const T = require(TOOL);
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-2ndpc-'));
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 700) + ']')); };
const deadline = setTimeout(() => { console.log('FAIL  deadline'); process.exit(2); }, 240000);

const SCHEMA = `
CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, created_at INTEGER);
CREATE TABLE conversations (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), name TEXT, type TEXT, extra TEXT, created_at INTEGER, updated_at INTEGER, archived_at INTEGER, project_id TEXT, folder_id TEXT);
CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT REFERENCES conversations(id), content TEXT, position TEXT, created_at INTEGER);
CREATE TABLE acp_session (conversation_id TEXT PRIMARY KEY, agent_source TEXT, agent_id TEXT, session_id TEXT, session_config TEXT);
CREATE TABLE conversation_assistant_snapshots (conversation_id TEXT PRIMARY KEY, agent_id TEXT, rules_content TEXT, created_at INTEGER);
CREATE TABLE conversation_artifacts (id TEXT PRIMARY KEY, conversation_id TEXT, kind TEXT, payload TEXT, created_at INTEGER);
CREATE TABLE teams (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, workspace TEXT, agents TEXT, created_at INTEGER, updated_at INTEGER, archived_at INTEGER, project_id TEXT, folder_id TEXT);
CREATE TABLE mailbox (id TEXT PRIMARY KEY, team_id TEXT, content TEXT, created_at INTEGER);
CREATE TABLE team_tasks (id TEXT PRIMARY KEY, team_id TEXT, subject TEXT, created_at INTEGER);
CREATE TABLE agent_metadata (id TEXT PRIMARY KEY NOT NULL, agent_id TEXT NOT NULL, user_id TEXT, name TEXT NOT NULL, backend TEXT, agent_type TEXT NOT NULL, agent_source TEXT NOT NULL, enabled INTEGER NOT NULL, command TEXT, args TEXT, env TEXT, last_check_status TEXT, last_check_error_message TEXT, command_override TEXT, env_override TEXT, sort_order INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`;
const SECRET = 'sk-ant-api03-SECRETKEY';
const TEXT = 'MESSAGE-TEXT-NOT-FOR-JOURNALS';

function makePc(name, users) {
  const pc = path.join(BASE, name), home = path.join(pc, 'home'), db = path.join(pc, 'AionDX', 'aionui', 'aiondx-backend.db');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.dirname(db), { recursive: true });
  const d = new DatabaseSync(db);
  d.exec(SCHEMA);
  // AionCore's own local user is made first, as on a fresh install (0.7 s before the signed-in one on the laptop)
  users.forEach((u, i) => d.prepare('INSERT INTO users VALUES (?,?,?)').run(u, u, 1000 + i));
  d.close();
  return { pc, home, db, work: path.join(pc, 'work') };
}
function run(pc, cmd, args) {
  const jf = path.join(BASE, 'args-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json');
  fs.writeFileSync(jf, JSON.stringify(args));
  const r = spawnSync(process.execPath, [TOOL, cmd, '--db', pc.db, '--home', pc.home, '--work', pc.work, '--json-file', jf], { encoding: 'utf8', timeout: 120000, windowsHide: true });
  let out = null; try { out = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch { /* not JSON */ }
  return { code: r.status, out, raw: (r.stdout || '') + (r.stderr || '') };
}
const q = (pc, sql, ...a) => { const d = new DatabaseSync(pc.db, { readOnly: true }); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const exec = (pc, sql, ...a) => { const d = new DatabaseSync(pc.db); try { d.prepare(sql).run(...a); } finally { d.close(); } };
const allText = (dir) => { let s = ''; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) s += allText(p); else s += fs.readFileSync(p).toString('latin1'); } return s; };

try {
  // ---- the first PC: a chat on a custom agent with secrets, and its Claude history in a second config folder
  const pc1 = makePc('pc1', ['system_default_user', 'u1']);
  const ws = path.join(pc1.pc, 'chats', 'chat-c1');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'a.txt'), 'x');
  exec(pc1, 'INSERT INTO conversations (id, user_id, name, type, extra, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', 'c1', 'u1', 'Harbor Map', 'acp',
    JSON.stringify({ backend: 'claude', workspace: ws, agent_id: 'x123', agent_source: 'custom' }), 1, 100);
  exec(pc1, 'INSERT INTO messages VALUES (?,?,?,?,?)', 'c1-m1', 'c1', TEXT + ' in ' + ws + '\\a.txt', 'right', 10);
  exec(pc1, 'INSERT INTO acp_session VALUES (?,?,?,?,?)', 'c1', 'custom', 'x123', 's1', JSON.stringify({ cwd: ws }));
  exec(pc1, 'INSERT INTO agent_metadata VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', 'am-1', 'x123', 'u1', 'Claude Code (Office)', 'claude', 'acp', 'custom', 1, 'claude', '[]',
    JSON.stringify({ ANTHROPIC_API_KEY: SECRET }), 'ok', 'none', 'C:\\secret\\claude.exe', JSON.stringify({ TOKEN: SECRET }), 0, 1, 1);
  // a second chat, archived and not placed: not listed
  exec(pc1, 'INSERT INTO conversations (id, user_id, name, type, extra, created_at, updated_at, archived_at) VALUES (?,?,?,?,?,?,?,?)', 'c2', 'u1', 'Old', 'acp', JSON.stringify({ workspace: path.join(pc1.pc, 'chats', 'c2') }), 1, 100, 500);
  const cfgWork = path.join(pc1.home, '.claude-work', 'projects', T.mangle(ws));
  fs.mkdirSync(cfgWork, { recursive: true });
  fs.writeFileSync(path.join(cfgWork, 's1.jsonl'), '{"cwd":' + JSON.stringify(ws) + '}\n');

  const place = path.join(pc1.pc, 'drive');
  fs.mkdirSync(place);
  let r = run(pc1, 'move', { items: [{ kind: 'c', id: 'c1' }], to: place });
  check('the chat is placed', r.code === 0, r.raw);
  const pkg = path.join(place, 'Harbor Map (c1)');
  const pk = new DatabaseSync(path.join(pkg, 'aiondx-chat.db'), { readOnly: true });
  const agentRow = pk.prepare('SELECT * FROM agent_metadata').get();
  pk.close();
  check('D2: its custom agent goes in the package', agentRow && agentRow.agent_id === 'x123' && agentRow.name === 'Claude Code (Office)' && agentRow.backend === 'claude', JSON.stringify(agentRow));
  check('D2: with no secret: env emptied, overrides and checks left out', agentRow && agentRow.env === '{}' && agentRow.env_override === null && agentRow.command_override === null && agentRow.last_check_status === null, JSON.stringify(agentRow));
  check('D2: no secret anywhere in the package\'s files', !allText(pkg).includes(SECRET) && !allText(pkg).includes('C:\\secret'));
  const jdir = path.join(pc1.work, 'place-move');
  const journals = fs.readdirSync(jdir).map((n) => fs.readFileSync(path.join(jdir, n, 'journal.json'), 'utf8')).join('\n');
  check('G2: the move\'s journal holds no message text', !journals.includes(TEXT) && /"rows"/.test(journals), journals.slice(0, 300));
  check('G2: it holds the paths it rewrote, to undo with', /pairSets/.test(journals) && journals.includes(JSON.stringify(ws).slice(1, -1)));

  // undo by the journal: the rows come back exactly from the paths alone
  const before = q(pc1, 'SELECT content FROM messages WHERE id = ?', 'c1-m1')[0].content;
  const lastJ = fs.readdirSync(jdir).sort().pop();
  r = run(pc1, 'undo', { journal: path.join(jdir, lastJ, 'journal.json') });
  const undone = q(pc1, 'SELECT content FROM messages WHERE id = ?', 'c1-m1')[0].content;
  check('G2: undo puts the message back exactly, from the paths', r.code === 0 && undone === TEXT + ' in ' + ws + '\\a.txt' && before !== undone, JSON.stringify([before, undone, r.raw]));
  r = run(pc1, 'move', { items: [{ kind: 'c', id: 'c1' }], to: place });
  check('placed again', r.code === 0, r.raw);

  // ---- D6: opening a chat (updated_at only) does not rewrite its package; a new message does
  const m0 = JSON.parse(fs.readFileSync(path.join(pkg, 'aiondx-chat.json'), 'utf8'));
  check('D6: the package\'s version is from what it holds', /^c2\./.test(m0.version), m0.version);
  exec(pc1, 'UPDATE conversations SET updated_at = 999999 WHERE id = ?', 'c1');
  r = run(pc1, 'export', { items: [{ kind: 'c', id: 'c1' }] });
  check('D6: updated_at alone: skipped, the package not written', r.code === 0 && r.out.exported[0].skipped === 'unchanged', r.raw);
  exec(pc1, 'INSERT INTO messages VALUES (?,?,?,?,?)', 'c1-m2', 'c1', 'more', 'left', 20);
  r = run(pc1, 'export', { items: [{ kind: 'c', id: 'c1' }] });
  check('D6: a new message: written', r.code === 0 && !!r.out.exported[0].exported, r.raw);
  // a package written before the change (the old stamp) that still matches is not rewritten after the update
  const m1 = JSON.parse(fs.readFileSync(path.join(pkg, 'aiondx-chat.json'), 'utf8'));
  { const d = new DatabaseSync(pc1.db, { readOnly: true }); m1.version = T.localVersionOld(d, { kind: 'c', id: 'c1', convIds: ['c1'] }); d.close(); }
  fs.writeFileSync(path.join(pkg, 'aiondx-chat.json'), JSON.stringify(m1));
  r = run(pc1, 'export', { items: [{ kind: 'c', id: 'c1' }] });
  check('D6: an old-style stamp that still matches: skipped after the update', r.code === 0 && r.out.exported[0].skipped === 'unchanged', r.raw);
  const m2 = JSON.parse(fs.readFileSync(path.join(pkg, 'aiondx-chat.json'), 'utf8'));
  check('D5: the package keeps a history of who wrote it when', Array.isArray(m2.history) && m2.history.length >= 2 && m2.history.every((h) => h.by && h.at), JSON.stringify(m2.history));

  // ---- the second PC: a fresh install, AionCore's own user first
  const pc2 = makePc('pc2', ['system_default_user', 'u2']);
  const seen = path.join(pc2.pc, 'E', 'Harbor Map (c1)');
  fs.cpSync(pkg, seen, { recursive: true });
  r = run(pc2, 'import', { package: seen });
  check('D1: imported on a fresh install', r.code === 0 && r.out.imported.mode === 'new', r.raw);
  check('D1: the chat is the signed-in user\'s, not AionCore\'s own', q(pc2, 'SELECT user_id FROM conversations')[0].user_id === 'u2' && r.out.imported.owner === 'u2', JSON.stringify(q(pc2, 'SELECT user_id FROM conversations')));
  const a2 = q(pc2, 'SELECT * FROM agent_metadata');
  check('D2: its agent is added here, for that user, the same id and name', a2.length === 1 && a2[0].agent_id === 'x123' && a2[0].user_id === 'u2' && a2[0].name === 'Claude Code (Office)', JSON.stringify(a2));
  check('D2: the result names it, and no agent is missing', JSON.stringify(r.out.imported.agentsAdded) === JSON.stringify([{ agent_id: 'x123', name: 'Claude Code (Office)', backend: 'claude' }]) && r.out.imported.agentsMissing.length === 0, JSON.stringify(r.out.imported));
  check('G5: history from a config folder this PC lacks is said to be folded', JSON.stringify(r.out.imported.historyFolded) === '[".claude-work"]' && fs.existsSync(path.join(pc2.home, '.claude', 'projects', T.mangle(path.join(seen, 'workspace')), 's1.jsonl')), JSON.stringify(r.out.imported));
  const ij = fs.readdirSync(path.join(pc2.work, 'place-move')).map((n) => JSON.parse(fs.readFileSync(path.join(pc2.work, 'place-move', n, 'journal.json'), 'utf8'))).find((j) => /^import/.test(j.cmd));
  check('D3: the import leaves a journal: ids, mode, owner, counts, no text', ij && ij.state === 'imported' && ij.info.owner === 'u2' && ij.info.mode === 'new' && !JSON.stringify(ij).includes(TEXT), JSON.stringify(ij));

  // a PC that already has that agent keeps its own
  const pc4 = makePc('pc4', ['system_default_user', 'u4']);
  exec(pc4, 'INSERT INTO agent_metadata (id, agent_id, user_id, name, backend, agent_type, agent_source, enabled, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', 'mine', 'x123', 'u4', 'Mine', 'claude', 'acp', 'custom', 1, 0, 1, 1);
  r = run(pc4, 'import', { package: seen });
  const a4 = q(pc4, 'SELECT name FROM agent_metadata');
  check('D2: an agent with that id already here is never replaced', r.code === 0 && a4.length === 1 && a4[0].name === 'Mine' && r.out.imported.agentsAdded.length === 0, JSON.stringify([a4, r.out && r.out.imported]));

  // two real users and none named: refused, nothing written; named: that one
  const pc3 = makePc('pc3', ['system_default_user', 'u3a', 'u3b']);
  r = run(pc3, 'import', { package: seen });
  check('D1: two users and none named: refused, nothing written', r.code === 1 && /more than one user/.test(r.out.error) && q(pc3, 'SELECT COUNT(*) AS n FROM conversations')[0].n === 0, r.raw);
  r = run(pc3, 'import', { package: seen, user: 'u3b' });
  check('D1: named by AionDX: that user', r.code === 0 && q(pc3, 'SELECT user_id FROM conversations')[0].user_id === 'u3b', r.raw);
  r = run(makePc('pc6', ['system_default_user', 'u6']), 'import', { package: seen, user: 'nobody' });
  check('D1: a user that is not there: refused', r.code === 1 && /No user nobody/.test(r.out.error), r.raw);

  // ---- archived chats stay where they are kept
  let st = run(pc1, 'status', {});
  check('archived and not placed: not listed', st.code === 0 && !st.out.items.some((i) => i.id === 'c2'), JSON.stringify(st.out && st.out.items.map((i) => i.id)));
  exec(pc1, 'UPDATE conversations SET archived_at = 777 WHERE id = ?', 'c1');
  st = run(pc1, 'status', {});
  const c1s = st.out.items.find((i) => i.id === 'c1');
  check('archived and placed: still listed, marked archived, still placed', c1s && c1s.archived === true && c1s.placed === true, JSON.stringify(c1s));
  r = run(pc1, 'export', { items: [{ kind: 'c', id: 'c1' }] });
  const ma = JSON.parse(fs.readFileSync(path.join(pkg, 'aiondx-chat.json'), 'utf8'));
  check('archiving is a change: the package is written, marked archived', r.code === 0 && !!r.out.exported[0].exported && ma.archived === true, JSON.stringify([r.out, ma.archived]));
  const pc5 = makePc('pc5', ['system_default_user', 'u5']);
  const seen5 = path.join(pc5.pc, 'F', 'Harbor Map (c1)');
  fs.cpSync(pkg, seen5, { recursive: true });
  r = run(pc5, 'import', { package: seen5 });
  check('another PC brings it in archived', r.code === 0 && r.out.imported.archived === true && q(pc5, 'SELECT archived_at FROM conversations')[0].archived_at === 777, r.raw);
  exec(pc1, 'UPDATE conversations SET archived_at = NULL WHERE id = ?', 'c1');
  r = run(pc1, 'export', { items: [{ kind: 'c', id: 'c1' }] });
  check('restored: written again, no longer archived', r.code === 0 && !!r.out.exported[0].exported && JSON.parse(fs.readFileSync(path.join(pkg, 'aiondx-chat.json'), 'utf8')).archived === false, r.raw);

  // ---- D5: a relink can wait to write the package until AionDX has checked the chats are seen
  const pc7 = makePc('pc7', ['system_default_user', 'u7']);
  const at7 = path.join(pc7.pc, 'G', 'Harbor Map (c1)');
  fs.cpSync(pkg, at7, { recursive: true });
  r = run(pc7, 'import', { package: at7 });
  const moved7 = path.join(pc7.pc, 'H', 'Harbor Map (c1)');
  fs.mkdirSync(path.dirname(moved7), { recursive: true });
  fs.renameSync(at7, moved7);
  const before7 = JSON.parse(fs.readFileSync(path.join(moved7, 'aiondx-chat.json'), 'utf8')).exportedAt;
  r = run(pc7, 'relink', { item: { kind: 'c', id: 'c1' }, to: moved7, exportAfter: false });
  const after7 = JSON.parse(fs.readFileSync(path.join(moved7, 'aiondx-chat.json'), 'utf8'));
  check('D5: relinked without writing the package', r.code === 0 && after7.exportedAt === before7 && JSON.parse(q(pc7, 'SELECT extra FROM conversations')[0].extra).workspace === path.join(moved7, 'workspace'), r.raw);

  // ---- D7: Bring back never makes another Windows user's folder
  const users = path.join(BASE, 'Users');
  fs.mkdirSync(path.join(users, 'Me', 'AionDX'), { recursive: true });
  fs.mkdirSync(path.join(users, 'Other', 'AionDX'), { recursive: true });
  check('D7: the first PC\'s folder under another user is not used', !T.homeHere(path.join(users, 'Other', 'AionDX', 'chat'), { home: path.join(users, 'Me') }));
  check('D7: a folder of this user is', T.homeHere(path.join(users, 'Me', 'AionDX', 'chat'), { home: path.join(users, 'Me') }));
  check('D7: a folder whose parent is not on this PC is not', !T.homeHere(path.join(BASE, 'nope', 'deeper', 'chat'), { home: path.join(users, 'Me') }));
} catch (e) {
  check('no exception', false, e.stack);
} finally {
  clearTimeout(deadline);
  try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
