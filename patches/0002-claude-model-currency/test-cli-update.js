'use strict';
// test-cli-update.js - the npm Claude Code update in aiondx-model-refresh.js, with a stand-in for npm and a throwaway prefix. No network.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 500) + ']')); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-cliupd-test-'));
const prefix = path.join(root, 'nodejs');
const pkgDir = path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code');
const putPkg = (dir, version) => {
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version }));
  fs.copyFileSync(process.execPath, path.join(dir, 'bin', 'claude.exe'));   // answers --version with a version
};
// A hand-made launcher in the prefix that npm must never touch.
const shimText = '@ECHO off\r\nREM the account router shim\r\n';
const reset = (version) => { fs.rmSync(prefix, { recursive: true, force: true }); putPkg(pkgDir, version); fs.writeFileSync(path.join(prefix, 'claude.cmd'), shimText); };
// The stand-in npm: `view` prints dist-tags; `install -g --prefix DIR pkg@ver` builds the package there (FAKE_NPM_FAIL makes it fail).
const fakeNpm = path.join(root, 'fake-npm.js');
fs.writeFileSync(fakeNpm, `
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_NPM_LOG, a.join(' ') + '\\n');
if (a[0] === 'view') { process.stdout.write(process.env.FAKE_TAGS || '{}'); process.exit(0); }
if (a[0] === 'install') {
  if (process.env.FAKE_NPM_FAIL) { process.stderr.write('npm ERR! network'); process.exit(1); }
  const dir = a[a.indexOf('--prefix') + 1], ver = a.find((x) => x.startsWith('@anthropic-ai/claude-code@')).split('@').pop();
  const pkg = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code');
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version: ver }));
  fs.copyFileSync(process.execPath, path.join(pkg, 'bin', 'claude.exe'));
  fs.writeFileSync(path.join(dir, 'claude.cmd'), 'stock npm shim');   // what npm would do to the real prefix
  process.exit(0);
}
process.exit(2);
`);
const npmLog = path.join(root, 'npm.log');
const cfgFile = path.join(root, 'router.json');
const runner = path.join(root, 'run.js');
fs.writeFileSync(runner, `const m = require(${JSON.stringify(path.join(__dirname, 'aiondx-model-refresh.js'))}); console.log(JSON.stringify(m.updateNpmClaude(JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8')))));`);
const run = (cfg, env, extra) => {
  fs.writeFileSync(cfgFile, JSON.stringify(cfg || {}));
  const r = spawnSync(process.execPath, [runner, cfgFile].concat(extra || []), { encoding: 'utf8', windowsHide: true, timeout: 120000,
    env: Object.assign({}, process.env, { AIONDX_NPM: '"' + process.execPath + '" "' + fakeNpm + '"', AIONDX_NPM_PREFIXES: prefix, AIONDX_RUNNING_PATHS: '', FAKE_NPM_LOG: npmLog,
      FAKE_TAGS: JSON.stringify({ latest: '2.1.296', stable: '2.1.287' }), AIONDX_REFRESH_LOG_DIR: path.join(root, 'logs') }, env || {}) });
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch (e) { return { error: r.stdout + r.stderr }; }
};
const ver = () => JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;

try {
  reset('2.1.289');
  let r = run({});
  check('an older npm install is updated to the "latest" version', r[0] && r[0].state === 'updated' && ver() === '2.1.296', JSON.stringify(r));
  check("the prefix's own claude.cmd (an account router) is untouched", fs.readFileSync(path.join(prefix, 'claude.cmd'), 'utf8') === shimText);
  check('no staging or old folder is left behind', !fs.existsSync(path.join(prefix, '.aiondx-staging')) && !fs.readdirSync(path.dirname(pkgDir)).some((n) => /\.old-/.test(n)), fs.readdirSync(path.dirname(pkgDir)).join(','));
  check('npm installed into the staging folder, never the prefix itself', /install -g --prefix .*\.aiondx-staging @anthropic-ai\/claude-code@2\.1\.296/.test(fs.readFileSync(npmLog, 'utf8')), fs.readFileSync(npmLog, 'utf8'));
  r = run({});
  check('a current install is left alone', r[0] && r[0].state === 'current', JSON.stringify(r));
  reset('2.1.280');
  r = run({ cliChannel: 'stable' });
  check('the channel in the config is followed ("stable")', r[0] && r[0].state === 'updated' && ver() === '2.1.287', JSON.stringify(r));
  reset('2.1.289');
  r = run({}, { AIONDX_RUNNING_PATHS: path.join(pkgDir, 'bin', 'claude.exe') });
  check('while a Claude Code from the prefix runs, the update waits', r[0] && r[0].state === 'pending' && ver() === '2.1.289', JSON.stringify(r));
  r = run({}, { FAKE_NPM_FAIL: '1' });
  check('a failed npm install leaves the installed copy as it was', r[0] && r[0].state === 'failed' && ver() === '2.1.289' && fs.existsSync(path.join(pkgDir, 'bin', 'claude.exe')), JSON.stringify(r));
  r = run({}, { FAKE_TAGS: 'not json' });
  check('when npm cannot say the version (offline), nothing happens', Array.isArray(r) && r.length === 0 && ver() === '2.1.289', JSON.stringify(r));
  r = run({ cliUpdate: false });
  check('"cliUpdate": false switches it off', Array.isArray(r) && r.length === 0 && ver() === '2.1.289', JSON.stringify(r));
  r = run({}, { AIONDX_NPM_PREFIXES: path.join(root, 'empty') });
  check('no npm install of Claude Code: nothing to do, npm not even asked', Array.isArray(r) && r.length === 0);
} catch (e) {
  check('no exception', false, e.stack);
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* in use */ }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
