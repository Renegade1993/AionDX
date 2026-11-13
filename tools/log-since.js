#!/usr/bin/env node
// log-since.js - the warnings and errors AionDX and AionCore logged since a time, grouped by message so a repeated one counts once.
// The first step of a bug sweep or a post-install check (start from the backend log).
//   node tools\log-since.js 10:09            today's logs from 10:09 local time
//   node tools\log-since.js 10:09 --all      every level, not only WARN and ERROR
// Reads %APPDATA%\AionDX\logs\YYYY\MM\DD\YYYY-MM-DD.log (the app) and .aioncore.log (AionCore). Prints counts and the first line of each
// group, cut to 300 characters; message text from chats is not in these logs.
const fs = require('fs');
const path = require('path');
const [hhmm, flag] = process.argv.slice(2);
if (!/^\d{1,2}:\d{2}$/.test(hhmm || '')) { console.log('usage: node tools\\log-since.js HH:MM [--all]'); process.exit(2); }
const now = new Date();
const since = new Date(now.getFullYear(), now.getMonth(), now.getDate(), +hhmm.split(':')[0], +hhmm.split(':')[1]).getTime();
const pad = (n) => String(n).padStart(2, '0');
const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const dir = path.join(process.env.APPDATA, 'AionDX', 'logs', String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()));
for (const name of [day + '.log', day + '.aioncore.log']) {
  const f = path.join(dir, name);
  if (!fs.existsSync(f)) { console.log('== ' + name + ': none'); continue; }
  const groups = new Map();
  let lines = 0;
  for (const ln of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = /^\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\]?/.exec(ln);
    if (!m) continue;
    const t = Date.parse(m[1].replace(' ', 'T'));
    if (!(t >= since)) continue;
    lines++;
    if (flag !== '--all' && !/\b(WARN|ERROR|warn|error|panic)\b/.test(ln)) continue;
    const key = ln.slice(m[0].length).replace(/\b[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/g, '<id>').replace(/\b\d+(\.\d+)?(ms|s)?\b/g, '#').slice(0, 160);
    const g = groups.get(key) || { n: 0, first: ln };
    g.n++;
    groups.set(key, g);
  }
  console.log(`== ${name}: ${lines} lines since ${hhmm}, ${groups.size} distinct ${flag === '--all' ? 'messages' : 'warnings or errors'}`);
  for (const g of [...groups.values()].sort((a, b) => b.n - a.n)) console.log(`  x${g.n}  ${g.first.slice(0, 300)}`);
}
