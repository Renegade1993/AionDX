#!/usr/bin/env node
/**
 * Tests for the router's usageFor() (AionDX, 2026-09-26, reworked 2026-10-01): the store key the usage meter is
 * filed under, the label it shows, and when a token goes along (only for the old direct probe). Run: node patches\0002-claude-model-currency\test-usage-for.js
 *
 * The router runs as a script, so the function is lifted out of its source and run with the router's own
 * fs, path and a stand-in realProfileDir(). No Claude is started and no real credentials are read.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const src = fs.readFileSync(path.join(__dirname, 'claude-account-router.js'), 'utf8');
const m = src.match(/function usageFor\(env, cfg, label\) \{[\s\S]*?\n\}\n/);
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 300) + ']'}`); };
check('usageFor is found in the router', !!m);
if (!m) { console.log(`\n${pass}/${pass + fail} passed`); process.exit(1); }

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-usagefor-'));
const profile = path.join(scratch, 'profile');
// eslint-disable-next-line no-new-func
const usageFor = new Function('fs', 'path', 'require', 'process', 'realProfileDir', m[0] + '\nreturn usageFor;')(
  fs, path, require, { env: {} }, () => profile);
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
const writeCred = (dir, o) => { fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, '.credentials.json'); fs.writeFileSync(f, JSON.stringify(o)); return f; };

const ON = {};                          // the default: the meter reads Claude's own traffic, no token goes along
const PROBE = { usageProbe: true };     // the old direct probe, off unless the config asks for it
try {
  let u = usageFor({ CLAUDE_CODE_OAUTH_TOKEN: ' tok-a \n' }, ON, 'main (Plan A)');
  check('a token in the environment keys the meter by its hash, with the account name, and does not go along', u && u.key === hash('tok-a') &&
    u.label === 'main (Plan A)' && !u.token && !u.tokenFile && u.probe === false, JSON.stringify(u));
  u = usageFor({ CLAUDE_CODE_OAUTH_TOKEN: ' tok-a \n' }, PROBE, 'main (Plan A)');
  check('only "usageProbe": true sends the token on, for the old direct probe', u && u.token === 'tok-a' && u.key === hash('tok-a') && u.probe === true, JSON.stringify(u));

  u = usageFor({ ANTHROPIC_AUTH_TOKEN: 'tok-b' }, ON, 'agent 1234abcd');
  check('an agent id is no label', u && u.key === hash('tok-b') && u.label === '', JSON.stringify(u));

  const cfgDir = path.join(scratch, 'cfg');
  const f1 = writeCred(cfgDir, { claudeAiOauth: { accessToken: 'x', refreshToken: 'y', subscriptionType: 'max' } });
  u = usageFor({ CLAUDE_CONFIG_DIR: cfgDir }, ON, 'its own agent');
  check("with no token in the environment, the config folder's .credentials.json keys the meter and names the plan", u && !u.tokenFile && !u.token &&
    u.key === hash('file:' + path.resolve(f1).toLowerCase()) && u.label === 'Max', JSON.stringify(u));
  u = usageFor({ CLAUDE_CONFIG_DIR: cfgDir }, PROBE, 'its own agent');
  check('the credentials file goes along only for the probe', u && u.tokenFile === f1 && u.probe === true, JSON.stringify(u));

  const home = path.join(scratch, 'home');
  const f2 = writeCred(path.join(home, '.claude'), { claudeAiOauth: { accessToken: 'x' } });
  u = usageFor({ USERPROFILE: home }, ON, 'its own agent');
  check("without CLAUDE_CONFIG_DIR, the profile's .claude folder", u && u.key === hash('file:' + path.resolve(f2).toLowerCase()) && u.label === '', JSON.stringify(u));

  // A login kept in the system's secure store has no credentials file: the tap needs none, so it still gets a meter.
  u = usageFor({}, ON, 'its own agent');
  check('nothing on disk to read: the meter is keyed by the config folder', u && u.key === hash('dir:' + path.resolve(path.join(profile, '.claude')).toLowerCase()) && u.label === '' && u.probe === false, JSON.stringify(u));

  writeCred(path.join(scratch, 'empty'), { somethingElse: {} });
  u = usageFor({ CLAUDE_CONFIG_DIR: path.join(scratch, 'empty') }, ON, '');
  check('a credentials file without an access token is keyed by its folder', u && u.key === hash('dir:' + path.resolve(path.join(scratch, 'empty')).toLowerCase()), JSON.stringify(u));

  u = usageFor({ CLAUDE_CODE_OAUTH_TOKEN: 'tok-c' }, { usageMeter: false }, 'x');
  check('"usageMeter": false switches it off', u === null, JSON.stringify(u));
  u = usageFor({ CLAUDE_CODE_OAUTH_TOKEN: 'tok-d' }, null, 'x');
  check('no config at all: on (the default)', u && u.key === hash('tok-d'), JSON.stringify(u));
  u = usageFor({ CLAUDE_CODE_OAUTH_TOKEN: 'tok-d' }, { usageMeter: 'false' }, 'x');
  check('only the value false switches it off, not the string', u !== null, JSON.stringify(u));
} catch (e) {
  check('no exception', false, e.stack);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
