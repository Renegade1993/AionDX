'use strict';
// aiondx-notices.js (patches/0009-identity): what the chat's notification bell holds (R-112).
//
// The bell holds only notices whose condition this code has just checked and found true; a notice whose condition stops holding is gone on
// the next check. Nothing here restarts an agent: a restart costs the user usage, so the bell offers it as a button and the user decides.
//
// Inputs, all on this PC:
//   <data folder>\aiondx-launches\<conversation id>.json   written by the Claude launcher (claude-account-router.js) at each agent launch:
//                                                           {at, pid, project, acct, docs, fullSignIn, signInDir}
//   <data folder>\aiondx-projects.json                      the projects registry: which chats and accounts have Claude Docs on
//   <sign-in folder>\.credentials.json                      whether the account has a full sign-in (with its renewal key)
//
// Notices (each {id, kind, conv, title, text, action}):
//   docs-signin      Claude Docs is on for the chat, and its account has no full sign-in, so Docs cannot load. Action: sign in.
//   docs-reconnect   Claude Docs is on now, and the running agent started with it off. Action: reconnect.
//   signin-reconnect Docs is on, the account is signed in now, and the running agent started on the older sign-in. Action: reconnect.
//   launch-failed    the agent's last start failed (the launcher's record says why). Action: reconnect (Try again).
//
// Request (ipc "aiondx:notices"): {op: "check", convIds: [...]} -> {ok, notices}.

const fs = require('fs');
const path = require('path');
const os = require('os');

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

/** The same rule the launcher uses (claude-account-router.js projectSetup): a bound project decides; a chat with no project follows its account. */
function docsWanted(reg, project, acct, accountKey) {
  if (!reg) return false;
  const projects = reg.projects && typeof reg.projects === 'object' ? reg.projects : {};
  const proj = project && projects[project] ? projects[project] : null;
  if (proj) {
    const owns = (proj.domain === 'work' && acct === 'work') || (proj.domain === 'personal' && acct === 'personal');
    const allowed = !Array.isArray(proj.accounts) || proj.accounts.indexOf(acct) >= 0;
    return proj.docs === 'on' && owns && allowed;
  }
  // an account AionDX added has its own entry (accountDocs.<its key>); the others follow personal or work
  const map = reg.accountDocs || {};
  if (accountKey && map[accountKey] !== undefined) return map[accountKey] === 'on';
  return map[acct] === 'on';
}

/** The same test the launcher uses: a full sign-in has its access and renewal keys, and the renewal key has not run out. */
function hasFullSignIn(dir) {
  const o = (readJson(path.join(dir || '', '.credentials.json')) || {}).claudeAiOauth || {};
  if (Number(o.refreshTokenExpiresAt) > 0 && Number(o.refreshTokenExpiresAt) < Date.now() + 60000) return false;
  return !!(o.accessToken && o.refreshToken);
}

/** The account name AionDX's sign-in uses for a folder: %USERPROFILE%\.claude is "" (this PC's usual sign-in), .claude-<name> is <name>. */
function signInAccountFor(dir) {
  const b = path.basename(String(dir || ''));
  if (b === '.claude') return '';
  const m = /^\.claude-([a-z0-9][a-z0-9-]{0,23})$/.exec(b);
  return m ? m[1] : null;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

function acctName(acct) { return acct === 'work' ? 'work' : 'personal'; }

/** The notices for one chat, from its launch record and the current settings. */
function noticesFor(dataDir, convId, opts) {
  const o = opts || {};
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(convId || ''))) return [];
  const rec = readJson(path.join(dataDir, 'aiondx-launches', convId + '.json'));
  if (!rec || rec.v !== 1) return [];
  const reg = readJson(path.join(dataDir, 'aiondx-projects.json'));
  // Projects are optional (November 16th, 2026): a chat with no project is never asked
  // for one. R-128 step 6: skill changes (imports, agents' proposals) waiting for the user, in this chat's project and in their own layer.
  const projectNotice = [];
  const proj = rec.project && reg && reg.projects ? reg.projects[rec.project] : null;
  const waitingIn = (root) => { try { return fs.readdirSync(path.join(root, '.claude', 'skills-pending'), { withFileTypes: true }).filter((e) => e.isDirectory()).length; } catch { return 0; } };
  const mine = waitingIn(o.home || os.homedir());
  const theirs = proj && proj.root ? waitingIn(proj.root) : 0;
  const waiting = mine + theirs;
  if (waiting) projectNotice.push({ id: 'skills-pending:' + (rec.project || '') + ':' + theirs + ':' + mine, kind: 'skills', conv: convId,
    title: waiting === 1 ? 'A skill change is waiting for you' : waiting + ' skill changes are waiting for you',
    text: 'New or changed skills' + (theirs && !mine ? ' for ' + path.basename(proj.root) : '') + ' wait in DX Skills until you look at what they do and approve them.',
    action: { op: 'skills', label: 'Review them' } });
  // November 23rd, 2026: a launch that failed (the launcher adds {failed: {at, error}} to the record; a later launch writes a fresh record
  // without it). Before this the user saw only "UserAgentDisconnected", and the real error was in the launcher's own log.
  if (rec.failed && rec.failed.error && Number(rec.failed.at) >= Number(rec.at || 0)) {
    const tooLong = /ENAMETOOLONG/i.test(rec.failed.error);
    projectNotice.unshift({ id: 'launch-failed:' + convId + ':' + rec.failed.at, kind: 'launch', conv: convId,
      title: 'This agent could not start',
      text: 'Its last start failed: ' + rec.failed.error + '.' + (tooLong
        ? ' The command that starts it was longer than Windows allows; this AionDX moves the long parts into files, so trying again should work. If it does not, unpin large skills from this chat or team.'
        : ' Messages sent to it wait or fail until it starts. Trying again starts it fresh with the chat kept.'),
      action: { op: 'reconnect', label: 'Try again' } });
  }
  const wanted = docsWanted(reg, rec.project, rec.acct, rec.accountKey);
  if (!wanted) return projectNotice;
  const alive = (o.pidAlive || pidAlive)(rec.pid);
  const full = (o.hasFullSignIn || hasFullSignIn)(rec.signInDir);
  const out = projectNotice.slice();
  const who = acctName(rec.acct);
  if (!full) {
    const account = signInAccountFor(rec.signInDir);
    out.push({ id: 'docs-signin:' + (rec.signInDir || who), kind: 'signin', conv: convId,
      title: 'Sign in to use Claude Docs',
      text: 'Claude Docs is on for this chat, but its ' + who + ' Claude account is not signed in to claude.ai on this PC, so Docs cannot load. Sign in once and AionDX keeps it.',
      action: account === null ? null : { op: 'signin', account, label: 'Sign in' } });
    return out;
  }
  if (!alive) return out;   // no agent running: the next message starts one with everything current
  if (!rec.docs) {
    out.push({ id: 'docs-reconnect:' + convId + ':' + rec.at, kind: 'reconnect', conv: convId,
      title: 'Reconnect to use Claude Docs',
      text: 'Claude Docs was turned on after this agent started, so it does not have it yet. Reconnecting restarts the agent with the chat kept; it costs one fresh start of usage.',
      action: { op: 'reconnect', label: 'Reconnect' } });
  } else if (!rec.fullSignIn) {
    out.push({ id: 'signin-reconnect:' + convId + ':' + rec.at, kind: 'reconnect', conv: convId,
      title: 'Reconnect to finish the sign-in',
      text: 'This agent started before its account was signed in to claude.ai, so Claude Docs is missing. Reconnecting restarts the agent with the chat kept; it costs one fresh start of usage.',
      action: { op: 'reconnect', label: 'Reconnect' } });
  }
  return out;
}

function install(electron, dataDirFn) {
  const dataDir = dataDirFn || (() => electron.app.getPath('userData'));
  electron.ipcMain.handle('aiondx:notices', async (_event, req) => {
    try {
      if (!req || req.op !== 'check') return { ok: false, error: 'unknown request' };
      const ids = Array.isArray(req.convIds) ? req.convIds.slice(0, 40) : [];
      const dir = dataDir();
      let notices = [];
      for (const id of ids) notices = notices.concat(noticesFor(dir, String(id)));
      // one sign-in notice per account, however many chats share it
      const seen = new Set();
      notices = notices.filter((n) => (n.kind !== 'signin' || !seen.has(n.id)) && (seen.add(n.id), true));
      return { ok: true, notices };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  });
}

module.exports = { install, noticesFor, docsWanted, hasFullSignIn, signInAccountFor, pidAlive };
