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
 *     never sees them and falls back to its own defaults (the old AionUi folders).
 *   - the error codes AionCore sends (AIONUI_STREAM_BROKEN ...), which the page looks up by name in its error catalog. Differ, and
 *     the error shows the generic "The agent could not reply" title. Also: the catalog's ownership labels use the same keys in
 *     every language (four languages had theirs renamed).
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

/** Error codes the app has a catalog entry for (a key holding { title: ... }), in main and the page bundles, quoted or not. */
function catalogCodes(texts) {
  const codes = new Set();
  for (const s of texts) for (const m of s.matchAll(/["']?([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)["']?:\{["']?title["']?:/g)) codes.add(m[1]);
  return codes;
}

/** The key list of every copy of the error catalog's ownership map (one per language), e.g. "aionui,user_agent,...". */
function ownershipKeySets(texts) {
  const sets = new Set();
  for (const s of texts) for (const m of s.matchAll(/["']?ownership["']?:\{([^{}]*)\}/g)) {
    sets.add([...m[1].matchAll(/["']?([a-z_]+)["']?:/g)].map((k) => k[1]).join(','));
  }
  return sets;
}

function check(mainJs, coreBuf, pageTexts) {
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
  // The other direction: codes AionCore sends, looked up by name in the page's error catalog. Only the brand-prefixed ones are the
  // rename's business (the catalog also holds codes no AionCore version sends any more).
  const texts = [mainJs].concat(pageTexts || []);
  const branded = [...catalogCodes(texts)].filter((c) => /^AION[A-Z]*_/.test(c)).sort();
  found.codes = branded;
  for (const code of branded) {
    if (coreBuf.includes(Buffer.from(code, 'utf8'))) continue;
    const other = code.startsWith('AIONDX_') ? 'AIONUI_' + code.slice(7) : code.startsWith('AIONUI_') ? 'AIONDX_' + code.slice(7) : null;
    problems.push(`the error catalog has ${code}, which AionCore never sends` + (other && coreBuf.includes(Buffer.from(other, 'utf8')) ? ` (it sends ${other})` : ''));
  }
  const owners = ownershipKeySets(texts);
  found.ownership = [...owners];
  if (owners.size > 1) problems.push('the error catalog\'s ownership labels differ between languages: ' + [...owners].join(' | '));
  return { problems, found };
}

function main(argv) {
  const [root, core] = argv;
  if (!root || !core) { console.error('usage: node check-core-contract.js <extracted-asar-root> <aioncore.exe>'); return 2; }
  const assets = path.join(root, 'out', 'renderer', 'assets');
  const pages = fs.existsSync(assets) ? fs.readdirSync(assets).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(assets, f), 'utf8')) : [];
  const r = check(fs.readFileSync(path.join(root, 'out', 'main', 'index.js'), 'utf8'), fs.readFileSync(core), pages);
  if (r.problems.length) { for (const p of r.problems) console.error('core contract: ' + p); return 1; }
  console.log('core contract: ' + CONSTANTS.map((n) => `${n} "${r.found[n]}"`).join(', ') + ', start-up variables ' + r.found.env.join(', ') +
    ', error codes ' + r.found.codes.join(', ') + ' match AionCore; ownership labels the same in every language');
  return 0;
}

module.exports = { check, spawnEnvNames, catalogCodes, ownershipKeySets, CONSTANTS };
if (require.main === module) process.exit(main(process.argv.slice(2)));
