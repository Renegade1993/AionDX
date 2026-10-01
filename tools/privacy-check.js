#!/usr/bin/env node
/**
 * privacy-check.js - nothing about the user's machine, accounts, people or other projects goes into the public GitHub
 * repository or into an installer. Run by the git hooks (every commit and every push) and by build-release.ps1 (every
 * installer); any hit stops them.
 *
 *   node tools/privacy-check.js --staged          the files staged for a commit
 *   node tools/privacy-check.js --commits REV...  every file every listed commit touches, as it is in that commit
 *   node tools/privacy-check.js --files F...      these files
 *   node tools/privacy-check.js --dir D...        every text file under these folders
 *   node tools/privacy-check.js --block F         the AionDX block of AionUi's main process (AIONDX-0009 BEGIN to END)
 *
 * What counts: every regular expression in the private list, "! LLM Files/private-terms.txt" (one per line; that folder
 * never goes to GitHub, so the words themselves are never published), this PC's user name and computer name,
 * e-mail addresses other than example and no-reply ones, user folders (C:\Users\<name>) other than placeholders, and
 * key-shaped strings. Prints file:line and what matched; exit 1 on any hit, 0 when clean.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });

function terms() {
  const out = [];
  const list = path.join(ROOT, '! LLM Files', 'private-terms.txt');
  if (fs.existsSync(list)) {
    for (const raw of fs.readFileSync(list, 'utf8').split(/\r?\n/)) {
      const t = raw.trim();
      if (!t || t.startsWith('#')) continue;
      out.push({ name: 'private term', re: new RegExp(t, 'i') });
    }
  } else console.error('privacy-check: no private list at ' + list + ' (the checks below still run)');
  for (const v of [process.env.USERNAME, process.env.COMPUTERNAME]) {
    if (v && v.length >= 3 && !/^(user|admin|administrator|runner|build)$/i.test(v)) {
      out.push({ name: 'this PC', re: new RegExp('\\b' + v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i') });
    }
  }
  // Not an address: a DLL entry point (Inno Setup's name@library.dll). Reserved and example domains are fine.
  out.push({ name: 'e-mail address', re: /[A-Za-z0-9._%+-]+@(?!(?:[a-z0-9-]+\.)*(?:example\.(?:com|org|net)|users\.noreply\.github\.com|anthropic\.com)\b)(?!github\.com\b)(?:[A-Za-z0-9-]+\.)+(?!(?:dll|exe|sys|invalid|test|localhost|example)\b)[A-Za-z]{2,}\b/ });
  out.push({ name: 'user folder', re: /\b[A-Za-z]:[\\/]+Users[\\/]+(?!(?:Public|Default|tester|you|me|name|someone|USERNAME|user)\b)(?![<%$({])[A-Za-z0-9._-]+/i });
  out.push({ name: 'key', re: /sk-ant-[A-Za-z0-9_-]{16,}|\bghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|\bxox[bp]-[A-Za-z0-9-]{20,}|\bAKIA[0-9A-Z]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY|\bAIza[0-9A-Za-z_-]{35}\b/ });
  return out;
}

function isText(buf) { return !buf.subarray(0, 8192).includes(0); }

/** What a binary file says in plain letters: runs of 8 or more printable characters, one per line, in ASCII and in
 *  UTF-16 (Windows programs and icons). Until 2026-10-01 binaries were skipped, and a compiled .pyc of a script kept
 *  out of the repository on purpose went to GitHub with the user's folder name inside it. */
function printable(buf) {
  const out = [];
  const ascii = buf.toString('latin1').match(/[\x20-\x7e]{8,}/g);
  if (ascii) out.push(...ascii);
  const wide = Buffer.from(buf).toString('utf16le').match(/[\x20-\x7e]{8,}/g);
  if (wide) out.push(...wide);
  return out.join('\n');
}

/** A file that is tracked although the ignore rules say it should not be: it was added before the rule, or forced in.
 *  Ignore rules only stop NEW files, so such a file keeps going to GitHub in every commit. */
function trackedButIgnored(hits) {
  for (const f of git(['ls-files', '-ci', '--exclude-standard', '-z']).split('\0').filter(Boolean)) {
    hits.push(`${f}: tracked although .gitignore says it stays out of the repository (git rm --cached it)`);
  }
}

/** Who a commit names. The e-mail in a commit's author and committer lines is public on GitHub (the commit page, the
 *  patch view, the events API), and until 2026-10-01 it was the user's own address. Only GitHub's no-reply address is allowed. */
const NOREPLY = /^(?:\d+\+)?[A-Za-z0-9-]+@users\.noreply\.github\.com$|^noreply@(?:anthropic|github)\.com$/;
function identityHits(label, emails, hits) {
  for (const e of emails) {
    if (e && !NOREPLY.test(e)) hits.push(`${label}: commit identity uses an e-mail address that is not GitHub's no-reply one: "${e}"`);
  }
}

function scan(label, text, rules, hits) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const r of rules) {
      const m = r.re.exec(lines[i]);
      if (m) hits.push(`${label}:${i + 1}: ${r.name}: "${m[0].slice(0, 60)}"`);
    }
  }
}

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && fs.statSync(p).size < 8 * 1024 * 1024) out.push(p);
  }
  return out;
}

const args = process.argv.slice(2);
const rules = terms();
const hits = [];
let files = 0;
const mode = args[0];
if (mode === '--staged') {
  trackedButIgnored(hits);
  // The identity the commit about to be made will carry.
  identityHits('git config', [git(['config', 'user.email']).trim()], hits);
  for (const f of git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).split('\0').filter(Boolean)) {
    const buf = execFileSync('git', ['show', ':' + f], { cwd: ROOT, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
    files++;
    scan(f, isText(buf) ? buf.toString('utf8') : printable(buf), rules, hits);
  }
} else if (mode === '--commits') {
  trackedButIgnored(hits);
  for (const rev of args.slice(1)) {
    identityHits(rev.slice(0, 8), git(['log', '-1', '--format=%ae%n%ce', rev]).split(/\r?\n/).filter(Boolean), hits);
    scan(rev.slice(0, 8) + ':message', git(['log', '-1', '--format=%B', rev]), rules, hits);
    const changed = git(['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '--diff-filter=ACMR', '-z', rev]).split('\0').filter(Boolean);
    for (const f of changed) {
      const buf = execFileSync('git', ['show', rev + ':' + f], { cwd: ROOT, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
      files++;
      scan(rev.slice(0, 8) + ':' + f, isText(buf) ? buf.toString('utf8') : printable(buf), rules, hits);
    }
  }
} else if (mode === '--files' || mode === '--dir' || mode === '--block') {
  const list = mode === '--dir' ? args.slice(1).flatMap((d) => walk(d, [])) : args.slice(1);
  for (const f of list) {
    const buf = fs.readFileSync(f);
    files++;
    if (!isText(buf)) { scan(f, printable(buf), rules, hits); continue; }
    let text = buf.toString('utf8');
    if (mode === '--block') {
      const a = text.indexOf('/* AIONDX-0009 BEGIN'), b = text.indexOf('/* AIONDX-0009 END */');
      if (a < 0 || b < a) { hits.push(f + ': the AIONDX-0009 block was not found'); continue; }
      text = text.slice(a, b);
    }
    scan(f, text, rules, hits);
  }
} else {
  console.error('usage: node tools/privacy-check.js --staged | --commits REV... | --files F... | --dir D... | --block F');
  process.exit(2);
}
for (const h of hits) console.error('privacy-check: ' + h);
console.error(`privacy-check: ${files} file(s), ${hits.length ? hits.length + ' hit(s): refused' : 'clean'}`);
process.exit(hits.length ? 1 : 0);
