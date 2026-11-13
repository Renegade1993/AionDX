#!/usr/bin/env node
// runtime-api.js - call AionUi's API (AionCore) as the chat this shell belongs to, with its runtime token, the way an agent's tools do.
// For checks during development: read a team's run state, restart an idle member, message a team. Prints the status and the JSON answer.
//   node tools\runtime-api.js GET /api/teams
//   node tools\runtime-api.js GET /api/teams/<team>/run-state
//   node tools\runtime-api.js POST /api/teams/<team>/agents/<slot>/runtime/restart "{}"
//   node tools\runtime-api.js POST /api/teams/<team>/messages "{\"content\":\"...\"}"   (or --body-file FILE)
// Needs the variables AionUi gives each agent: AIONDX_BASE_URL (or AIONUI_BASE_URL), AIONDX_RUNTIME_TOKEN, AIONDX_USER_ID,
// AIONDX_CONVERSATION_ID. The token never prints. Team lifecycle routes answer 403 unless this chat is that team's lead (core-0015).
// Never print another chat's messages into a reply to the user; summarise shapes and counts.
const fs = require('fs');
const [method, given, ...rest] = process.argv.slice(2);
// Git Bash turns an argument that starts with / into a Windows path ("/api/teams" arrives as "C:/Program Files/Git/api/teams"): take the
// route from its "/api/" on, and accept "api/teams" with no slash too.
const at = String(given || '').replace(/\\/g, '/').indexOf('/api/');
const route = at >= 0 ? String(given).replace(/\\/g, '/').slice(at) : /^api\//.test(String(given || '')) ? '/' + given : '';
if (!method || !route || !/^(GET|POST|PUT|PATCH|DELETE)$/i.test(method)) {
  console.log('usage: node tools\\runtime-api.js GET|POST|PUT|PATCH|DELETE /api/... [JSON body | --body-file FILE]');
  process.exit(2);
}
const base = (process.env.AIONDX_BASE_URL || process.env.AIONUI_BASE_URL || '').replace(/\/+$/, '');
const tok = process.env.AIONDX_RUNTIME_TOKEN || process.env.AIONUI_RUNTIME_TOKEN;
if (!base || !tok) { console.log('runtime-api: this shell has no AionUi runtime token or base URL (run it from an agent\'s shell in AionDX)'); process.exit(2); }
let body, outFile = null;
const oi = rest.indexOf('--out');
if (oi >= 0) { outFile = rest[oi + 1]; rest.splice(oi, 2); }   // --out FILE: the whole answer to FILE (the screen copy is cut at 20,000 characters)
if (rest[0] === '--body-file') body = fs.readFileSync(rest[1], 'utf8');
else if (rest.length) body = rest.join(' ');
const headers = { 'Content-Type': 'application/json', 'x-aiondx-runtime-token': tok, 'x-aiondx-user-id': process.env.AIONDX_USER_ID || '',
  'x-aiondx-conversation-id': process.env.AIONDX_CONVERSATION_ID || '' };
const ac = new AbortController();
const timer = setTimeout(() => ac.abort(), 30000);
fetch(base + route, { method: method.toUpperCase(), headers, body, signal: ac.signal }).then(async (r) => {
  clearTimeout(timer);
  const text = await r.text();
  let out = text;
  try { out = JSON.stringify(JSON.parse(text), null, 2); } catch { /* not JSON */ }
  console.log(r.status);
  if (outFile) { fs.writeFileSync(outFile, text); console.log('written: ' + outFile + ' (' + text.length + ' characters)'); process.exit(r.ok ? 0 : 1); }
  console.log(out.length > 20000 ? out.slice(0, 20000) + '\n... (' + out.length + ' characters; cut)' : out);
  process.exit(r.ok ? 0 : 1);
}, (e) => { clearTimeout(timer); console.log('runtime-api: ' + (e.name === 'AbortError' ? 'no answer in 30 s' : e.message)); process.exit(1); });
