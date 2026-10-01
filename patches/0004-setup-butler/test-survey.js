#!/usr/bin/env node
/**
 * Tests for the aiondx-setup skill's survey.js. Run: node patches\0004-setup-butler\test-survey.js
 *
 * Builds a fake home folder holding planted secrets, runs the survey against it with --home, and
 * checks the three promises the skill makes in code:
 *   NO SECRETS     no secret value appears anywhere in the output: MCP env and header values,
 *                  credential files, tokens in URLs
 *   EXCLUSIONS     nothing under a path in ~/.aiondx/exclusions.txt is looked at
 *   READ-ONLY      the fake home is byte-identical afterwards, apart from the survey's own output
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SURVEY = path.join(__dirname, 'skill', 'aiondx-setup', 'scripts', 'survey.js');
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) { pass++; console.log('PASS  ' + name); } else { fail++; console.log('FAIL  ' + name + (detail ? '   ' + String(detail).slice(0, 300) : '')); } };

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-survey-'));
const w = (rel, text) => { const p = path.join(home, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
const SECRETS = ['sk-ant-PLANTED-0001', 'ghp_PLANTED0002', 'AIzaPLANTED0003', 'hdr-PLANTED-0004', 'url-PLANTED-0005', 'cred-PLANTED-0006'];

w('.claude/CLAUDE.md', '# my rules\nBe direct.\n');
w('.claude/commands/ship.md', 'ship it');
w('.claude/.credentials.json', JSON.stringify({ token: SECRETS[5] }));
w('.claude/settings.json', JSON.stringify({ env: { ANTHROPIC_API_KEY: SECRETS[0] }, hooks: {} }));
w('.claude.json', JSON.stringify({ mcpServers: {
  github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: SECRETS[1] } },
  remote: { type: 'http', url: 'https://example.invalid/mcp?api_key=' + SECRETS[4], headers: { Authorization: 'Bearer ' + SECRETS[3] } },
} }));
w('.codex/config.toml', '[mcp_servers.docs]\ncommand = "uvx"\nargs = ["docs-mcp"]\n\n[mcp_servers.docs.env]\nDOCS_KEY = "' + SECRETS[2] + '"\n');
w('.gemini/GEMINI.md', 'excluded instructions');
w('.aiondx/exclusions.txt', '# never read\n~/.gemini\n');
w('.agents/SCRIPT-REGISTRY.md', '| Script |\n');

function snapshot(dir) {
  const out = {};
  (function walk(d) {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p); else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8') + '|' + st.mtimeMs;
    }
  })(dir);
  return out;
}
const before = snapshot(home);
const outFile = path.join(os.tmpdir(), 'aiondx-survey-out-' + process.pid + '.json');
const r = spawnSync(process.execPath, [SURVEY, '--home', home, '--json', '--out', outFile], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
check('survey exits 0', r.status === 0, r.stderr);
let j = null;
try { j = JSON.parse(r.stdout); } catch (e) { check('survey prints JSON with --json', false, e.message); }
const all = (r.stdout || '') + (r.stderr || '') + (fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '');

// NO SECRETS
for (const s of SECRETS) check('no planted secret in the output: ' + s.slice(0, 8) + '...', !all.includes(s));
if (j) {
  const claude = j.tools.find((t) => t.id === 'claude-code');
  const mcp = claude && claude.locations.find((l) => l.kind === 'mcp');
  const names = (mcp && mcp.mcp && mcp.mcp.servers || []).map((s) => s.name).sort();
  check('Claude Code found, MCP servers listed by name', claude && claude.installed && names.join() === 'github,remote', names.join());
  const gh = mcp.mcp.servers.find((s) => s.name === 'github');
  check('an MCP server keeps its command and args', gh.command === 'npx' && gh.args.join(' ') === '-y @modelcontextprotocol/server-github');
  check('env and header NAMES are kept, values are not', gh.envNames.join() === 'GITHUB_TOKEN' && mcp.mcp.servers.find((s) => s.name === 'remote').headerNames.join() === 'Authorization');
  const dir = claude.locations.find((l) => l.kind === 'commands');
  check('folders are listed by entry name', dir && dir.entries && dir.entries.includes('ship.md'));
  const codex = j.tools.find((t) => t.id === 'codex');
  const toml = codex.locations.find((l) => l.kind === 'mcp');
  check('Codex TOML MCP servers parsed, env table ignored', toml.mcp.servers.map((s) => s.name).join() === 'docs' && /uvx/.test(toml.mcp.servers[0].command));
  // EXCLUSIONS
  const gem = j.tools.find((t) => t.id === 'gemini-cli');
  check('an excluded folder is reported as excluded, not read', gem.locations.every((l) => l.excluded === true && !l.exists), JSON.stringify(gem.locations));
  check('the exclusions list is echoed', j.exclusions.length === 1);
  // bread crumbs in test mode
  check('script registry found', (j.breadcrumbs.scriptRegistries || []).some((x) => x.exists));
  check('environment variables reported by name only', Array.isArray(j.breadcrumbs.environmentVariableNames) && !all.includes('='.repeat(1) + SECRETS[0]));
}
// the secret-looking file in a listed folder
const claudeDirListing = spawnSync(process.execPath, ['-e', 'const c=require(' + JSON.stringify(path.join(__dirname, 'skill', 'aiondx-setup', 'references', 'catalog.json')) + ');console.log(c.tools.length)'], { encoding: 'utf8', windowsHide: true });
check('catalog loads', claudeDirListing.status === 0 && Number(claudeDirListing.stdout) > 0);

// READ-ONLY
const after = snapshot(home);
const changed = Object.keys(before).filter((k) => before[k] !== after[k]).concat(Object.keys(after).filter((k) => !(k in before)));
check('the fake home is unchanged (the survey wrote only to --out)', changed.length === 0, changed.join(', '));

fs.rmSync(home, { recursive: true, force: true });
try { fs.rmSync(outFile); } catch { /* already gone */ }
console.log('\n' + pass + '/' + (pass + fail) + ' passed');
process.exit(fail ? 1 : 0);
