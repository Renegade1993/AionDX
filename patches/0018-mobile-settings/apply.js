#!/usr/bin/env node
/**
 * AionDX patch 0018-mobile-settings, main process and preload: the one narrow way Settings > Mobile can change Windows Firewall.
 *
 *   node patches\0018-mobile-settings\apply.js <extracted-asar-root>
 *
 * out/main/index.js gets one IPC handler, "aiondx:mobile-firewall" (action "allow" | "remove", and for "allow" the port). The
 * main process builds the netsh plan itself (firewall-plan.js, inlined): a fixed netsh.exe, a fixed rule name, the Private
 * profile, and the app's own bundled aioncore.exe; nothing else comes from the page. It runs the plan through the app's own
 * resources\elevate.exe (a UAC prompt), then reads the rule back with the read-only `show rule` and answers { ok, error }.
 * out/preload/index.js exposes window.aiondxMobile = { allowFirewall(port), removeFirewall() }, which only call that handler: a
 * script in the page cannot choose the program, the arguments, or what gets elevated.
 *
 * Re-running replaces the marked main block and leaves the preload alone. Every anchor must be found or nothing is written.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const MARK_BEGIN = '/* AIONDX-0018 BEGIN';
const MARK_END = '/* AIONDX-0018 END */';
const PRELOAD_ANCHOR = 'const backendPort = electron.ipcRenderer.sendSync("get-backend-port");';
const PRELOAD_DONE = 'exposeInMainWorld("aiondxMobile"';
const CHANNEL = 'aiondx:mobile-firewall';

function inlinePlan() {
  const src = fs.readFileSync(path.join(__dirname, 'firewall-plan.js'), 'utf8');
  const m = /\/\/ AIONDX-0018-INLINE-BEGIN\r?\n([\s\S]*?)\/\/ AIONDX-0018-INLINE-END/.exec(src);
  if (!m) throw new Error('firewall-plan.js has no INLINE markers');
  return m[1];
}

function mainBlock() {
  return MARK_BEGIN + ': the bridge\'s Windows Firewall rule, from Settings > Mobile (patches/0018-mobile-settings). */\n' +
    '(function __aiondxMobileFirewallMain() {\n' +
    '  try {\n' +
    '    if (process.platform !== "win32") return;\n' +
    '    const electron = require("electron"), path = require("node:path"), fs = require("node:fs"), cp = require("node:child_process");\n' +
    inlinePlan() +
    '    const P = __aiondxMobileFirewallPlan();\n' +
    '    let busy = false;\n' +
    '    const run = (file, args) => new Promise((resolve) => {\n' +
    '      let out = "", child;\n' +
    '      try { child = cp.spawn(file, args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }); } catch (e) { resolve({ code: -1, out: "" }); return; }\n' +
    '      child.stdout.on("data", (d) => { out += d; });\n' +
    '      child.on("error", () => resolve({ code: -1, out }));\n' +
    '      child.on("close", (code) => resolve({ code, out }));\n' +
    '    });\n' +
    // Test builds (tools\\live-app.js sets AIONDX_E2E_TEST; QA's runs also set AIONUI_E2E_TEST) never elevate anything: a test
    // that cannot replace window.aiondxMobile (it comes from contextBridge in a built app) must not reach elevate.exe. The
    // second name is split so tools\\brand-names.js, which renames AIONUI to AIONDX in this bundle afterwards, leaves it as is.
    '    const __aiondxTestEnv = ["AIONDX_E2E_TEST", "AION" + "UI_E2E_TEST"];\n' +
    '    electron.ipcMain.handle(' + JSON.stringify(CHANNEL) + ', async (_event, action, port) => {\n' +
    '      if (__aiondxTestEnv.some((k) => process.env[k])) return { ok: false, error: "disabled in test mode" };\n' +
    '      if (busy) return { ok: false, error: "Windows is already being asked" };\n' +
    '      busy = true;\n' +
    '      try {\n' +
    '        const res = process.resourcesPath || "";\n' +
    '        const program = path.join(res, "bundled-aioncore", "win32-x64", "aioncore.exe");\n' +
    '        const plan = P.buildPlan(action, { port, program, systemRoot: process.env.SystemRoot });\n' +
    '        if (!plan.ok) return { ok: false, error: plan.error };\n' +
    '        if (action === "allow" && !fs.existsSync(program)) return { ok: false, error: "the bridge program was not found" };\n' +
    '        const elevate = path.join(res, "elevate.exe");\n' +
    '        if (!fs.existsSync(elevate)) return { ok: false, error: "this build cannot ask Windows for permission (no elevate.exe)" };\n' +
    '        await run(elevate, ["-wait", plan.program].concat(plan.args));\n' +
    '        const show = P.showPlan(process.env.SystemRoot);\n' +
    '        const st = P.parseShowRule((await run(show.program, show.args)).out);\n' +
    '        if (action === "allow") return st.present && st.enabled && st.privateOnly && st.port === port ? { ok: true } : { ok: false, error: "Windows did not add the rule (the permission prompt may have been cancelled)" };\n' +
    '        return st.present ? { ok: false, error: "Windows did not remove the rule (the permission prompt may have been cancelled)" } : { ok: true };\n' +
    '      } catch (e) { return { ok: false, error: "the firewall change failed" }; }\n' +
    '      finally { busy = false; }\n' +
    '    });\n' +
    '  } catch {}\n' +
    '})();\n' +
    MARK_END + '\n';
}

function patchMain(src) {
  const begin = src.indexOf(MARK_BEGIN);
  if (begin !== -1) {
    const end = src.indexOf(MARK_END, begin);
    if (end === -1) throw new Error('found AIONDX-0018 BEGIN without END in out/main/index.js');
    return { src: src.slice(0, begin) + mainBlock() + src.slice(end + MARK_END.length).replace(/^\r?\n/, ''), note: 'main: firewall handler replaced' };
  }
  if (src.indexOf('ipcMain') === -1) throw new Error('out/main/index.js does not look like the main bundle (no ipcMain)');
  return { src: src.replace(/\s*$/, '\n') + mainBlock(), note: 'main: firewall handler added' };
}

function patchPreload(src) {
  if (src.indexOf(PRELOAD_DONE) !== -1) return { src, note: 'preload: aiondxMobile already exposed' };
  const n = src.split(PRELOAD_ANCHOR).length - 1;
  if (n !== 1) throw new Error('expected exactly one preload anchor, found ' + n);
  const block = '/* AIONDX-0018: Settings > Mobile\'s firewall switch (patches/0018-mobile-settings, main process ' + CHANNEL + '). */\n' +
    'electron.contextBridge.exposeInMainWorld("aiondxMobile", {\n' +
    '  allowFirewall: (port) => electron.ipcRenderer.invoke(' + JSON.stringify(CHANNEL) + ', "allow", port),\n' +
    '  removeFirewall: () => electron.ipcRenderer.invoke(' + JSON.stringify(CHANNEL) + ', "remove")\n' +
    '});\n';
  return { src: src.replace(PRELOAD_ANCHOR, block + PRELOAD_ANCHOR), note: 'preload: aiondxMobile exposed' };
}

function main(argv) {
  const root = argv[0];
  if (!root) { console.error('usage: node apply.js <extracted-asar-root>'); return 2; }
  const mainJs = path.join(root, 'out', 'main', 'index.js');
  const preloadJs = path.join(root, 'out', 'preload', 'index.js');
  try {
    const m = patchMain(fs.readFileSync(mainJs, 'utf8'));
    const p = patchPreload(fs.readFileSync(preloadJs, 'utf8'));
    fs.writeFileSync(mainJs, m.src);   // only after both succeeded
    fs.writeFileSync(preloadJs, p.src);
    console.log('0018: ' + m.note + '; ' + p.note);
    return 0;
  } catch (e) {
    console.error('0018: NOT APPLIED, nothing written: ' + e.message);
    return 1;
  }
}

module.exports = { patchMain, patchPreload, mainBlock, CHANNEL, MARK_BEGIN, MARK_END, PRELOAD_ANCHOR };
if (require.main === module) process.exit(main(process.argv.slice(2)));
