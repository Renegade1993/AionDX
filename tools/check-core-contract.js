#!/usr/bin/env node
/**
 * check-core-contract.js - the built app's main process and the AionCore it ships with agree on the names between them.
 *
 *   node tools/check-core-contract.js <extracted-asar-root> <aioncore.exe>
 *
 * Two kinds of name, each a silent failure when the two sides differ (0.26.0's rename pass renamed both in the app only):
 *   - the session and CSRF cookie names: the main process reads AionCore's session cookie out of its Set-Cookie answer by
 *     name, and hands the page a CSRF cookie by name that AionCore checks. Differ, and no session is ever made: every read
 *     answers 401 and every write 403, with no error at start-up.
 *   - the environment variables buildSpawnEnv() starts AionCore with (its cache, work and log folders). Differ, and AionCore
 *     never sees them: /api/system/info reported an empty cache_dir and log_dir.
 * Either way the build stops here.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const CONSTANTS = ['CORE_SESSION_COOKIE', 'CORE_CSRF_COOKIE'];

/** The variable names buildSpawnEnv() sets on AionCore's environment (object keys on their own line, not the destructured ones it removes). */
function spawnEnvNames(mainJs) {
  const start = mainJs.indexOf('function buildSpawnEnv(');
  if (start === -1) return null;
  const end = mainJs.indexOf('\n}\n', start);
  const body = mainJs.slice(start, end === -1 ? undefined : end);
  return [...body.matchAll(/^\s*([A-Z][A-Z0-9_]*): /gm)].map((m) => m[1]);
}

function check(mainJs, coreBuf) {
  const problems = [];
  const found = {};
  for (const name of CONSTANTS) {
    const all = [...mainJs.matchAll(new RegExp(`\\bconst ${name} = "([^"]+)"`, 'g'))];
    if (all.length !== 1) { problems.push(`${name}: expected one definition in out/main/index.js, found ${all.length}`); continue; }
    const value = all[0][1];
    found[name] = value;
    if (!coreBuf.includes(Buffer.from(value, 'utf8'))) problems.push(`${name} is "${value}", which AionCore does not contain`);
  }
  const env = spawnEnvNames(mainJs);
  if (!env) problems.push('buildSpawnEnv: not found in out/main/index.js');
  else if (!env.length) problems.push('buildSpawnEnv: sets no variables any more (has its shape changed?)');
  else {
    found.env = env;
    for (const name of env) if (!coreBuf.includes(Buffer.from(name, 'utf8'))) problems.push(`AionCore is started with ${name}, which it does not read`);
  }
  return { problems, found };
}

function main(argv) {
  const [root, core] = argv;
  if (!root || !core) { console.error('usage: node check-core-contract.js <extracted-asar-root> <aioncore.exe>'); return 2; }
  const r = check(fs.readFileSync(path.join(root, 'out', 'main', 'index.js'), 'utf8'), fs.readFileSync(core));
  if (r.problems.length) { for (const p of r.problems) console.error('core contract: ' + p); return 1; }
  console.log('core contract: ' + CONSTANTS.map((n) => `${n} "${r.found[n]}"`).join(', ') + ', start-up variables ' + r.found.env.join(', ') + ' match AionCore');
  return 0;
}

module.exports = { check, spawnEnvNames, CONSTANTS };
if (require.main === module) process.exit(main(process.argv.slice(2)));
