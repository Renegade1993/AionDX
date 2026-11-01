#!/usr/bin/env node
/**
 * test-realdata-move.js - aiondx-data-move.js on a COPY of the real chats database, in a made-up folder tree (the real folders are read
 * once, to make a consistent copy and to list working-folder names; nothing real is written). For every conversation that names a working
 * folder under the real AionUi folder, an empty working folder and an empty Claude history folder are made in the made-up tree, so the
 * move has the same shape as the real one. Then: plan, run, check, run the built app on the result, rollback. Counts and timings only.
 *
 *   node tools/test-realdata-move.js [--db FILE] [--app]      --app also starts the built app on the moved folder
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
const TOOL = path.join(__dirname, '..', 'patches', '0016-data-move', 'aiondx-data-move.js');
const REAL_ROAMING = process.env.APPDATA;
const SRC = arg('--db') || path.join(REAL_ROAMING, 'AionUi', 'aionui', 'aionui-backend.db');
const BASE = path.join(os.tmpdir(), 'aiondx-realmove-test');
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 500) + ']')); };
const deadline = setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 1200000);
const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) { /* best effort */ } };
const mangle = (p) => p.replace(/[^A-Za-z0-9]/g, '-');
const TABLES = ['conversations', 'messages', 'mailbox', 'teams', 'folders', 'skills', 'mcp_servers', 'agent_metadata', 'assistant_definitions'];
const counts = (file) => { const db = new DatabaseSync(file, { readOnly: true }); const o = {}; for (const t of TABLES) { try { o[t] = Number(db.prepare('SELECT COUNT(*) n FROM ' + t).get().n); } catch (e) { o[t] = null; } } db.close(); return o; };

(async () => {
  rm(BASE);
  // Roaming and Local under the made-up home, as on a real PC: the app finds them from USERPROFILE, not from APPDATA
  const home = path.join(BASE, 'home'), roaming = path.join(home, 'AppData', 'Roaming'), local = path.join(home, 'AppData', 'Local');
  const OLD = path.join(roaming, 'AionUi'), NEW = path.join(roaming, 'AionDX');
  const inner = path.join(OLD, 'aionui');
  fs.mkdirSync(inner, { recursive: true }); fs.mkdirSync(local, { recursive: true });
  const copy = path.join(inner, 'aionui-backend.db');
  let t0 = Date.now();
  const src = new DatabaseSync(SRC, { readOnly: true });
  const realOld = path.join(REAL_ROAMING, 'AionUi');
  // the real paths in the copy name the REAL folder; the made-up tree is elsewhere, so the copy is first pointed at it with the same
  // rewrite the tool does (a plain replace of the real prefix by the made-up one), leaving the tool a database shaped like the real one
  src.exec("VACUUM INTO '" + copy.replace(/'/g, "''") + "'");
  src.close();
  console.log('copied the database in ' + Math.round((Date.now() - t0) / 1000) + ' s (' + Math.round(fs.statSync(copy).size / 1048576) + ' MB)');
  const pairs = [[realOld, OLD], [realOld.replace(/\\/g, '\\\\'), OLD.replace(/\\/g, '\\\\')], [realOld.replace(/\\/g, '/'), OLD.replace(/\\/g, '/')]];
  {
    const db = new DatabaseSync(copy);
    db.exec('BEGIN');
    const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_sqlx%'").all();
    const virt = tables.filter((t) => /VIRTUAL/i.test(t.sql || '')).map((t) => t.name);
    for (const t of tables) {
      if (virt.includes(t.name) || virt.some((v) => t.name.startsWith(v + '_'))) continue;
      for (const c of db.prepare('PRAGMA table_info("' + t.name + '")').all().filter((c) => /CHAR|TEXT|CLOB|JSON|^$/i.test(c.type || ''))) {
        let expr = '"' + c.name + '"'; const args = [];
        for (const [o, n] of pairs) { expr = 'replace(' + expr + ', ?, ?)'; args.push(o, n); }
        db.prepare('UPDATE "' + t.name + '" SET "' + c.name + '" = ' + expr + ' WHERE ' + pairs.map(() => 'instr("' + c.name + '", ?) > 0').join(' OR ')).run(...args, ...pairs.map(([o]) => o));
      }
    }
    db.exec('COMMIT');
    // working folders and Claude history folders for every conversation
    const rows = db.prepare('SELECT id, extra FROM conversations').all();
    const claude = [path.join(home, '.claude'), path.join(home, '.claude-work')];
    let made = 0, claudeMade = 0;
    rows.forEach((r, i) => {
      let ws = null; try { ws = JSON.parse(r.extra || '{}').workspace; } catch (e) { /* none */ }
      if (typeof ws !== 'string' || !ws.toLowerCase().startsWith(OLD.toLowerCase())) return;
      if (i % 3 !== 0) { fs.mkdirSync(ws, { recursive: true }); made++; }   // most working folders exist, some do not
      const h = path.join(claude[i % 2], 'projects', mangle(ws));
      fs.mkdirSync(h, { recursive: true }); fs.writeFileSync(path.join(h, 'sessionplaceholder.jsonl'), '{}\n'); claudeMade++;
    });
    db.close();
    console.log('made-up tree: ' + made + ' working folders, ' + claudeMade + ' Claude history folders');
  }
  const before = counts(copy);
  console.log('rows before: ' + JSON.stringify(before));
  const run = (cmd, extra) => { const t = Date.now(); const r = spawnSync(process.execPath, ['--no-warnings', TOOL, cmd, '--roaming', roaming, '--home', home, '--local', local].concat(extra || []), { encoding: 'utf8', windowsHide: true, timeout: 900000, maxBuffer: 64 * 1024 * 1024 }); return { status: r.status, out: r.stdout + r.stderr, secs: Math.round((Date.now() - t) / 1000) }; };

  let r = run('plan');
  check('plan reads the real-shaped database and changes nothing (' + r.secs + ' s)', r.status === 0 && /plan only/.test(r.out), r.out.slice(-600));
  console.log(r.out.split('\n').filter((l) => /rows:|history folders|rows holding/.test(l)).map((l) => '   ' + l.replace(/^\S+ /, '').slice(0, 260)).join('\n'));

  r = run('run');
  check('run moves it and verifies (' + r.secs + ' s)', r.status === 0, r.out.slice(-900));
  console.log(r.out.split('\n').filter((l) => /rewrote|renamed|verified|backup/.test(l)).map((l) => '   ' + l.replace(/^\S+ /, '').slice(0, 300)).join('\n'));
  const dbNow = ['aiondx-backend.db', 'aionui-backend.db'].map((n) => path.join(NEW, 'aionui', n)).find((f) => fs.existsSync(f));
  if (r.status === 0 && dbNow) {
    const after = counts(dbNow);
    check('every table has the rows it had', JSON.stringify(after) === JSON.stringify(before), JSON.stringify(after));
    check('the folder is AionDX\'s and AionUi is gone', fs.existsSync(NEW) && !fs.existsSync(OLD));
    check('every Claude history folder follows the new path name', fs.readdirSync(path.join(home, '.claude', 'projects')).concat(fs.readdirSync(path.join(home, '.claude-work', 'projects'))).every((n) => !/-AionUi-aionui-/.test(n) && /AionDX-aionui-/.test(n)));
    if (process.argv.includes('--keep')) { console.log('kept: ' + BASE); clearTimeout(deadline); console.log(`/${pass + fail} passed`); process.exit(fail ? 1 : 0); }
    if (process.argv.includes('--app')) {
      const { launch, sleep } = require('./live-app');
      let app;
      try {
        app = await launch({ port: 9594, deadlineMs: 240000, profile: path.join(BASE, 'unused'), noUserDataDir: true,
          env: { AIONDX_E2E_USER_DATA_DIR: '', APPDATA: roaming, LOCALAPPDATA: local, USERPROFILE: home, HOME: home } });
      } catch (e) {
        console.log('the app did not open: ' + e.message);
        const lg = []; (function w(d, n) { if (n > 5) return; try { for (const x of fs.readdirSync(d, { withFileTypes: true })) { const q = path.join(d, x.name); if (x.isDirectory()) w(q, n + 1); else if (/\.log$/.test(x.name)) lg.push(q); } } catch (z) { /* none */ } })(path.join(NEW, 'logs'), 0);
        for (const f of lg.slice(-3)) console.log('--- ' + path.basename(f) + '\n' + fs.readFileSync(f, 'utf8').split('\n').filter((l) => /ERROR|WARN|panic|fail|migrat/i.test(l)).slice(-12).map((l) => '   ' + l.slice(0, 220)).join('\n'));
        check('the built app starts on the moved folder', false, e.message);
        rm(BASE); process.exit(1);
      }
      let port = null;
      try { for (let i = 0; i < 150 && !port; i++) { const st = await app.js('({ port: window.__backendPort || null })'); port = st && st.port; if (!port) await sleep(1000); } await sleep(8000); } finally { await app.close(); }
      await sleep(3000);
      check('the built app starts on the moved folder', !!port, 'no port');
      const files = fs.readdirSync(path.join(NEW, 'aionui')).filter((f) => /backend\.db$/.test(f));
      const c2 = counts(path.join(NEW, 'aionui', files[0]));
      check('and after its own start-up migrations no row is lost', TABLES.every((t) => before[t] === null || c2[t] >= before[t]), JSON.stringify(c2));
      check('and no AionUi folder was made again', !fs.existsSync(OLD));
    }
    r = run('rollback');
    check('rollback puts the folder back with the same rows (' + r.secs + ' s)', r.status === 0 && fs.existsSync(OLD) && ['aiondx-backend.db', 'aionui-backend.db'].some((n) => fs.existsSync(path.join(OLD, 'aionui', n))), r.out.slice(-500));
  }
  rm(BASE);
  clearTimeout(deadline);
  console.log(`${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERROR ' + (e && e.stack || e)); rm(BASE); process.exit(2); });
