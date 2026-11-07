'use strict';
// test-model-catalog.js - claude-model-catalog.js against a stand-in for Claude Code (a node script that answers `initialize`), in a temp folder.
// Nothing real is touched and no inference is spent.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { refresh, buildList, familyOf } = require('./claude-model-catalog.js');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 400) + ']')); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-catalog-test-'));
const fake = path.join(root, 'fake-claude.js');
// The stand-in reads what to answer from FAKE_MODELS (JSON) and records the env it was started with.
fs.writeFileSync(fake, `
const fs = require('fs');
fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ cfg: process.env.CLAUDE_CONFIG_DIR, secure: process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, hasCreds: fs.existsSync(require('path').join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json')), cacheMarker: (() => { try { return JSON.parse(fs.readFileSync(require('path').join(process.env.CLAUDE_CONFIG_DIR, '.claude.json'), 'utf8')).marker || null; } catch (e) { return null; } })(), argv: process.argv.slice(2) }));
if (process.env.FAKE_MODE === 'hang') setInterval(() => {}, 1000);
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  if (buf.indexOf('\\n') < 0) return;
  const req = JSON.parse(buf.split('\\n')[0]);
  const r = process.env.FAKE_MODE === 'error'
    ? { type: 'control_response', response: { subtype: 'error', request_id: req.request_id, error: 'not signed in' } }
    : { type: 'control_response', response: { subtype: 'success', request_id: req.request_id, response: { claude_code_version: '9.9.9', models: JSON.parse(process.env.FAKE_MODELS) } } };
  process.stdout.write(JSON.stringify(r) + '\\n');
  // FAKE_WARM: renew the account's cache a moment after answering, the way Claude Code does in the background
  if (process.env.FAKE_WARM) setTimeout(() => {
    fs.writeFileSync(require('path').join(process.env.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({ cachedGrowthBookFeaturesAt: new Date().toISOString() }));
    fs.appendFileSync(process.env.FAKE_LOG + '.warm', 'renewed\\n');
  }, 800);
});
`);
const E = ['low', 'medium', 'high'];
const MODELS_A = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default', supportedEffortLevels: E },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', supportedEffortLevels: E, supportsFastMode: true },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet', supportedEffortLevels: E },
  { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku', supportedEffortLevels: E },
];
const newDir = (name) => { const d = path.join(root, name); fs.mkdirSync(d, { recursive: true }); return d; };
const opts = (dir, extra) => Object.assign({ configDir: dir, exe: process.execPath, exeArgs: [fake], noWarm: true, env: Object.assign({}, process.env, { FAKE_LOG: path.join(root, 'start.json'), FAKE_MODELS: JSON.stringify(MODELS_A) }) }, extra || {});

(async () => {
  // ---- the list
  check('familyOf reads the family', familyOf('claude-opus-5-5') === 'opus' && familyOf('claude-haiku-4-5-20251001') === 'haiku' && familyOf('opus') === '');
  let l = buildList([], MODELS_A);
  check('a new account gets the aliases then the resolved builds, no duplicate, no "default"', JSON.stringify(l) === JSON.stringify(['opus', 'sonnet', 'haiku', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']), JSON.stringify(l));
  l = buildList(['opus[1m]', 'sonnet', 'claude-opus-5[1m]', 'claude-haiku-4-5-20251001'], MODELS_A);
  check('what was there stays, after the new entries', l.slice(-3).join() === 'opus[1m],claude-opus-5[1m],claude-haiku-4-5-20251001', JSON.stringify(l));
  check('a family that had a 1M twin gets one for the new build; one that had none does not', l.indexOf('claude-opus-5-5[1m]') >= 0 && l.indexOf('claude-haiku-5-5[1m]') < 0 && l.indexOf('claude-sonnet-5-5[1m]') < 0, JSON.stringify(l));
  check('"default" stays only where it was', buildList(['default', 'sonnet'], MODELS_A)[0] === 'default' && buildList([], MODELS_A).indexOf('default') < 0);
  check('running it again on its own answer changes nothing', JSON.stringify(buildList(l, MODELS_A)) === JSON.stringify(l));

  // ---- a folder with an old list and other settings
  const d1 = newDir('acct1');
  fs.writeFileSync(path.join(d1, 'settings.json'), JSON.stringify({ theme: 'dark', availableModels: ['sonnet', 'claude-opus-4-8'], env: { A: '1' } }, null, 2));
  fs.writeFileSync(path.join(d1, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"x"}}');
  let r = await refresh(opts(d1, { dryRun: true }));
  check('a dry run reports the change and writes nothing', r.dryRun && r.changed && JSON.parse(fs.readFileSync(path.join(d1, 'settings.json'), 'utf8')).availableModels.length === 2 && !fs.existsSync(path.join(d1, 'aiondx-models.json')), JSON.stringify(r).slice(0, 200));
  const started = JSON.parse(fs.readFileSync(path.join(root, 'start.json'), 'utf8'));
  check('Claude Code is started in a scratch config folder, with the real folder as its secure-store key and the sign-in file copied', started.cfg !== d1 && started.secure === d1 && started.hasCreds === true, JSON.stringify(started));
  r = await refresh(opts(d1));
  const s1 = JSON.parse(fs.readFileSync(path.join(d1, 'settings.json'), 'utf8'));
  check('the list is written with every other key kept', r.changed && s1.theme === 'dark' && s1.env.A === '1' && s1.availableModels.indexOf('claude-opus-5-5') >= 0 && s1.availableModels.indexOf('claude-opus-4-8') >= 0, JSON.stringify(s1).slice(0, 300));
  check('the old file is kept as a backup', fs.readdirSync(d1).some((n) => /^settings\.json\.bak-\d{14}$/.test(n)));
  const stamp = JSON.parse(fs.readFileSync(path.join(d1, 'aiondx-models.json'), 'utf8'));
  check('what was learned is saved: version, each model with its efforts and flags', stamp.claudeCodeVersion === '9.9.9' && stamp.models.length === 4 && stamp.models[1].efforts.join() === 'low,medium,high' && stamp.models[1].fast === true && stamp.at > 0, JSON.stringify(stamp).slice(0, 300));
  fs.unlinkSync(path.join(root, 'start.json'));
  r = await refresh(opts(d1));
  check('a fresh file is not asked again', r.skipped === 'fresh' && !fs.existsSync(path.join(root, 'start.json')), JSON.stringify(r));
  r = await refresh(opts(d1, { force: true }));
  check('forced, an unchanged list is not rewritten', r.changed === false && fs.readdirSync(d1).filter((n) => /\.bak-/.test(n)).length === 1, JSON.stringify(r).slice(0, 200));
  r = await refresh(opts(d1, { maxAgeMs: 0 }));
  check('an old enough file is asked again', !r.skipped, JSON.stringify(r).slice(0, 120));

  // ---- a new model appears
  MODELS_A.push({ value: 'fable', resolvedModel: 'claude-fable-5-1', displayName: 'Fable', supportedEffortLevels: E });
  r = await refresh(opts(d1, { force: true, env: Object.assign({}, process.env, { FAKE_LOG: path.join(root, 'start.json'), FAKE_MODELS: JSON.stringify(MODELS_A) }) }));
  check('a model the account is newly offered is added at the next refresh', r.changed && r.added.indexOf('claude-fable-5-1') >= 0 && r.added.indexOf('fable') >= 0, JSON.stringify(r.added));

  // ---- trouble leaves the folder alone
  const d2 = newDir('acct2');
  fs.writeFileSync(path.join(d2, 'settings.json'), '{"availableModels":["sonnet"]}');
  let threw = '';
  try { await refresh(opts(d2, { env: Object.assign({}, process.env, { FAKE_LOG: path.join(root, 'start.json'), FAKE_MODE: 'error', FAKE_MODELS: '[]' }) })); } catch (e) { threw = e.message; }
  check('an error from Claude Code is reported and settings.json is untouched', /not signed in/.test(threw) && fs.readFileSync(path.join(d2, 'settings.json'), 'utf8') === '{"availableModels":["sonnet"]}', threw);
  const f2 = JSON.parse(fs.readFileSync(path.join(d2, 'aiondx-models.json'), 'utf8'));
  check('the failure is remembered, so the next chat does not try again at once', f2.failedAt > 0 && /not signed in/.test(f2.failed));
  let r2 = await refresh(opts(d2));
  check('...for half an hour', r2.skipped === 'tried lately', JSON.stringify(r2));
  const d3 = newDir('acct3');
  fs.writeFileSync(path.join(d3, 'settings.json'), '{ not json');
  threw = '';
  try { await refresh(opts(d3)); } catch (e) { threw = e.message; }
  check('a settings.json that is not JSON is left alone', /not valid JSON/.test(threw) && fs.readFileSync(path.join(d3, 'settings.json'), 'utf8') === '{ not json', threw);
  const d4 = newDir('acct4');
  threw = '';
  try { await refresh(opts(d4, { env: Object.assign({}, process.env, { FAKE_LOG: path.join(root, 'start.json'), FAKE_MODELS: '[]' }) })); } catch (e) { threw = e.message; }
  check('an empty answer writes nothing', /no models/.test(threw) && !fs.existsSync(path.join(d4, 'settings.json')), threw);
  // a second run while one is going
  const d5 = newDir('acct5');
  fs.writeFileSync(path.join(d5, 'aiondx-models.json'), JSON.stringify({ startedAt: Date.now() - 1000, pid: 999999 }));
  r2 = await refresh(opts(d5));
  check('a second start while one is running is refused', r2.skipped === 'another run is going', JSON.stringify(r2));
  // a folder that does not exist yet is made
  const d6 = path.join(root, 'new', 'deeper');
  r = await refresh(opts(d6));
  check('a folder with no settings yet gets its list', r.changed && JSON.parse(fs.readFileSync(path.join(d6, 'settings.json'), 'utf8')).availableModels.length >= 4, JSON.stringify(r).slice(0, 160));

  // ---- the usage probe asks with the account's newest Haiku (2026-10-12)
  const { usageModel } = require('./claude-stream-proxy.js');
  const d7 = newDir('acct7');
  check('with no catalog yet the probe uses the built-in Haiku id', usageModel(d7) === 'claude-haiku-5-5', usageModel(d7));
  fs.writeFileSync(path.join(d7, 'aiondx-models.json'), JSON.stringify({ at: Date.now(), models: [{ value: 'sonnet', resolvedModel: 'claude-sonnet-6' }, { value: 'haiku', resolvedModel: 'claude-haiku-6-1' }] }));
  check('with a catalog it uses the build `haiku` resolves to today', usageModel(d7) === 'claude-haiku-6-1', usageModel(d7));
  fs.writeFileSync(path.join(d7, 'aiondx-models.json'), JSON.stringify({ models: [{ value: 'haiku', resolvedModel: 'not a model; rm -rf' }] }));
  check('a strange value is not used', usageModel(d7) === 'claude-haiku-5-5', usageModel(d7));
  r = await refresh(opts(newDir('acct8')));
  const st8 = JSON.parse(fs.readFileSync(path.join(root, 'acct8', 'aiondx-models.json'), 'utf8'));
  check('the catalog the refresher saves is the one the probe reads', usageModel(path.join(root, 'acct8')) === 'claude-haiku-5-5' && st8.models.some((m) => m.value === 'haiku'), JSON.stringify(st8.models));

  // ---- the account's own cache, and the warm-up when it is old
  const d9 = newDir('acct9');
  fs.writeFileSync(path.join(d9, '.claude.json'), JSON.stringify({ cachedGrowthBookFeaturesAt: new Date().toISOString(), marker: 'acct9' }));
  const seen9 = path.join(root, 'start9.json');
  r = await refresh(opts(d9, { noWarm: false, env: Object.assign({}, process.env, { FAKE_LOG: seen9, FAKE_WARM: '1', FAKE_MODELS: JSON.stringify(MODELS_A) }) }));
  await new Promise((res) => setTimeout(res, 1200));
  check('a fresh account cache: one launch, no warm-up', !fs.existsSync(seen9 + '.warm') && !r.skipped, JSON.stringify(r).slice(0, 120));
  check("and the account's cache is what the launch reads", JSON.parse(fs.readFileSync(seen9, 'utf8')).cacheMarker === 'acct9');
  const d10 = newDir('acct10');
  fs.writeFileSync(path.join(d10, '.claude.json'), JSON.stringify({ cachedGrowthBookFeaturesAt: '2026-01-01T00:00:00Z' }));
  const seen10 = path.join(root, 'start10.json');
  const t0 = Date.now();
  r = await refresh(opts(d10, { noWarm: false, warmMs: 20000, env: Object.assign({}, process.env, { FAKE_LOG: seen10, FAKE_WARM: '1', FAKE_MODELS: JSON.stringify(MODELS_A) }) }));
  const took = Date.now() - t0;
  check('an old account cache: a warm-up launch waits for the renewal (not the whole wait), then the answer is taken', fs.existsSync(seen10 + '.warm') && took < 15000 && !r.skipped, took + ' ms');
  check("the account's own .claude.json is never written", JSON.parse(fs.readFileSync(path.join(d10, '.claude.json'), 'utf8')).cachedGrowthBookFeaturesAt === '2026-01-01T00:00:00Z');
  const home = newDir('home11'); const d11 = path.join(home, '.claude'); fs.mkdirSync(d11);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ cachedGrowthBookFeaturesAt: new Date().toISOString(), marker: 'home11' }));
  const seen11 = path.join(root, 'start11.json');
  r = await refresh(opts(d11, { env: Object.assign({}, process.env, { FAKE_LOG: seen11, FAKE_MODELS: JSON.stringify(MODELS_A) }) }));
  check('the default layout: the cache beside the .claude folder is the one copied in', JSON.parse(fs.readFileSync(seen11, 'utf8')).cacheMarker === 'home11');

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); try { fs.rmSync(root, { recursive: true, force: true }); } catch (x) { /* in use */ } process.exit(2); });
