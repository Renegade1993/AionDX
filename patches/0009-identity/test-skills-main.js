'use strict';
// test-skills-main.js - aiondx-skills-main.js (R-128 step 3) on made-up folders: a chat's skills from every layer, the nearest winning, the
// switch written where Claude Code reads it, pins, and this chat's uses counted from its transcripts. Nothing real is read or written.
//   node patches\0009-identity\test-skills-main.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require(path.join(__dirname, 'aiondx-skills-main.js'));
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 500) + ']')); };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiondx-skills-'));
(async () => {
  try {
    const home = path.join(root, 'home'), userData = path.join(root, 'AionDX'), ws = path.join(root, 'chats', 'c1');
    const shared = path.join(root, 'Shared'), proj = path.join(root, 'Atlas Game'), builtin = path.join(userData, 'aionui', 'builtin-skills', 'auto-inject');
    fs.mkdirSync(ws, { recursive: true });
    const skill = (dir, folder, fm, body) => { fs.mkdirSync(path.join(dir, folder), { recursive: true }); fs.writeFileSync(path.join(dir, folder, 'SKILL.md'), '---\n' + fm + '\n---\n' + (body || 'body')); };
    skill(path.join(home, '.claude', 'skills'), 'notes', 'name: notes\ndescription: Keep notes.');
    skill(path.join(home, '.claude', 'skills'), 'build', 'name: build\ndescription: "Personal build"');
    skill(path.join(shared, '.claude', 'skills'), 'review', 'name: review\ndescription: >-\n  Review code\n  carefully.\ndisable-model-invocation: true');
    skill(path.join(proj, '.claude', 'skills'), 'build', 'name: build\ndescription: Project build', 'x'.repeat(4000));
    skill(builtin, 'aiondx-loop', 'name: aiondx-loop\ndescription: The Loop.');
    fs.mkdirSync(path.join(home, '.claude', 'skills', 'not-a-skill'), { recursive: true });
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(path.join(userData, 'aiondx-projects.json'), JSON.stringify({ skillRoots: [shared], projects: { atlas: { root: proj } }, bindings: { 'conv:c1': 'atlas' } }));
    // two transcripts of this chat, one of another
    const tdir = path.join(home, '.claude', 'projects', ws.replace(/[^A-Za-z0-9]/g, '-'));
    fs.mkdirSync(tdir, { recursive: true });
    fs.writeFileSync(path.join(tdir, 'a.jsonl'), [
      JSON.stringify({ timestamp: '2026-11-10T10:00:00Z', message: { content: [{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'build' } }] } }),
      JSON.stringify({ timestamp: '2026-11-12T10:00:00Z', message: { content: [{ type: 'tool_use', id: 't2', name: 'Skill', input: { skill: 'build' } }] } }),
      JSON.stringify({ timestamp: '2026-11-11T10:00:00Z', message: { content: [{ type: 'tool_use', id: 't3', name: 'Skill', input: { skill: 'aionui:aiondx-loop' } }] } }),
    ].join('\n'));
    fs.writeFileSync(path.join(tdir, 'b.jsonl'), JSON.stringify({ timestamp: '2026-11-13T09:00:00Z', message: { content: '<command-name>/review</command-name>' } }));
    const other = path.join(home, '.claude', 'projects', 'C--elsewhere');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'c.jsonl'), JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'notes' } }] } }));

    check('front matter: plain, quoted and folded values', S.frontMatter('---\nname: a\ndescription: "b c"\n---').description === 'b c' && S.frontMatter('---\ndescription: >-\n  one\n  two\n---').description === 'one two');
    let r = S.list({ conv: 'c1', ws, home, userData, builtinDir: builtin });
    const by = Object.fromEntries(r.skills.map((s) => [s.name, s]));
    check('every layer: AionDX, yours, shared and the project, a folder without SKILL.md left out', r.ok && r.total === 4 && by['aiondx-loop'].layer.kind === 'aiondx' && by.notes.layer.kind === 'yours' && by.review.layer.kind === 'shared' && !by['not-a-skill'], JSON.stringify(r.skills.map((s) => [s.name, s.layer.kind])));
    check('the project\'s skill wins over yours of the same name, and says what it hides', by.build.layer.kind === 'project' && by.build.layer.label === 'Atlas Game' && by.build.description === 'Project build' && by.build.shadows === 'Yours', JSON.stringify(by.build));
    check('this chat\'s uses: tool calls and typed /commands, with the last time; another chat\'s are not counted', by.build.uses === 2 && by.build.lastUsed === '2026-11-12T10:00:00Z' && by['aiondx-loop'].uses === 1 && by.review.uses === 1 && by.notes.uses === 0, JSON.stringify(r.skills.map((s) => [s.name, s.uses, s.lastUsed])));
    check('a skill only you start is marked so', by.review.userOnly === true);
    check('every switch on by default; cost is the description alone', r.skills.every((s) => s.state === 'on') && by.build.cost < 20, JSON.stringify(by.build));
    // the switch
    let x = S.setState(ws, 'notes', 'off');
    const local = JSON.parse(fs.readFileSync(path.join(ws, '.claude', 'settings.local.json'), 'utf8'));
    check('a switch is written into the chat\'s own .claude\\settings.local.json as skillOverrides', x.ok && local.skillOverrides.notes === 'off', JSON.stringify(local));
    fs.writeFileSync(path.join(ws, '.claude', 'settings.local.json'), JSON.stringify(Object.assign(local, { permissions: { allow: ['Bash(ls)'] } })));
    S.setState(ws, 'review', 'name-only');
    S.setState(ws, 'notes', 'on');
    const local2 = JSON.parse(fs.readFileSync(path.join(ws, '.claude', 'settings.local.json'), 'utf8'));
    check('back on removes the entry; the file\'s other settings are kept', !('notes' in local2.skillOverrides) && local2.skillOverrides.review === 'name-only' && local2.permissions.allow[0] === 'Bash(ls)', JSON.stringify(local2));
    check('a bad switch or name is refused', !S.setState(ws, 'notes', 'maybe').ok && !S.setState(ws, '../x', 'off').ok && !S.setState('', 'notes', 'off').ok);
    r = S.list({ conv: 'c1', ws, home, userData, builtinDir: builtin });
    check('the list shows the switch', r.skills.find((s) => s.name === 'review').state === 'name-only');
    // pins
    x = S.setPin(userData, 'c:c1', 'build', true);
    S.setPin(userData, 't:t1', 'notes', true);
    check('pins: kept per chat and per team', x.ok && JSON.stringify(JSON.parse(fs.readFileSync(path.join(userData, 'aiondx-skill-pins.json'), 'utf8'))) === JSON.stringify({ 'c:c1': ['build'], 't:t1': ['notes'] }));
    r = S.list({ conv: 'c1', ws, team: 't1', home, userData, builtinDir: builtin });
    const b2 = Object.fromEntries(r.skills.map((s) => [s.name, s]));
    check('a pinned skill is listed first and costs its whole text', r.skills[0].pinned && b2.build.pinned && b2.build.cost > 1000 && b2.notes.pinned && b2.notes.teamPinned, JSON.stringify(r.skills.map((s) => [s.name, s.pinned, s.cost])));
    S.setPin(userData, 'c:c1', 'build', false);
    check('unpinned', !(JSON.parse(fs.readFileSync(path.join(userData, 'aiondx-skill-pins.json'), 'utf8'))['c:c1']));
    check('a bad key is refused', !S.setPin(userData, 'x:1', 'build', true).ok);
    // a team member matched by its team's name
    fs.writeFileSync(path.join(userData, 'aiondx-projects.json'), JSON.stringify({ skillRoots: [], projects: { atlas: { root: proj } }, bindings: {} }));
    r = S.list({ conv: 'm1', ws, team: 't9', teamName: 'Atlas Team', home, userData, builtinDir: builtin });
    check('a team member with no binding: its team\'s name finds the project', r.skills.some((s) => s.layer.kind === 'project'), JSON.stringify(r.skills.map((s) => s.layer.kind)));
    // the ipc handler
    let handler = null;
    S.install({ app: { getPath: () => userData }, ipcMain: { handle: (ch, f) => { handler = f; } } });
    process.env.AIONDX_SKILLS_HOME = home;
    const h = await handler({}, { op: 'list', conv: 'c1', ws });
    check('the handler lists through the same code', h.ok && h.total >= 3, JSON.stringify(h).slice(0, 200));
    check('an unknown request is refused', (await handler({}, { op: 'other' })).ok === false);
    // agents' skill changes: the review setting the loop tool reads (November 16th, 2026)
    check('review setting: auto when nothing is saved', (await handler({}, { op: 'reviewGet' })).review === 'auto');
    const rs = await handler({}, { op: 'reviewSet', review: 'off' });
    check('set to off: saved in aiondx-skills.json, read back', rs.ok && JSON.parse(fs.readFileSync(path.join(userData, 'aiondx-skills.json'), 'utf8')).review === 'off' && (await handler({}, { op: 'reviewGet' })).review === 'off', JSON.stringify(rs));
    check('anything but auto, always or off is refused', (await handler({}, { op: 'reviewSet', review: 'sometimes' })).ok === false);
  } catch (e) {
    check('no exception', false, e.stack);
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* temp */ }
    console.log(`\n${pass}/${pass + fail} passed`);
    process.exit(fail ? 1 : 0);
  }
})();
