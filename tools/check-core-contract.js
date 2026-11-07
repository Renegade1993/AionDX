#!/usr/bin/env node
/**
 * check-core-contract.js - the built app's main process and the AionCore it ships with agree on the cookie names.
 *
 *   node tools/check-core-contract.js <extracted-asar-root> <aioncore.exe>
 *
 * The main process reads AionCore's session cookie out of its Set-Cookie answer by name, and hands the page a CSRF cookie
 * by name that AionCore checks. If the two names differ from AionCore's own, nothing fails at start-up: the session is
 * never made, every read answers 401 and every write 403. That shipped once (0.26.0's rename pass renamed them in the app
 * only), so the build stops here instead.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const CONSTANTS = ['CORE_SESSION_COOKIE', 'CORE_CSRF_COOKIE'];

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
  return { problems, found };
}

function main(argv) {
  const [root, core] = argv;
  if (!root || !core) { console.error('usage: node check-core-contract.js <extracted-asar-root> <aioncore.exe>'); return 2; }
  const r = check(fs.readFileSync(path.join(root, 'out', 'main', 'index.js'), 'utf8'), fs.readFileSync(core));
  if (r.problems.length) { for (const p of r.problems) console.error('core contract: ' + p); return 1; }
  console.log('core contract: ' + CONSTANTS.map((n) => `${n} "${r.found[n]}"`).join(', ') + ' match AionCore');
  return 0;
}

module.exports = { check, CONSTANTS };
if (require.main === module) process.exit(main(process.argv.slice(2)));
