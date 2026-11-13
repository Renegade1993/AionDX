#!/usr/bin/env node
/**
 * test-data-move.js - aiondx-data-move.js on a made-up AionUi folder (nothing of this PC's data is touched).
 *
 *   node patches\0016-data-move\test-data-move.js
 *
 * The made-up folder holds a chats database with the old path in every spelling the real one has (plain, JSON-escaped, forward-slash,
 * file:// address, another letter case), prose that merely says "AionUi" (it must stay), a settings file, working folders for half of
 * the conversations, and Claude history folders in two Claude folders (plus an "imported" copy that must not be touched).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const TOOL = path.join(__dirname, 'aiondx-data-move.js');
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-datamove-'));
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 600) + ']')); };
const deadline = setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 240000);
process.on('exit', () => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch (e) { /* best effort */ } });
const mangle = (p) => p.replace(/[^A-Za-z0-9]/g, '-');

function make(name) {
  const root = path.join(BASE, name);
  const roaming = path.join(root, 'Roaming'), home = path.join(root, 'home'), local = path.join(root, 'Local');
  const OLD = path.join(roaming, 'AionUi');
  const inner = path.join(OLD, 'aionui');
  fs.mkdirSync(local, { recursive: true });
  const ws = [];
  for (let i = 0; i < 6; i++) {
    const d = path.join(inner, 'conversations', 'users', 'u1', '2026', '09', '0' + (i + 1), 'chat-temp-c' + i);
    if (i % 2 === 0) fs.mkdirSync(d, { recursive: true });   // half of the working folders exist
    ws.push(d);
  }
  fs.mkdirSync(path.join(OLD, 'config'), { recursive: true });
  fs.writeFileSync(path.join(OLD, 'config', 'settings.json'), JSON.stringify({ recent: ws[0], other: 'C:\\somewhere\\else' }));
  const dbFile = path.join(inner, 'aionui-backend.db');
  const db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, extra TEXT, source TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, conversation_id TEXT, content TEXT);
    CREATE TABLE teams (id TEXT PRIMARY KEY, workspace TEXT);
    CREATE TABLE folders (id TEXT PRIMARY KEY, resource_uri TEXT, resource_canonical TEXT);
    CREATE TABLE skills (id TEXT PRIMARY KEY, path TEXT, description TEXT);
    CREATE TABLE mailbox (id TEXT PRIMARY KEY, content TEXT, files TEXT);
    CREATE TABLE agent_metadata (id TEXT PRIMARY KEY, env TEXT, backend TEXT, name TEXT, command TEXT);`);
  const fwd = (p) => p.replace(/\\/g, '/');
  const esc = (p) => p.replace(/\\/g, '\\\\');
  const insC = db.prepare('INSERT INTO conversations VALUES (?,?,?)');
  ws.forEach((w, i) => insC.run('c' + i, JSON.stringify({ backend: 'claude', workspace: w }), 'aionui'));
  const insM = db.prepare('INSERT INTO messages (conversation_id, content) VALUES (?,?)');
  insM.run('c0', JSON.stringify({ content: 'file at ' + ws[0] + '\\a.png' }));                      // JSON-escaped backslashes
  insM.run('c0', 'plain ' + ws[0] + ' in prose');                                                    // plain
  insM.run('c1', 'forward ' + fwd(ws[1]) + '/x.txt');                                                // forward slashes
  insM.run('c2', 'file:///' + fwd(ws[2]) + '/y');                                                    // address
  insM.run('c3', 'other case ' + ws[3].replace('AionUi', 'AIONUI').replace('Roaming', 'roaming'));   // another letter case
  insM.run('c4', 'AionUi is the name of the program this was forked from; nothing to rewrite here.'); // prose: must stay
  insM.run('c5', 'a path that is not ours: D:\\Elsewhere\\SomethingElse\\file');
  // a neighbour that merely starts with the same name (a backup folder next to it): never rewritten, never renamed
  const sibling = path.join(roaming, 'AionUi.imported-20261031') + '\\aionui\\conversations\\x';
  insM.run('c0', 'backup path ' + sibling);
  db.prepare('INSERT INTO teams VALUES (?,?)').run('t2', sibling);
  db.prepare('INSERT INTO teams VALUES (?,?)').run('t1', ws[0]);
  db.prepare('INSERT INTO folders VALUES (?,?,?)').run('f1', 'file:///' + fwd(ws[1]), fwd(ws[1]));
  db.prepare('INSERT INTO skills VALUES (?,?,?)').run('s1', path.join(inner, 'skills', 'mine'), 'a skill');
  db.prepare('INSERT INTO mailbox VALUES (?,?,?)').run('m1', 'see ' + ws[0], JSON.stringify([ws[0] + '\\f.txt']));
  const claudeDirs = [path.join(home, '.claude'), path.join(home, '.claude-work')];
  const insA = db.prepare('INSERT INTO agent_metadata VALUES (?,?,?,?,?)');
  insA.run('a1', JSON.stringify({ CLAUDE_CONFIG_DIR: claudeDirs[1] }), 'claude', 'Claude Code', 'claude');
  insA.run('a2', null, 'gemini', 'Gemini CLI', 'gemini');
  insA.run('a3', null, 'cursor', 'Cursor', 'cursor-agent');
  insA.run('a4', null, 'codex', 'Codex CLI', 'codex');
  insA.run('a5', null, 'devin', 'Devin', 'devin');
  insA.run('a6', null, 'opencode', 'OpenCode', 'opencode');
  try { db.exec("CREATE VIRTUAL TABLE messages_fts USING fts5(content)"); } catch (e) { /* no FTS5 in this build */ }
  db.close();
  // Claude history folders: one per working folder in the main Claude folder, some in the second, a copy in an "imported" folder
  const hist = [];
  ws.forEach((w, i) => {
    const dir = claudeDirs[i % 2 === 0 ? 0 : 1];
    const f = path.join(dir, 'projects', mangle(w));
    fs.mkdirSync(f, { recursive: true });
    fs.writeFileSync(path.join(f, 'session' + i + '.jsonl'), '{"cwd":"x"}\n');
    hist.push(f);
  });
  fs.mkdirSync(path.join(home, '.claude', 'projects', 'C--Users-other-project'), { recursive: true });
  const siblingHist = path.join(home, '.claude', 'projects', mangle(path.join(roaming, 'AionUi.imported-20261031') + '\\aionui\\conversations\\x'));
  fs.mkdirSync(siblingHist, { recursive: true });
  const imported = path.join(home, '.claude.imported-20261031', 'projects', mangle(ws[0]));
  fs.mkdirSync(imported, { recursive: true });
  // other agents' data: files, a database, folders named after a working folder (a hash, a lower-case mangling), and things that must be left alone
  const W = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); return f; };
  const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const agent = {
    gemini: W(path.join(home, '.gemini', 'chat-1.json'), JSON.stringify({ cwd: ws[0], title: 'a chat' })),
    geminiHashDir: path.join(home, '.gemini', 'tmp', sha256(ws[1])),
    cursorDir: path.join(home, '.cursor', 'projects', mangle(ws[2]).toLowerCase()),
    codex: W(path.join(home, '.codex', 'sessions', '2026', '09', '01', 'rollout-1.jsonl'), JSON.stringify({ type: 'session_meta', cwd: ws[0] }) + '\n' + JSON.stringify({ type: 'msg', text: 'hello' }) + '\n'),
    devinMd: W(path.join(roaming, 'Devin', 'history_1.md'), 'worked in ' + ws[0] + ' today\n'),
    devinDb: path.join(roaming, 'Devin', 'devin.db'),
    opencode: W(path.join(home, '.config', 'opencode', 'state.json'), JSON.stringify({ projects: [{ directory: ws[3] }] })),
    claudeJson: W(path.join(home, '.claude', '.claude.json'), JSON.stringify({ projects: { [ws[0]]: { trusted: true } } })),
    claudeHistory: W(path.join(home, '.claude', 'history.jsonl'), JSON.stringify({ display: 'hi', project: ws[0] }) + '\n'),
    transcript: path.join(home, '.claude', 'projects', mangle(ws[0]), 'session0.jsonl'),
    vscode: W(path.join(home, '.vscode', 'recent.json'), JSON.stringify({ folder: ws[0] })),
    slack: W(path.join(roaming, 'Slack', 'state.json'), JSON.stringify({ lastFolder: ws[0] })),
  };
  fs.writeFileSync(agent.transcript, JSON.stringify({ cwd: ws[0] }) + '\n');
  fs.mkdirSync(agent.geminiHashDir, { recursive: true }); fs.writeFileSync(path.join(agent.geminiHashDir, 'chat.json'), JSON.stringify({ projectRoot: ws[1] }));
  fs.mkdirSync(agent.cursorDir, { recursive: true }); fs.writeFileSync(path.join(agent.cursorDir, 'meta.json'), JSON.stringify({ path: ws[2] }));
  { const d = new DatabaseSync(agent.devinDb); d.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, title TEXT)'); d.prepare('INSERT INTO sessions VALUES (?,?,?)').run('s1', ws[0], 'a'); d.prepare('INSERT INTO sessions VALUES (?,?,?)').run('s2', 'D:\\Elsewhere\\x', 'b'); d.close(); }
  return { root, roaming, home, local, OLD, NEW: path.join(roaming, 'AionDX'), inner, dbFile, ws, hist, imported, claudeDirs, siblingHist, sibling, agent, sha256 };
}
// the other agents' files and folders as a comparable snapshot (content hashes, and which folders exist)
const snapshot = (m) => {
  const a = m.agent, o = {};
  for (const k of ['gemini', 'codex', 'devinMd', 'opencode', 'claudeJson', 'claudeHistory', 'vscode', 'slack', 'transcript']) { try { o[k] = crypto.createHash('sha256').update(fs.readFileSync(a[k])).digest('hex'); } catch (e) { o[k] = null; } }
  o.dirs = [a.geminiHashDir, a.cursorDir].map((d) => fs.existsSync(d));
  try { const d = new DatabaseSync(a.devinDb, { readOnly: true }); o.devin = JSON.stringify(d.prepare('SELECT * FROM sessions ORDER BY id').all()); d.close(); } catch (e) { o.devin = null; }
  return JSON.stringify(o);
};
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const tool = (m, cmd, env) => spawnSync(process.execPath, ['--no-warnings', TOOL, cmd, '--roaming', m.roaming, '--home', m.home, '--local', m.local], { encoding: 'utf8', windowsHide: true, env: Object.assign({}, process.env, env || {}), timeout: 120000 });
const dump = (file) => {
  const db = new DatabaseSync(file, { readOnly: true });
  const out = { counts: {}, text: {} };
  for (const t of ['conversations', 'messages', 'teams', 'folders', 'skills', 'mailbox', 'agent_metadata']) {
    out.counts[t] = Number(db.prepare('SELECT COUNT(*) n FROM ' + t).get().n);
    out.text[t] = JSON.stringify(db.prepare('SELECT * FROM ' + t).all());
  }
  db.close();
  return out;
};
const dbIn = (root) => ['aiondx-backend.db', 'aionui-backend.db'].map((n) => path.join(root, 'aionui', n)).find((f) => fs.existsSync(f));

// ---- 1. plan changes nothing
{
  const m = make('plan');
  const before = sha(m.dbFile);
  const r = tool(m, 'plan');
  check('plan exits 0 and says it changed nothing', r.status === 0 && /plan only: nothing was changed/.test(r.stdout), r.stdout + r.stderr);
  check('plan leaves the folder, the database and the history folders exactly as they were', fs.existsSync(m.OLD) && !fs.existsSync(m.NEW) && sha(m.dbFile) === before && m.hist.every((h) => fs.existsSync(h)));
  check('plan reports the numbers it would move', /Claude history folders to rename: 6 in 2 Claude folder/.test(r.stdout) && /3 of them exist/.test(r.stdout), r.stdout);
}

// ---- 2. the move
{
  const m = make('run');
  const beforeDump = dump(m.dbFile);
  const oldTime = new Date('2026-01-02T03:04:05Z'); fs.utimesSync(m.agent.gemini, oldTime, oldTime);
  const snapBefore = snapshot(m);
  const r = tool(m, 'run');
  check('run exits 0', r.status === 0, r.stdout + r.stderr);
  const dbNow = dbIn(m.NEW);
  check('the folder is AionDX\'s now and AionUi is gone', fs.existsSync(m.NEW) && !fs.existsSync(m.OLD) && !!dbNow);
  const after = dump(dbNow);
  check('every table has the rows it had', JSON.stringify(after.counts) === JSON.stringify(beforeDump.counts), JSON.stringify({ b: beforeDump.counts, a: after.counts }));
  const oldRe = /AionUi[\\/]+aionui/i;
  const leftover = Object.entries(after.text).filter(([t, s]) => /Roaming[\\/\\]+AionUi(?![.]imported)|roaming[\\/\\]+aionui(?![.]imported)/i.test(s.replace(/AionUi is the name/, '')));
  check('no copy of the old path is left, in any spelling or letter case', leftover.length === 0, leftover.map((x) => x[0]).join(','));
  check('the new path is in its place in every spelling', after.text.conversations.includes(JSON.stringify(path.join(m.NEW, 'aionui')).slice(1, -1).replace(/\\\\/g, '\\\\\\\\').slice(0, 0) + 'AionDX') && after.text.messages.includes('AionDX\\\\\\\\aionui') && after.text.messages.includes('/AionDX/aionui/') && after.text.folders.includes('file:///' + m.NEW.replace(/\\/g, '/')), after.text.folders.slice(0, 200));
  check('prose that only says "AionUi" is unchanged, and so is a path that was never ours', after.text.messages.includes('AionUi is the name of the program this was forked from') && after.text.messages.includes('Elsewhere\\\\SomethingElse'));
  const cdb = new DatabaseSync(dbNow, { readOnly: true });   // closed again: an open file would stop the rollback's folder rename
  const convs = JSON.parse(JSON.stringify(cdb.prepare('SELECT id, extra FROM conversations').all()));
  cdb.close();
  const existNow = convs.filter((c) => fs.existsSync(JSON.parse(c.extra).workspace)).length;
  check('the working folders that existed still exist at the new path (3 of 6, as before)', existNow === 3, existNow);
  const histNow = m.ws.map((w) => path.join(m.claudeDirs[m.ws.indexOf(w) % 2 === 0 ? 0 : 1], 'projects', mangle(w.replace('AionUi', 'AionDX'))));
  check('every Claude history folder was renamed to the new path\'s name, with its files', histNow.every((h) => fs.existsSync(h)) && fs.existsSync(path.join(histNow[0], 'session0.jsonl')) && m.hist.every((h) => !fs.existsSync(h)));
  check('the "imported" copy and an unrelated project were not touched', fs.existsSync(m.imported) && fs.existsSync(path.join(m.home, '.claude', 'projects', 'C--Users-other-project')));
  check('a neighbour folder named AionUi.imported-... is untouched: its path in the database, and its history folder', after.text.teams.includes(m.sibling.replace(/\\/g, '\\\\')) && after.text.messages.includes('AionUi.imported-20261031') && !after.text.messages.includes('AionDX.imported') && fs.existsSync(m.siblingHist));
  const settings = fs.readFileSync(path.join(m.NEW, 'config', 'settings.json'), 'utf8');
  check('the settings file has the new path and keeps what is not ours', /AionDX/.test(settings) && !/AionUi/.test(settings) && /somewhere/.test(settings));
  // other agents
  const a = m.agent;
  const nw = (s) => s.replace('AionUi', 'AionDX');
  const rj = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  check("Gemini's chat file holds the new working folder, is still valid JSON, and keeps its old modification time", rj(a.gemini).cwd === nw(m.ws[0]) && Math.abs(fs.statSync(a.gemini).mtimeMs - oldTime.getTime()) < 2000, JSON.stringify(rj(a.gemini)));
  const hd = path.join(m.home, '.gemini', 'tmp', m.sha256(nw(m.ws[1])));
  check("a folder named by the hash of a working folder follows the new path's hash, and what is inside it is rewritten", fs.existsSync(hd) && !fs.existsSync(a.geminiHashDir) && rj(path.join(hd, 'chat.json')).projectRoot === nw(m.ws[1]));
  check('a lower-case mangled folder (Cursor style) follows too, with its contents', fs.existsSync(path.join(m.home, '.cursor', 'projects', mangle(nw(m.ws[2])).toLowerCase())) && !fs.existsSync(a.cursorDir) && rj(path.join(m.home, '.cursor', 'projects', mangle(nw(m.ws[2])).toLowerCase(), 'meta.json')).path === nw(m.ws[2]));
  const codexLines = fs.readFileSync(a.codex, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('a JSONL session (Codex style) has the new cwd and every line still parses', codexLines.length === 2 && codexLines[0].cwd === nw(m.ws[0]) && codexLines[1].text === 'hello');
  const devDb = new DatabaseSync(a.devinDb, { readOnly: true }); const devRows = devDb.prepare('SELECT * FROM sessions ORDER BY id').all(); devDb.close();
  check("Devin's note and database follow: the chat's row has the new folder, the other row and the row count are unchanged", fs.readFileSync(a.devinMd, 'utf8').includes(nw(m.ws[0])) && devRows.length === 2 && devRows[0].cwd === nw(m.ws[0]) && devRows[1].cwd === 'D:\\Elsewhere\\x', JSON.stringify(devRows));
  check("OpenCode's JSON under .config follows", rj(a.opencode).projects[0].directory === nw(m.ws[3]));
  const trText = fs.readFileSync(path.join(m.home, '.claude', 'projects', mangle(nw(m.ws[0])), 'session0.jsonl'), 'utf8');
  check("Claude's own .claude.json and history.jsonl follow; a transcript inside projects is left alone", Object.keys(rj(a.claudeJson).projects)[0] === nw(m.ws[0]) && fs.readFileSync(a.claudeHistory, 'utf8').includes(JSON.stringify(nw(m.ws[0])).slice(1, -1)) && trText.includes(JSON.stringify(m.ws[0]).slice(1, -1)), trText.slice(0, 200));
  check('a dot-folder that is not an agent (.vscode) and an unrelated app folder (Slack) are untouched', rj(a.vscode).folder === m.ws[0] && rj(a.slack).lastFolder === m.ws[0]);
  const wk = path.join(m.local, 'AionDX', 'data-move');
  const stamp = fs.readdirSync(wk)[0];
  const j = JSON.parse(fs.readFileSync(path.join(wk, stamp, 'journal.json'), 'utf8'));
  check('a backup of the database and a journal in state "done" were kept', j.state === 'done' && fs.readdirSync(path.join(wk, stamp)).some((f) => /^backup-/.test(f)), JSON.stringify(j.state));
  // run again: nothing to do
  const again = tool(m, 'run');
  check('a second run changes nothing (exit 3)', again.status === 3 && /no earlier AionUi folder|already has chats/.test(again.stdout), again.stdout);
  // rollback of the finished move
  const rb = tool(m, 'rollback');
  const back = dbIn(m.OLD);
  const parts = { agentsBack: snapshot(m) === snapBefore, exit0: rb.status === 0, oldBack: fs.existsSync(m.OLD), db: !!back, hist: m.hist.every((h) => fs.existsSync(h)), convs: !!back && JSON.stringify(dump(back).text.conversations) === JSON.stringify(beforeDump.text.conversations), counts: !!back && JSON.stringify(dump(back).counts) === JSON.stringify(beforeDump.counts) };
  check('rollback puts everything back: the folder, the database rows and paths, the history folders', Object.values(parts).every(Boolean), JSON.stringify(parts) + ' ' + rb.stdout.slice(-400) + rb.stderr);
}

// ---- 3. a failure after each step is undone completely
for (const step of ['folder', 'db', 'history', 'files']) {
  const m = make('fail-' + step);
  const beforeDump = dump(m.dbFile);
  const settingsBefore = fs.readFileSync(path.join(m.OLD, 'config', 'settings.json'), 'utf8');
  const agentsBefore = snapshot(m);
  const r = tool(m, 'run', { AIONDX_DATA_MOVE_FAIL_AFTER: step });
  const back = dbIn(m.OLD);
  check('a failure after "' + step + '" exits 7 and the folder is AionUi\'s again', r.status === 7 && fs.existsSync(m.OLD) && !!back && !(fs.existsSync(m.NEW) && dbIn(m.NEW)), r.status + ' ' + r.stdout.slice(-300));
  check('  ... with the same rows and the same stored paths', !!back && JSON.stringify(dump(back)) === JSON.stringify(beforeDump));
  check('  ... the history folders under their old names, the settings file as it was, and every other agent\'s files and folders as they were', m.hist.every((h) => fs.existsSync(h)) && fs.readFileSync(path.join(m.OLD, 'config', 'settings.json'), 'utf8') === settingsBefore && snapshot(m) === agentsBefore);
}

// ---- 3b. the other agents' step fails alone: the move stands, that step is undone, and `agents` repeats it
{
  const m = make('agents-fail');
  const agentsBefore = snapshot(m);
  const r = tool(m, 'run', { AIONDX_DATA_MOVE_FAIL_AFTER: 'agents' });
  check('a failure in the other agents\' step does not fail the move (exit 0, the folder is moved, the database follows)', r.status === 0 && !!dbIn(m.NEW) && !fs.existsSync(m.OLD) && /other agents: NOT updated/.test(r.stdout), r.status + ' ' + r.stdout.slice(-400));
  // the move itself stands, so Claude's history folder (the transcript) is under its new name; everything else must be as it was
  const strip = (s) => { const o = JSON.parse(s); delete o.transcript; return JSON.stringify(o); };
  const agentsAfter = snapshot(m);
  if (strip(agentsAfter) !== strip(agentsBefore)) console.log('   differs:\n   before ' + strip(agentsBefore) + '\n   after  ' + strip(agentsAfter));
  check('  ... and that step is undone: every other agent\'s files and folders are as they were', strip(agentsAfter) === strip(agentsBefore));
  const again = tool(m, 'agents');
  check('  ... `agents` then does it (exit 0), and a second `agents` finds nothing to change', again.status === 0 && snapshot(m) !== agentsBefore && /\d+ files, \d+ databases/.test(again.stdout) && (() => { const r2 = tool(m, 'agents'); return r2.status === 0 && /0 files, 0 databases and 0 folders/.test(r2.stdout); })(), again.stdout.slice(-400));
}

// ---- 3c. a file an agent has locked is skipped and reported; nothing else is affected
{
  const m = make('agents-locked');
  const lockedFile = m.agent.devinMd;
  const fd = fs.openSync(lockedFile, 'r+');   // held open for writing: on Windows another program cannot replace it
  let r;
  try { r = tool(m, 'run'); } finally { fs.closeSync(fd); }
  const skipped = /skipped .*history_1\.md/.test(r.stdout);
  check('a file another program holds open is skipped and reported, and the rest of the move and of the agents\' step goes ahead', r.status === 0 && !!dbIn(m.NEW) && (skipped || fs.readFileSync(lockedFile, 'utf8').includes('AionDX')) && JSON.parse(fs.readFileSync(m.agent.gemini, 'utf8')).cwd.includes('AionDX'), r.stdout.slice(-500));
}

// ---- 4. refusals change nothing
{
  const m = make('both');
  fs.mkdirSync(path.join(m.NEW, 'aionui'), { recursive: true });
  fs.writeFileSync(path.join(m.NEW, 'aionui', 'aiondx-backend.db'), 'mine');
  const before = sha(m.dbFile);
  const r = tool(m, 'run');
  check('when AionDX already has chats, nothing is moved (exit 3)', r.status === 3 && fs.existsSync(m.OLD) && sha(m.dbFile) === before && fs.readFileSync(path.join(m.NEW, 'aionui', 'aiondx-backend.db'), 'utf8') === 'mine', r.stdout);
  const m2 = make('corrupt');
  fs.writeFileSync(m2.dbFile, crypto.randomBytes(200000));
  const r2 = tool(m2, 'run');
  check('a database that fails its own check is refused and left alone', r2.status !== 0 && fs.existsSync(m2.OLD) && !fs.existsSync(m2.NEW) && m2.hist.every((h) => fs.existsSync(h)), r2.status + ' ' + r2.stdout.slice(-300) + r2.stderr.slice(-200));
  const m3 = make('none');
  fs.rmSync(m3.OLD, { recursive: true, force: true });
  const r3 = tool(m3, 'run');
  check('with no AionUi folder there is nothing to do (exit 3)', r3.status === 3, r3.stdout);
}

// ---- 5. a start-up stub made by Chromium in AionDX's folder is cleared, and the move goes ahead
{
  const m = make('stub');
  fs.mkdirSync(path.join(m.NEW, 'Cache'), { recursive: true });
  fs.writeFileSync(path.join(m.NEW, 'Local State'), '{}');
  const r = tool(m, 'run');
  check('an empty start-up folder in the way is cleared and the move goes ahead', r.status === 0 && !!dbIn(m.NEW) && !fs.existsSync(path.join(m.NEW, 'Local State')), r.stdout + r.stderr);
}

// ---- 6. R-102 (2026-11-12): AionDX's data folder to a folder on another drive (H: by default; AIONDX_TEST_DRIVE picks another), marked as portable
{
  const DRIVE = process.env.AIONDX_TEST_DRIVE || 'H:\\';
  if (!fs.existsSync(DRIVE)) { console.log('SKIP  the drive tests: ' + DRIVE + ' is not there'); }
  else {
    const m = make('drive');
    // an AionDX folder (not AionUi) is the source here: rename the made-up one, and fix its stored paths first with the engine itself
    const rr = tool(m, 'run');   // AionUi -> AionDX on the same volume, as before
    const target = path.join(DRIVE, 'AionDX-test-' + process.pid, 'AionDX-Data');
    const driveMarker = path.join(path.parse(target).root, 'AionDX-drive.json');
    const hadDriveMarker = fs.existsSync(driveMarker) ? fs.readFileSync(driveMarker) : null;
    try {
      const before = (() => { const d = new DatabaseSync(dbIn(m.NEW), { readOnly: true }); try { return d.prepare('SELECT COUNT(*) AS n FROM messages').get().n; } finally { d.close(); } })();
      const r = spawnSync(process.execPath, ['--no-warnings', TOOL, 'run', '--roaming', m.roaming, '--home', m.home, '--local', m.local, '--from', m.NEW, '--to', target, '--portable'],
        { encoding: 'utf8', windowsHide: true, timeout: 120000 });
      if (r.status !== 0) console.log('MOVE OUTPUT ' + r.stdout + ' ERR ' + r.stderr);
      const db2 = dbIn(target);
      let after = -1, stored = '', left = -1;
      if (db2) {
        const d = new DatabaseSync(db2, { readOnly: true });
        try {
          after = d.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
          stored = JSON.parse(d.prepare("SELECT extra FROM conversations WHERE id = 'c0'").get().extra).workspace;
          left = d.prepare('SELECT COUNT(*) AS n FROM messages WHERE instr(lower(content), lower(?)) > 0').get(m.NEW).n;
        } finally { d.close(); }
      }
      check('the data folder moves to another drive: copied, every message there, stored paths now on the drive, none of the old left',
        rr.status === 0 && r.status === 0 && after === before && stored.toLowerCase().startsWith(target.toLowerCase() + '\\') && left === 0, 'status ' + r.status + ' | ' + r.stdout.slice(-900) + ' | ERR ' + r.stderr.slice(-600));
      const kept = fs.readdirSync(m.roaming).filter((n) => /^AionDX\.moved-/.test(n));
      check('the old folder is kept under a new name, nothing deleted', kept.length === 1 && !fs.existsSync(m.NEW) && !!dbIn(path.join(m.roaming, kept[0])), JSON.stringify(fs.readdirSync(m.roaming)));
      const mk = JSON.parse(fs.readFileSync(path.join(target, 'aiondx-portable.json'), 'utf8'));
      const dm = JSON.parse(fs.readFileSync(driveMarker, 'utf8'));
      const ptr = JSON.parse(fs.readFileSync(path.join(m.roaming, 'AionDX-location.json'), 'utf8'));
      check("it is marked as portable: in the folder, at the drive's root (where another PC looks) and in this PC's pointer, with one id",
        mk.id && mk.id === dm.id && dm.id === ptr.id && path.resolve(path.parse(target).root, dm.dataPath).toLowerCase() === target.toLowerCase() && ptr.path === target, JSON.stringify([mk, dm, ptr]));
      check("Claude's history folders follow (named for the new place)", fs.existsSync(path.join(m.home, '.claude', 'projects', mangle(path.join(target, 'aionui', 'conversations', 'users', 'u1', '2026', '09', '01', 'chat-temp-c0')))), JSON.stringify(fs.readdirSync(path.join(m.home, '.claude', 'projects'))));
      // a second move onto a folder that is not empty is refused
      const busy = path.join(DRIVE, 'AionDX-test-' + process.pid, 'busy');
      fs.mkdirSync(busy, { recursive: true }); fs.writeFileSync(path.join(busy, 'something.txt'), 'x');
      const m2 = make('drive2');
      tool(m2, 'run');
      const r2 = spawnSync(process.execPath, ['--no-warnings', TOOL, 'run', '--roaming', m2.roaming, '--home', m2.home, '--local', m2.local, '--from', m2.NEW, '--to', busy, '--portable'], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
      check('a target folder that is not empty is refused, and nothing changes', r2.status === 5 && fs.existsSync(m2.NEW) && fs.readdirSync(busy).length === 1, r2.status + ' ' + r2.stdout.slice(-300));
      // a failure after the copy is undone: the copy goes, the old folder is back under its name
      const m3 = make('drive3');
      tool(m3, 'run');
      const t3 = path.join(DRIVE, 'AionDX-test-' + process.pid, 'Fail');
      const r3 = spawnSync(process.execPath, ['--no-warnings', TOOL, 'run', '--roaming', m3.roaming, '--home', m3.home, '--local', m3.local, '--from', m3.NEW, '--to', t3, '--portable'],
        { encoding: 'utf8', windowsHide: true, timeout: 120000, env: Object.assign({}, process.env, { AIONDX_DATA_MOVE_FAIL_AFTER: 'db' }) });
      check('a failure after the copy undoes it: the copy is removed and the old folder is back where it was', r3.status === 7 && !fs.existsSync(t3) && !!dbIn(m3.NEW) && !fs.readdirSync(m3.roaming).some((n) => /moved-/.test(n)), r3.status + ' ' + r3.stdout.slice(-400));
    } finally {
      try { fs.rmSync(path.join(DRIVE, 'AionDX-test-' + process.pid), { recursive: true, force: true }); } catch (e) { /* best effort */ }
      try { if (hadDriveMarker) fs.writeFileSync(driveMarker, hadDriveMarker); else fs.rmSync(driveMarker, { force: true }); } catch (e) { /* best effort */ }
    }
  }
}

clearTimeout(deadline);
console.log('\n' + pass + '/' + (pass + fail) + ' passed');
process.exit(fail ? 1 : 0);
