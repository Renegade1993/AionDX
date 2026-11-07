#!/usr/bin/env node
/**
 * test-hidden-run.js - the real staged app started through live-app.js runs, answers on its debugging port, and has no window on the
 * user's own desktop (tools\hidden-run.cs puts it on one nobody sees).
 *   node tools\test-hidden-run.js
 */
'use strict';
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { launch, sleep } = require('./live-app');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 300) + ']')); };

(async () => {
  const profile = path.join(os.tmpdir(), 'aiondx-hidden-profile');
  let app = null;
  try {
    app = await launch({ port: 9581, profile, deadlineMs: 200000 });
    check('the app answers on its debugging port', (await app.js('document.readyState')) !== undefined);
    await sleep(3000);
    // Every process started with this profile, and whether any of them has a window on the desktop this test runs on.
    const script = "$p = [regex]::Escape('" + profile.replace(/'/g, "''") + "'); " +
      "$ids = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match $p } | ForEach-Object { $_.ProcessId }; " +
      "$vis = @($ids | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue } | Where-Object { $_.MainWindowHandle -ne 0 }); " +
      "Write-Output ('{0} {1}' -f @($ids).Count, $vis.Count)";
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    const [n, vis] = String(r.stdout).trim().split(/\s+/).map(Number);
    check('the app has processes running (' + n + ')', n >= 2, r.stdout + r.stderr);
    check('and none has a window on your desktop', vis === 0, r.stdout);
  } catch (e) {
    check('the test ran', false, e && e.stack);
  } finally {
    if (app) await app.close();
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
