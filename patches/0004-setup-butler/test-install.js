#!/usr/bin/env node
/**
 * Tests for install.js, against a throwaway AionUi data folder (AIONDX_AIONUI_DATA), never the
 * real one. Run: node patches\0004-setup-butler\test-install.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const INSTALL = path.join(__dirname, 'install.js');
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) { pass++; console.log('PASS  ' + name); } else { fail++; console.log('FAIL  ' + name + (detail ? '   ' + String(detail).slice(0, 300) : '')); } };

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-install-'));
const run = (...args) => spawnSync(process.execPath, [INSTALL, ...args], { encoding: 'utf8', windowsHide: true, env: Object.assign({}, process.env, { AIONDX_AIONUI_DATA: data }) });
const dst = path.join(data, 'builtin-skills', 'auto-inject', 'aiondx-setup');

let r = run('--check');
check('no builtin-skills folder: refuses, exit 2', r.status === 2, r.stderr);
fs.mkdirSync(path.join(data, 'builtin-skills', 'auto-inject', 'cron'), { recursive: true });
fs.writeFileSync(path.join(data, 'builtin-skills', 'auto-inject', 'cron', 'SKILL.md'), 'other skill');
fs.writeFileSync(path.join(data, 'builtin-skills', '.version'), '0.2.2+builtin-skills.test');

r = run('--check');
check('missing: --check exits 1 and says so', r.status === 1 && /missing/.test(r.stdout), r.stdout);
r = run();
check('install copies the skill', r.status === 0 && fs.existsSync(path.join(dst, 'SKILL.md')) && fs.existsSync(path.join(dst, 'scripts', 'survey.js')) && fs.existsSync(path.join(dst, 'references', 'catalog.json')), r.stdout + r.stderr);
check('it writes its stamp', fs.existsSync(path.join(dst, '.aiondx')));
r = run('--check');
check('current: --check exits 0', r.status === 0 && /current/.test(r.stdout), r.stdout);
r = run();
check('a second install changes nothing', r.status === 0 && /already current/.test(r.stdout), r.stdout);

fs.appendFileSync(path.join(dst, 'SKILL.md'), '\nlocal edit');
r = run('--check');
check('an edited copy reads as stale', r.status === 1 && /stale/.test(r.stdout), r.stdout);
r = run();
check('install refreshes a stale copy', r.status === 0 && /refreshed/.test(r.stdout) && !fs.readFileSync(path.join(dst, 'SKILL.md'), 'utf8').includes('local edit'), r.stdout);

check('other skills, the .version file and no staging leftovers are untouched',
  fs.readFileSync(path.join(data, 'builtin-skills', 'auto-inject', 'cron', 'SKILL.md'), 'utf8') === 'other skill'
  && fs.readFileSync(path.join(data, 'builtin-skills', '.version'), 'utf8') === '0.2.2+builtin-skills.test'
  && fs.readdirSync(path.join(data, 'builtin-skills', 'auto-inject')).every((n) => !n.includes('.staging-')));

r = run('--remove');
check('--remove takes out only the skill', r.status === 0 && !fs.existsSync(dst) && fs.existsSync(path.join(data, 'builtin-skills', 'auto-inject', 'cron')), r.stdout);

fs.rmSync(data, { recursive: true, force: true });
console.log('\n' + pass + '/' + (pass + fail) + ' passed');
process.exit(fail ? 1 : 0);
