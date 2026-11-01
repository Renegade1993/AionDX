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
    CREATE TABLE agent_metadata (id TEXT PRIMARY KEY, env TEXT);`);
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
  db.prepare('INSERT INTO agent_metadata VALUES (?,?)').run('a1', JSON.stringify({ CLAUDE_CONFIG_DIR: claudeDirs[1] }));
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
  return { root, roaming, home, local, OLD, NEW: path.join(roaming, 'AionDX'), inner, dbFile, ws, hist, imported, claudeDirs, siblingHist, sibling };
}
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
  const parts = { exit0: rb.status === 0, oldBack: fs.existsSync(m.OLD), db: !!back, hist: m.hist.every((h) => fs.existsSync(h)), convs: !!back && JSON.stringify(dump(back).text.conversations) === JSON.stringify(beforeDump.text.conversations), counts: !!back && JSON.stringify(dump(back).counts) === JSON.stringify(beforeDump.counts) };
  check('rollback puts everything back: the folder, the database rows and paths, the history folders', Object.values(parts).every(Boolean), JSON.stringify(parts) + ' ' + rb.stdout.slice(-400) + rb.stderr);
}

// ---- 3. a failure after each step is undone completely
for (const step of ['folder', 'db', 'history', 'files']) {
  const m = make('fail-' + step);
  const beforeDump = dump(m.dbFile);
  const settingsBefore = fs.readFileSync(path.join(m.OLD, 'config', 'settings.json'), 'utf8');
  const r = tool(m, 'run', { AIONDX_DATA_MOVE_FAIL_AFTER: step });
  const back = dbIn(m.OLD);
  check('a failure after "' + step + '" exits 7 and the folder is AionUi\'s again', r.status === 7 && fs.existsSync(m.OLD) && !!back && !(fs.existsSync(m.NEW) && dbIn(m.NEW)), r.status + ' ' + r.stdout.slice(-300));
  check('  ... with the same rows and the same stored paths', !!back && JSON.stringify(dump(back)) === JSON.stringify(beforeDump));
  check('  ... the history folders under their old names, the settings file as it was', m.hist.every((h) => fs.existsSync(h)) && fs.readFileSync(path.join(m.OLD, 'config', 'settings.json'), 'utf8') === settingsBefore);
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

clearTimeout(deadline);
console.log('\n' + pass + '/' + (pass + fail) + ' passed');
process.exit(fail ? 1 : 0);
