#!/usr/bin/env node
/**
 * test-apply.js - the setup's import step (skill/aiondx-setup/scripts/apply.js) on a made-up home folder:
 * Claude Code and Codex with instructions, agents, commands, a skill with node_modules and a .env, MCP servers
 * in JSON and TOML with real-looking secrets, and Antigravity installed. Nothing outside a temp folder is read or
 * written (survey.js and apply.js both run with --home).
 *
 *   node patches\0004-setup-butler\test-apply.js     exit 0 only if every check passes
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SKILL = path.join(__dirname, 'skill', 'aiondx-setup', 'scripts');
const H = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-apply-'));
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 500) + ']'}`); };
const put = (rel, text, mtime) => { const f = path.join(H, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); if (mtime) fs.utimesSync(f, mtime, mtime); return f; };
const read = (rel) => fs.readFileSync(path.join(H, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(H, rel));
const old = new Date('2026-01-01T00:00:00Z'), newer = new Date('2026-09-01T00:00:00Z');

// Made-up keys, put together at run time so no secret scanner (GitHub's push protection) reads this file as holding one.
const FAKE_ANT = ['sk', 'ant', 'api03', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-');
const FAKE_GH = 'ghp' + '_realsecretvalue1234567890abcdef';

// ---- a home folder with two tools and Antigravity
put('.claude/CLAUDE.md', '# Claude rules\nAlways answer in English.\nMy key is ' + FAKE_ANT + ' do not share.\n', newer);
put('.claude/agents/reviewer.md', 'review carefully', newer);
put('.claude/commands/ship.md', 'ship it', newer);
put('.claude/skills/pdf/SKILL.md', '---\nname: pdf\n---\nmake pdfs');
put('.claude/skills/pdf/node_modules/x/index.js', 'module.exports = 1');
put('.claude/skills/pdf/.env', 'SECRET=1');
put('.claude.json', JSON.stringify({ numStartups: 3, mcpServers: {
  github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: FAKE_GH } },
  docs: { type: 'http', url: 'https://docs.example.com/mcp?api_key=realkey123', headers: { Authorization: 'Bearer real-bearer-token' } } } }));
put('.codex/AGENTS.md', '# Codex rules\nUse tabs.\n', old);
put('.codex/config.toml', '[mcp_servers.notes]\ncommand = "notes-server"\nargs = ["--port", "3"]\n[mcp_servers.notes.env]\nNOTES_TOKEN = "toml-secret-value"\n\n[other]\nx = 1\n');
put('.codex/prompts/fix.md', 'fix it');
put('AppData/Local/agy/bin/agy.exe', 'not really agy');
// A second Claude agent file of the same name, older, from Codex's prompts: exercises the name clash rule.
put('.aiondx/agents/reviewer.md', 'an older reviewer', old);

const run = (script, argv) => spawnSync(process.execPath, [path.join(SKILL, script), '--home', H].concat(argv), { encoding: 'utf8', windowsHide: true, timeout: 120000,
  env: Object.assign({}, process.env, { GITHUB_PERSONAL_ACCESS_TOKEN: 'from-env' }) });

try {
  const surveyFile = path.join(H, 'survey.json');
  const sv = run('survey.js', ['--json', '--out', surveyFile]);
  check('the survey runs on the made-up home', sv.status === 0 && fs.existsSync(surveyFile), sv.stderr || sv.stdout.slice(0, 300));

  // ---- a plan that reaches outside the survey is refused item by item
  const planFile = path.join(H, 'plan.json');
  fs.writeFileSync(planFile, JSON.stringify({ items: [path.join(H, '.claude', 'CLAUDE.md'), 'C:\\Windows\\win.ini', path.join(H, '.claude', 'settings.json')],
    mcp: [{ file: path.join(H, '.claude.json'), name: 'nope' }], wire: ['claude-code', 'somebody'] }));
  let r = run('apply.js', ['--survey', surveyFile, '--plan', planFile]);
  let out = JSON.parse(r.stdout || '{}');
  check('a plan item the survey did not find is refused, and so are an unknown server and agent', r.status === 0 &&
    out.refused.some((x) => /win\.ini/.test(x.path)) && out.refused.some((x) => /nope/.test(x.why)) && out.refused.some((x) => x.path === 'somebody'), r.stdout.slice(0, 600));
  check('nothing outside the plan was copied', out.copied.length === 1 && out.copied[0].from === path.join(H, '.claude', 'CLAUDE.md'), JSON.stringify(out.copied));

  // ---- everything
  r = run('apply.js', ['--survey', surveyFile, '--all']);
  out = JSON.parse(r.stdout || '{}');
  check('--all runs and reports', r.status === 0 && out.ok === true && fs.existsSync(out.report), r.stdout.slice(0, 400) + r.stderr);
  const md = read('.aiondx/AIONDX.md');
  check('AIONDX.md: newest instructions first, each under its own heading', md.indexOf('## From Claude Code') > 0 && md.indexOf('## From OpenAI Codex CLI') > md.indexOf('## From Claude Code') &&
    /Always answer in English/.test(md) && /Use tabs/.test(md), md.slice(0, 500));
  check('a key in the instructions is left out and counted', !/sk-ant-api03/.test(md) && /removed by AionDX setup/.test(md) && out.secretsRemoved === 1, md);
  check('copies keep their layout under harvest/<date>/<tool>/', exists(`.aiondx/harvest/${out.date}/claude-code/.claude/agents/reviewer.md`) &&
    exists(`.aiondx/harvest/${out.date}/codex/.codex/AGENTS.md`), JSON.stringify(out.copied));
  check('no .env and no node_modules are copied', !exists(`.aiondx/harvest/${out.date}/claude-code/.claude/skills/pdf/.env`) &&
    !exists(`.aiondx/harvest/${out.date}/claude-code/.claude/skills/pdf/node_modules`) && exists(`.aiondx/harvest/${out.date}/claude-code/.claude/skills/pdf/SKILL.md`));
  check('custom files land under ~/.aiondx/<kind>/; the newer takes the name, the older is kept beside it', read('.aiondx/agents/reviewer.md') === 'review carefully' &&
    exists('.aiondx/agents/reviewer.before-claude-code.md') && exists('.aiondx/commands/ship.md') && exists('.aiondx/skills/pdf/SKILL.md'),
    fs.readdirSync(path.join(H, '.aiondx', 'agents')).join(','));

  const mcp = JSON.parse(read('.aiondx/mcp/servers.json'));
  const s = mcp.mcpServers;
  check('MCP servers go into the AionDX MCP file in its own form', Array.isArray(mcp._about) && s.github && s.github.type === 'stdio' && s.github.command === 'npx' &&
    s.docs && s.docs.type === 'http' && s.notes && s.notes.command === 'notes-server' && JSON.stringify(s.notes.args) === '["--port","3"]', JSON.stringify(s));
  check('every env and header value is a ${NAME} placeholder; the URL query value too', s.github.env.GITHUB_PERSONAL_ACCESS_TOKEN === '${GITHUB_PERSONAL_ACCESS_TOKEN}' &&
    s.notes.env.NOTES_TOKEN === '${NOTES_TOKEN}' && /^\$\{DOCS_AUTHORIZATION\}$/.test(s.docs.headers.Authorization) && /api_key=\$\{API_KEY\}/.test(s.docs.url), JSON.stringify(s));
  const everything = fs.readdirSync(path.join(H, '.aiondx'), { recursive: true }).map((f) => path.join(H, '.aiondx', f)).filter((f) => fs.statSync(f).isFile() && !f.includes(path.sep + 'backups' + path.sep)).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  check('no secret value from any config reaches ~/.aiondx (the undo backups of agent files stay exact copies)', !/ghp_realsecret|realkey123|real-bearer-token|toml-secret-value|sk-ant-api03/.test(everything),
    (everything.match(/.{0,60}(ghp_realsecret|realkey123|real-bearer-token|toml-secret-value|sk-ant-api03).{0,20}/) || [])[0]);
  check('a placeholder the environment already fills is named as such', out.mcp.fromEnvironment.includes('GITHUB_PERSONAL_ACCESS_TOKEN') && out.mcp.placeholders.includes('NOTES_TOKEN'), JSON.stringify(out.mcp));

  const claude = read('.claude/CLAUDE.md');
  const codex = read('.codex/AGENTS.md');
  const agy = read('.gemini/config/AGENTS.md');
  check("each agent's own file gets the block, without the part that came from it", /<!-- AionDX instructions: begin -->/.test(claude) && /## From OpenAI Codex CLI/.test(claude) &&
    !/## From Claude Code/.test(claude) && /## From Claude Code/.test(codex) && !/## From OpenAI Codex CLI/.test(codex), claude + '\n----\n' + codex);
  check('the agent file keeps what it had, above the block', claude.indexOf('# Claude rules') === 0 && /Always answer in English/.test(claude.split('<!-- AionDX')[0]), claude.slice(0, 200));
  check('Antigravity, installed, gets its file made', /## From Claude Code/.test(agy) && /## From OpenAI Codex CLI/.test(agy) && out.wired.some((w) => w.agent === 'antigravity' && w.created), JSON.stringify(out.wired));
  check('Gemini CLI and others not installed are left alone', !exists('.gemini/GEMINI.md') && !exists('.qwen/QWEN.md') && !out.wired.some((w) => w.agent === 'gemini-cli'), JSON.stringify(out.wired.map((w) => w.agent)));
  const backup = out.wired.find((w) => w.agent === 'claude-code').backup;
  check('the agent file was backed up first, as it was', backup && fs.readFileSync(backup, 'utf8').startsWith('# Claude rules') && !/AionDX instructions/.test(fs.readFileSync(backup, 'utf8')), backup);
  const report = fs.readFileSync(out.report, 'utf8');
  check('the report says what changed outside ~/.aiondx and how to undo it', /## Changed outside ~\/.aiondx/.test(report) && /To undo: copy .* back over it, or delete everything from/.test(report) &&
    /GITHUB_PERSONAL_ACCESS_TOKEN already set in your environment/.test(report) || /GITHUB_PERSONAL_ACCESS_TOKEN/.test(report), report.slice(0, 800));

  // ---- again: nothing doubles up
  r = run('apply.js', ['--survey', surveyFile, '--all']);
  const out2 = JSON.parse(r.stdout || '{}');
  const claude2 = read('.claude/CLAUDE.md');
  check('a second run replaces the block instead of adding another', r.status === 0 && claude2.split('<!-- AionDX instructions: begin -->').length === 2, claude2);
  check('and the MCP servers read as already there', out2.mcp && out2.mcp.added.length === 0 && out2.mcp.same.length === 3, JSON.stringify(out2.mcp));
  check('the AionDX MCP file is still readable JSON with the same three servers', Object.keys(JSON.parse(read('.aiondx/mcp/servers.json')).mcpServers).sort().join(',') === 'docs,github,notes');
} catch (e) {
  check('no exception', false, e.stack);
} finally {
  fs.rmSync(H, { recursive: true, force: true });
}
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
