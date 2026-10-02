#!/usr/bin/env node
/**
 * audit-hosts.js - every web host named in the app's main, preload and renderer bundles, with how often, so each one that belongs to
 * AionUi's own services or to a telemetry service can be looked at. Run on an extracted app.asar.
 *
 *   node tools\audit-hosts.js <extracted asar dir> [--all]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const dir = process.argv[2];
if (!dir) { console.error('usage: node audit-hosts.js <dir> [--all]'); process.exit(2); }
const all = process.argv.includes('--all');
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else if (/out[\/\\](renderer[\/\\]assets|main|preload)[\/\\].*\.js$/.test(p) && !/aionui-dx\.js$/.test(p)) files.push(p);
  }
})(dir);
const hosts = {};
const where = {};
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  const re = /https?:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})(?::\d+)?/gi;
  let m;
  while ((m = re.exec(s))) {
    const h = m[1].toLowerCase();
    hosts[h] = (hosts[h] || 0) + 1;
    (where[h] = where[h] || new Set()).add(path.basename(f));
  }
}
const interesting = /aion|sentry|firebase|analytics|segment|posthog|mixpanel|statsig|amplitude|hotjar|clarity|umami|plausible|umeng|baidu|tencent|aliyun|ingest|telemetry|datadog|bugsnag|logrocket/i;
Object.entries(hosts).filter(([h]) => all || interesting.test(h)).sort((a, b) => b[1] - a[1])
  .forEach(([h, n]) => console.log(String(n).padStart(5), h, ' [' + [...where[h]].slice(0, 2).join(',') + ']'));
console.log('distinct hosts: ' + Object.keys(hosts).length + (all ? '' : ' (only AionUi-owned and telemetry-looking ones shown; --all lists every one)'));
