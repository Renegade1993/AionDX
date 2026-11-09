#!/usr/bin/env node
/**
 * test-firewall.js - patch 0018's main-process firewall path, with nothing real run: the plan builder against firewall.rs's
 * injection cases, the show-rule parser, apply.js on a made-up extracted tree, and the inserted main-process block itself run
 * in a sandbox whose child_process.spawn is a fake that only records (no netsh, no elevate.exe, no UAC prompt).
 *
 *   node patches\0018-mobile-settings\test-firewall.js
 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm'), { EventEmitter } = require('events');
const P = require('./firewall-plan.js');
const A = require('./apply.js');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'ok    ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 300) + ']')); };

const EXE = 'C:\\Program Files\\AionDX\\resources\\bundled-aioncore\\win32-x64\\aioncore.exe';
const NETSH = 'C:\\Windows\\System32\\netsh.exe';
const ALLOW_ARGS = (port, exe) => ['advfirewall', 'firewall', 'add', 'rule', 'name=AionDX mobile bridge', 'dir=in', 'action=allow', 'protocol=TCP',
  'localport=' + port, 'profile=private', 'program=' + exe, 'enable=yes'];

// ---- the plan builder ----
let p = P.buildPlan('allow', { port: 47734, program: EXE, systemRoot: 'C:\\Windows' });
check('allow: the exact plan, a path with spaces as one argument', p.ok && p.program === NETSH && JSON.stringify(p.args) === JSON.stringify(ALLOW_ARGS(47734, EXE)), JSON.stringify(p));
check('allow: Private profile only, never "any"', p.args.includes('profile=private') && !/=any\b/i.test(p.args.join(' ')) && !/profile=(public|domain)/i.test(p.args.join(' ')));
p = P.buildPlan('remove', { systemRoot: 'C:\\Windows' });
check('remove: the exact plan', p.ok && p.program === NETSH && JSON.stringify(p.args) === JSON.stringify(['advfirewall', 'firewall', 'delete', 'rule', 'name=AionDX mobile bridge']));
for (const [why, exe] of [
  ['a quote that would close netsh\'s quoting', 'C:\\Program Files\\x" profile=any dir=out "\\aioncore.exe'],
  ['a quoted folder', 'C:\\Program Files\\"Aion DX"\\aioncore.exe'],
  ['an =', 'C:\\Program Files\\x=y\\aioncore.exe'],
  ['a newline', 'C:\\Program Files\\AionDX\\a\r\nb.exe'],
  ['a NUL', 'C:\\Program Files\\AionDX\\a\u0000b.exe'],
  ['a relative path', 'aioncore.exe'],
  ['a folder', 'C:\\Program Files\\AionDX\\'],
  ['nothing', ''],
]) check('allow refuses a program path with ' + why, P.buildPlan('allow', { port: 47734, program: exe }).ok === false);
for (const port of [0, 80, 1023, 65536, 47734.5, '47734', NaN, null, undefined, -1]) {
  check('allow refuses port ' + JSON.stringify(port), P.buildPlan('allow', { port, program: EXE }).ok === false);
}
check('the port range ends are allowed (1024, 65535)', P.buildPlan('allow', { port: 1024, program: EXE }).ok && P.buildPlan('allow', { port: 65535, program: EXE }).ok);
check('an unknown action is refused', P.buildPlan('add rule name=x', { port: 47734, program: EXE }).ok === false && P.buildPlan(undefined, {}).ok === false);
check('a SystemRoot that is not a clean absolute path falls back to C:\\Windows', P.netshPath('relative') === NETSH && P.netshPath('C:\\x" y') === NETSH && P.netshPath(undefined) === NETSH && P.netshPath('D:\\Win\\') === 'D:\\Win\\System32\\netsh.exe');
check('shell characters stay inside the one program= argument', (() => { const q = P.buildPlan('allow', { port: 47734, program: 'C:\\A&B (x) ^ % !\\aioncore.exe' }); return q.ok && q.args.length === 12 && q.args[10] === 'program=C:\\A&B (x) ^ % !\\aioncore.exe'; })());

// ---- the show-rule parser (the real "no rule" output captured on this PC; the present one from the documented format) ----
const NO_RULE = '\r\nNo rules match the specified criteria.\r\n\r\n';
const PRESENT = (port, profiles, enabled) => '\r\nRule Name:                            AionDX mobile bridge\r\n' + '-'.repeat(70) + '\r\n' +
  'Enabled:                              ' + (enabled === false ? 'No' : 'Yes') + '\r\nDirection:                            In\r\nProfiles:                             ' + (profiles || 'Private') +
  '\r\nLocalPort:                            ' + port + '\r\nProgram:                              ' + EXE + '\r\nAction:                               Allow\r\nOk.\r\n';
check('parse: no rule', JSON.stringify(P.parseShowRule(NO_RULE)) === JSON.stringify({ present: false, enabled: false, privateOnly: false, port: null }));
check('parse: the rule', JSON.stringify(P.parseShowRule(PRESENT(47734))) === JSON.stringify({ present: true, enabled: true, privateOnly: true, port: 47734 }));
check('parse: a rule on more than Private is not private-only', P.parseShowRule(PRESENT(47734, 'Domain,Private,Public')).privateOnly === false);
check('parse: disabled; Any port; localized output', P.parseShowRule(PRESENT(47734, 'Private', false)).enabled === false && P.parseShowRule(PRESENT('Any')).port === null &&
  P.parseShowRule('Regelname: AionDX mobile bridge\r\nAktiviert: Ja').present === false);

// ---- apply.js on a made-up extracted tree ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-0018-'));
try {
  fs.mkdirSync(path.join(tmp, 'out', 'main'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'out', 'preload'), { recursive: true });
  const MAIN0 = '"use strict";\nconst electron = require("electron");\nelectron.ipcMain.handle("x", () => 1);\n';
  const PRE0 = 'const electron = require("electron");\n' + A.PRELOAD_ANCHOR + '\nelectron.contextBridge.exposeInMainWorld("electronAPI", {});\n';
  fs.writeFileSync(path.join(tmp, 'out', 'main', 'index.js'), MAIN0);
  fs.writeFileSync(path.join(tmp, 'out', 'preload', 'index.js'), PRE0);
  const cp = require('child_process');
  const runApply = () => cp.spawnSync(process.execPath, [path.join(__dirname, 'apply.js'), tmp], { encoding: 'utf8' });
  let r = runApply();
  const main1 = fs.readFileSync(path.join(tmp, 'out', 'main', 'index.js'), 'utf8');
  const pre1 = fs.readFileSync(path.join(tmp, 'out', 'preload', 'index.js'), 'utf8');
  check('apply: adds the main block and the preload bridge', r.status === 0 && main1.startsWith(MAIN0) && main1.includes(A.MARK_BEGIN) && pre1.includes('exposeInMainWorld("aiondxMobile"'), r.stderr || r.stdout);
  r = runApply();
  const main2 = fs.readFileSync(path.join(tmp, 'out', 'main', 'index.js'), 'utf8');
  check('apply: running it again changes nothing', r.status === 0 && main2 === main1 && fs.readFileSync(path.join(tmp, 'out', 'preload', 'index.js'), 'utf8') === pre1);
  check('apply: the preload exposes only allowFirewall(port) and removeFirewall(), on the one channel',
    /allowFirewall: \(port\) => electron\.ipcRenderer\.invoke\("aiondx:mobile-firewall", "allow", port\)/.test(pre1) && /removeFirewall: \(\) => electron\.ipcRenderer\.invoke\("aiondx:mobile-firewall", "remove"\)/.test(pre1) &&
    (pre1.match(/ipcRenderer\.invoke/g) || []).length === 2);
  fs.writeFileSync(path.join(tmp, 'out', 'preload', 'index.js'), 'no anchor here');
  fs.writeFileSync(path.join(tmp, 'out', 'main', 'index.js'), MAIN0);
  r = runApply();
  check('apply: a missing preload anchor writes nothing', r.status === 1 && fs.readFileSync(path.join(tmp, 'out', 'main', 'index.js'), 'utf8') === MAIN0, r.stderr);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }

// ---- the inserted main block, in a sandbox: fake electron, fake fs, a spawn that only records ----
function sandbox(opts) {
  opts = opts || {};
  const handlers = {}, spawned = [];
  const fakeChild = (out) => {
    const c = new EventEmitter(); c.stdout = new EventEmitter();
    setImmediate(() => { if (out) c.stdout.emit('data', Buffer.from(out)); c.emit('close', 0); });
    return c;
  };
  const fakeRequire = (name) => {
    if (name === 'electron') return { ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } } };
    if (name === 'node:path') return path.win32;
    if (name === 'node:fs') return { existsSync: (p) => (opts.missing || []).every((m) => !p.endsWith(m)) };
    if (name === 'node:child_process') return { spawn: (file, args) => {
      spawned.push({ file, args });
      if (/netsh\.exe$/i.test(file) && args[2] === 'show') return fakeChild(opts.showOut ? opts.showOut(spawned) : NO_RULE);
      return fakeChild('');
    } };
    throw new Error('unexpected require ' + name);
  };
  const proc = { platform: opts.platform || 'win32', resourcesPath: opts.resourcesPath || 'C:\\Program Files\\AionDX\\resources', env: { SystemRoot: 'C:\\Windows' } };
  vm.runInNewContext(A.mainBlock(), { require: fakeRequire, process: proc, console, setImmediate });
  return { handler: handlers['aiondx:mobile-firewall'], spawned };
}

(async () => {
  let s = sandbox({ showOut: () => PRESENT(47734) });
  check('main: registers the one handler', typeof s.handler === 'function');
  let res = await s.handler({}, 'allow', 47734);
  check('main: allow runs elevate.exe -wait with the exact netsh plan, then the read-only show rule, and answers ok', res.ok === true && s.spawned.length === 2 &&
    s.spawned[0].file === 'C:\\Program Files\\AionDX\\resources\\elevate.exe' &&
    JSON.stringify(s.spawned[0].args) === JSON.stringify(['-wait', NETSH].concat(ALLOW_ARGS(47734, EXE))) &&
    s.spawned[1].file === NETSH && s.spawned[1].args[2] === 'show', JSON.stringify(s.spawned));
  check('main: the renderer gets only { ok } back', JSON.stringify(res) === '{"ok":true}');
  for (const bad of [['allow', '47734'], ['allow', 1023], ['allow', 70000], ['allow', 47734.5], ['allow', { toString: () => '47734' }], ['delete rule name=x', 47734], ['allow']]) {
    s = sandbox({ showOut: () => PRESENT(47734) });
    res = await s.handler({}, ...bad);
    check('main: ' + JSON.stringify(bad[0]) + ' with port ' + JSON.stringify(bad[1]) + ' is refused before anything runs', res.ok === false && typeof res.error === 'string' && s.spawned.length === 0, JSON.stringify(res));
  }
  s = sandbox({ showOut: () => PRESENT(47734) });
  res = await s.handler({}, 'allow', 47734, 'C:\\evil.exe', ['/c', 'calc']);
  check('main: extra arguments from the page are ignored (the program is always the bundled aioncore.exe)', res.ok && !JSON.stringify(s.spawned).includes('evil') && s.spawned[0].args.includes('program=' + EXE));
  s = sandbox({ resourcesPath: 'C:\\Program Files\\x" profile=any "\\resources' });
  res = await s.handler({}, 'allow', 47734);
  check('main: an install path netsh could misread is refused, nothing runs', res.ok === false && s.spawned.length === 0, JSON.stringify(res));
  s = sandbox({ showOut: () => NO_RULE });
  res = await s.handler({}, 'allow', 47734);
  check('main: a cancelled UAC prompt (no rule afterwards) answers not ok, in plain words', res.ok === false && /cancelled/.test(res.error) && s.spawned.length === 2);
  s = sandbox({ showOut: () => PRESENT(47734, 'Domain,Private,Public') });
  check('main: a rule that is there but not Private-only does not count as done', (await s.handler({}, 'allow', 47734)).ok === false);
  s = sandbox({ showOut: () => NO_RULE });
  res = await s.handler({}, 'remove');
  check('main: remove runs the delete plan elevated and answers ok when the rule is gone', res.ok === true && JSON.stringify(s.spawned[0].args) === JSON.stringify(['-wait', NETSH, 'advfirewall', 'firewall', 'delete', 'rule', 'name=AionDX mobile bridge']));
  s = sandbox({ missing: ['elevate.exe'] });
  res = await s.handler({}, 'allow', 47734);
  check('main: no elevate.exe means a clear answer and nothing run', res.ok === false && /elevate\.exe/.test(res.error) && s.spawned.length === 0);
  s = sandbox({ showOut: () => PRESENT(47734) });
  const both = await Promise.all([s.handler({}, 'allow', 47734), s.handler({}, 'allow', 47734)]);
  check('main: one request at a time (a second is turned away, not run twice)', both.filter((x) => x.ok).length === 1 && /already/.test(both.find((x) => !x.ok).error) && s.spawned.filter((c) => /elevate/.test(c.file)).length === 1);
  s = sandbox({ platform: 'linux' });
  check('main: off Windows the handler is not registered', s.handler === undefined);

  console.log(`${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
