#!/usr/bin/env node
/**
 * apply.js - patch 0009's build step: the AionDX mark in place of AionUi's, everywhere the app
 * draws it. Run by tools\do_patch.ps1 on the extracted asar:
 *
 *   node patches\0009-identity\apply.js <extracted asar dir>
 *
 * What it changes:
 *   out/renderer/assets/app-*.png          the in-app logo (exactly one file, replaced in place)
 *   out/renderer/pwa/icon-{180,192,512}.png and public/pwa/...   WebUI favicon and install icons
 *   out/aiondx/app.png                     new: the 256 px mark the main process loads
 *   out/renderer/aiondx-mark.svg           new: the mark, for the sidebar's top left
 *   out/renderer/assets/index-*.js         the sidebar's top-left logo (an inline SVG drawn on a black
 *                                          tile, Layout.tsx) becomes the mark, and the name beside it
 *                                          "AionDX" (a request of 2026-09-25)
 *   out/main/index.js                      the window icon (production had none, so Windows showed
 *                                          AionUi.exe's), the tray icon and the notification icon; and at
 *                                          start, AionDX's bin folder first on PATH and the installer's
 *                                          per-user half run again (2026-09-26)
 *   out/renderer/index.html                aiondx-themes.js, and AionUi's Opening guide marked seen (the
 *                                          Welcome screen replaces it)
 *   out/main/index.js, out/preload/index.js  the one-click setup: the main process runs the setup skill's
 *                                          survey.js and apply.js as Node for the Welcome screen, which reaches
 *                                          it as window.aiondxSetup (2026-09-26)
 *
 * Same rule as 0003 and 0006: every anchor must match its expected count on an unpatched tree
 * (or show its done-marker on a patched one), or nothing is written.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ext = process.argv[2];
if (!ext || !fs.existsSync(path.join(ext, 'out', 'main', 'index.js'))) {
  console.error('usage: node apply.js <extracted asar dir>');
  process.exit(2);
}
const PNG = (size) => path.join(__dirname, 'icon', 'png', `aiondx-${size}.png`);
for (const s of [180, 192, 256, 512, 1024]) {
  if (!fs.existsSync(PNG(s))) { console.error(`0009: missing ${PNG(s)}; run render-icons.js first`); process.exit(2); }
}

const HELPER_BEGIN = '/* AIONDX-0009 BEGIN';
const HELPER_END = '/* AIONDX-0009 END */';
const HELPER = `${HELPER_BEGIN}: the AionDX mark (patches/0009-identity). Loaded from the asar by buffer. */
function __aiondxIcon(name) {
  try {
    const img = require$$0$2.nativeImage.createFromBuffer(fs__namespace.readFileSync(path__namespace.join(__dirname, "..", "aiondx", name)));
    return img.isEmpty() ? void 0 : img;
  } catch {
    return void 0;
  }
}
/** Notifications take a file path: copy the mark out of the asar into userData once. */
function __aiondxIconFile(name) {
  try {
    const src = fs__namespace.readFileSync(path__namespace.join(__dirname, "..", "aiondx", name));
    const dst = path__namespace.join(require$$0$2.app.getPath("userData"), "aiondx-" + name);
    if (!fs__namespace.existsSync(dst) || fs__namespace.statSync(dst).size !== src.length) fs__namespace.writeFileSync(dst, src);
    return dst;
  } catch {
    return void 0;
  }
}
/** At start, before anything else runs:
 *  - AionDX's own programs first on PATH for everything AionUi starts (AionCore, and through it every
 *    agent), so an agent finds "aiondx", and AionCore's Antigravity turns reach the sign-in wrapper
 *    before Google's own agy, whatever order the user's PATH has.
 *  - In the standalone AionDX (the app carries resources\aiondx), AionUi's updater is off: it would
 *    fetch stock AionUi, which is not this app (AIONUI_DISABLE_AUTO_UPDATE, AionUi's own switch), and
 *    the app's per-user setup, resources\aiondx\bin\aiondx.exe activate, runs again, so a second
 *    Windows account, or skills an AionCore update rebuilt, come back by themselves. It is killed after
 *    90 s; AIONDX_NO_ACTIVATE=1 skips it (tests). */
(function __aiondxStart() {
  try {
    const bin = process.env.LOCALAPPDATA ? path__namespace.join(process.env.LOCALAPPDATA, "AionDX", "bin") : "";
    if (bin && fs__namespace.existsSync(bin)) {
      const same = (p) => { try { return path__namespace.resolve(p).toLowerCase() === path__namespace.resolve(bin).toLowerCase(); } catch { return false; } };
      process.env.PATH = [bin].concat(String(process.env.PATH || "").split(";").filter((p) => p && !same(p))).join(";");
    }
  } catch {}
  // Node.js for a PC without it (2026-09-26, a tester's install: AionUi's browser tool runs npx). The standalone
  // AionDX carries Node's own build where AionCore takes a bundled copy (managed-resources\\node\\node-v*-win-x64);
  // when no node.exe is on PATH, that folder goes on the end of it, so npx-based MCP servers and the Claude launcher
  // work. A PC with its own Node keeps using it.
  try {
    const dirs = String(process.env.PATH || "").split(";").filter(Boolean);
    const hasNode = dirs.some((d) => { try { return fs__namespace.existsSync(path__namespace.join(d, "node.exe")); } catch { return false; } });
    const base = process.resourcesPath ? path__namespace.join(process.resourcesPath, "bundled-aioncore", "win32-x64", "managed-resources", "node") : "";
    if (!hasNode && base && fs__namespace.existsSync(base)) {
      const found = fs__namespace.readdirSync(base).filter((n) => /^node-v[0-9.]+-win-x64$/.test(n) && fs__namespace.existsSync(path__namespace.join(base, n, "node.exe"))).sort().pop();
      if (found) process.env.PATH = String(process.env.PATH || "").replace(/;+$/, "") + ";" + path__namespace.join(base, found);
    }
  } catch {}
  try {
    const own = process.resourcesPath ? path__namespace.join(process.resourcesPath, "aiondx") : "";
    if (!own || !fs__namespace.existsSync(path__namespace.join(own, "release.json"))) return;
    process.env.AIONUI_DISABLE_AUTO_UPDATE = "1";
    const act = path__namespace.join(own, "bin", "aiondx.exe");
    if (process.env.AIONDX_NO_ACTIVATE === "1" || !fs__namespace.existsSync(act)) return;
    // A second start of the app quits (it hands over to the first), but this module still runs to here.
    if (typeof require$$0$2.app.hasSingleInstanceLock === "function" && !require$$0$2.app.hasSingleInstanceLock()) return;
    const child = require("child_process").spawn(act, ["activate", "--quiet", "--from", "aionui-start"], { windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 90000);
    if (timer.unref) timer.unref();
    // Every agent's model picker current (a request of 2026-10-11): once the per-user setup has put the programs in place, and again every
    // twelve hours while AionDX runs, aiondx-model-refresh.js asks each agent's CLI what it offers and rewrites the stored pickers. It runs
    // on the Node.js AionDX ships (it reads AionCore's database with node:sqlite), hidden, and ends itself within four minutes.
    // AIONDX_NO_REFRESH=1 skips it (tests).
    const refresh = () => {
      try {
        if (process.env.AIONDX_NO_REFRESH === "1") return;
        // AionDX's own bin folder, or %APPDATA%\\npm where a developer's layout keeps the Claude launcher and its scripts.
        const ownBin = process.env.LOCALAPPDATA ? path__namespace.join(process.env.LOCALAPPDATA, "AionDX", "bin") : "";
        const npmDir = process.env.APPDATA ? path__namespace.join(process.env.APPDATA, "npm") : "";
        const script = [ownBin, npmDir].map((d) => d ? path__namespace.join(d, "aiondx-model-refresh.js") : "").find((f) => f && fs__namespace.existsSync(f));
        if (!script) return;
        const base = path__namespace.join(process.resourcesPath, "bundled-aioncore", "win32-x64", "managed-resources", "node");
        const found = fs__namespace.existsSync(base) ? fs__namespace.readdirSync(base).filter((n) => /^node-v[0-9.]+-win-x64$/.test(n) && fs__namespace.existsSync(path__namespace.join(base, n, "node.exe"))).sort().pop() : null;
        const node = found ? path__namespace.join(base, found, "node.exe") : "node";
        const r = require("child_process").spawn(node, [script], { windowsHide: true, stdio: "ignore", detached: true });
        r.on("error", () => {});
        r.unref();
      } catch {}
    };
    const every = setInterval(refresh, 12 * 3600000);
    if (every.unref) every.unref();
    child.on("error", () => { clearTimeout(timer); refresh(); });
    child.on("exit", () => { clearTimeout(timer); refresh(); });
  } catch {}
})();
/** Right-click: Cut, Copy, Paste and Select all in a text box, and Copy on selected text. AionUi shows no menu
 *  there (a request of 2026-09-26). Electron
 *  asks for this menu only when the page did not handle the right-click itself, so AionUi's own right-click
 *  menus (the file tree, say) are untouched. */
(function __aiondxContextMenu() {
  try {
    const electron = require$$0$2;
    electron.app.on("web-contents-created", (_event, wc) => {
      wc.on("context-menu", (_e, params) => {
        try {
          const f = params.editFlags || {};
          let items = null;
          if (params.isEditable) {
            items = [
              { role: "cut", label: "Cut", enabled: !!f.canCut },
              { role: "copy", label: "Copy", enabled: !!f.canCopy },
              { role: "paste", label: "Paste", enabled: !!f.canPaste },
              { type: "separator" },
              { role: "selectAll", label: "Select all", enabled: !!f.canSelectAll }
            ];
          } else if (params.selectionText && params.selectionText.trim()) {
            items = [{ role: "copy", label: "Copy" }];
          }
          if (!items) return;
          const win = electron.BrowserWindow.fromWebContents(wc);
          electron.Menu.buildFromTemplate(items).popup(win ? { window: win } : {});
        } catch {}
      });
    });
  } catch {}
})();
/** The one-click setup (a request of 2026-09-26). The Welcome screen
 *  asks for it through the preload's aiondxSetup. The setup skill's survey.js and apply.js run in a child of this
 *  process as Node (Electron's own runtime, ELECTRON_RUN_AS_NODE), so no Node.js install and no agent are needed.
 *  An import may use only the survey this process made last, and apply.js checks every item of the plan against
 *  it. AIONDX_SETUP_TEST_HOME points both at a made-up home folder (the smoke test). Each run is killed at 150 s. */
(function __aiondxSetup() {
  try {
    const electron = require$$0$2;
    const cp = require("child_process");
    let lastSurvey = null;
    const skillDir = () => {
      const dirs = [];
      if (process.resourcesPath) dirs.push(path__namespace.join(process.resourcesPath, "aiondx", "skills", "aiondx-setup"));
      try { dirs.push(path__namespace.join(electron.app.getPath("userData"), "aionui", "builtin-skills", "auto-inject", "aiondx-setup")); } catch {}
      return dirs.find((d) => fs__namespace.existsSync(path__namespace.join(d, "scripts", "apply.js"))) || null;
    };
    const runScript = (script, argv) => new Promise((resolve) => {
      let child;
      try {
        child = cp.fork(script, argv, { silent: true, windowsHide: true, env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: "1" }) });
      } catch (e) { resolve({ code: -1, out: "", err: String(e && e.message || e) }); return; }
      let out = "", err = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      const timer = setTimeout(() => { try { child.kill(); } catch {} }, 150000);
      child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out, err: err + String(e && e.message || e) }); });
      child.on("exit", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    });
    electron.ipcMain.handle("aiondx:setup", async (_event, req) => {
      try {
        const op = req && req.op;
        const dir = skillDir();
        if (!dir) return { ok: false, error: "AionDX's setup files (the aiondx-setup skill) are not installed." };
        const home = process.env.AIONDX_SETUP_TEST_HOME || "";
        const homeArgs = home ? ["--home", home] : [];
        const work = path__namespace.join(electron.app.getPath("temp"), "aiondx-setup");
        fs__namespace.mkdirSync(work, { recursive: true });
        if (op === "scan") {
          const file = path__namespace.join(work, "survey-" + Date.now() + ".json");
          const r = await runScript(path__namespace.join(dir, "scripts", "survey.js"), ["--json", "--out", file].concat(homeArgs));
          if (r.code !== 0 || !fs__namespace.existsSync(file)) return { ok: false, error: String(r.err || r.out || "exit " + r.code).slice(-2000) };
          lastSurvey = file;
          return { ok: true, survey: JSON.parse(fs__namespace.readFileSync(file, "utf8")) };
        }
        if (op === "apply") {
          if (!lastSurvey || !fs__namespace.existsSync(lastSurvey)) return { ok: false, error: "Look for your setup first." };
          const planFile = path__namespace.join(work, "plan-" + Date.now() + ".json");
          fs__namespace.writeFileSync(planFile, JSON.stringify((req && req.plan) || {}));
          const r = await runScript(path__namespace.join(dir, "scripts", "apply.js"), ["--survey", lastSurvey, "--plan", planFile].concat(homeArgs));
          try { fs__namespace.unlinkSync(planFile); } catch {}
          let result = null;
          try { result = JSON.parse(r.out); } catch {}
          if (!result) return { ok: false, error: String(r.err || r.out || "exit " + r.code).slice(-2000) };
          return result.ok ? { ok: true, result } : { ok: false, error: result.error || "The import did not finish." };
        }
        return { ok: false, error: "unknown request" };
      } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    });
  } catch {}
})();
/** Claude Code plugins (A tester, through a request of 2026-09-26). AionUi's Claude
 *  chats do not offer Claude Code's /plugin browser. The page's /plugin panel asks for "claude plugin ..." through the
 *  preload's aiondxPlugins, and this runs it: the claude found on PATH (AionDX's bin comes first), hidden, killed at
 *  180 s, only the plugin and marketplace subcommands and options below. A marketplace's own install command runs only
 *  with --accept-command and the hash the user was shown. */
(function __aiondxPlugins() {
  try {
    const electron = require$$0$2;
    const cp = require("child_process");
    const SUB = { list: 1, install: 1, uninstall: 1, enable: 1, disable: 1, update: 1, details: 1, marketplace: 1 };
    const MARKET = { add: 1, list: 1, remove: 1, update: 1 };
    const FLAGS = { "--json": 0, "--available": 0, "--scope": 1, "--config": 1, "--accept-command": 1, "--keep-data": 0, "--all": 0 };
    const findClaude = () => {
      const dirs = String(process.env.PATH || process.env.Path || "").split(path__namespace.delimiter).filter(Boolean);
      for (const name of ["claude.exe", "claude.cmd"]) {
        for (const d of dirs) {
          const f = path__namespace.join(d.replace(/^"|"$/g, ""), name);
          try { if (fs__namespace.statSync(f).isFile()) return f; } catch {}
        }
      }
      return null;
    };
    const problem = (args) => {
      if (!Array.isArray(args) || args.length < 1 || args.length > 12) return "bad arguments";
      if (args.some((a) => typeof a !== "string" || !a || a.length > 400 || /[\\x00-\\x1f"]/.test(a))) return "bad arguments";
      if (!SUB[args[0]]) return "not a plugin command: " + args[0];
      let i = 1;
      if (args[0] === "marketplace") { if (!MARKET[args[1]]) return "not a marketplace command: " + (args[1] || ""); i = 2; }
      for (; i < args.length; i++) {
        if (args[i][0] !== "-") continue;
        if (!(args[i] in FLAGS)) return "option not allowed here: " + args[i];
        if (FLAGS[args[i]]) i++;
      }
      return null;
    };
    electron.ipcMain.handle("aiondx:plugins", async (_event, req) => {
      try {
        const args = req && req.args;
        const bad = problem(args);
        if (bad) return { ok: false, error: bad };
        const exe = findClaude();
        if (!exe) return { ok: false, error: "Claude Code (claude) is not installed, or not on PATH." };
        let file = exe;
        let argv = ["plugin"].concat(args);
        const viaCmd = /\\.cmd$/i.test(exe);
        if (viaCmd) {
          if (argv.some((a) => /[&|<>^%!()]/.test(a))) return { ok: false, error: "That has a character cmd.exe cannot pass on safely." };
          file = process.env.ComSpec || "cmd.exe";
          argv = ["/d", "/s", "/c", "\\"" + ["\\"" + exe + "\\""].concat(argv.map((a) => (/\\s/.test(a) ? "\\"" + a + "\\"" : a))).join(" ") + "\\""];
        }
        const env = Object.assign({}, process.env);
        delete env.ELECTRON_RUN_AS_NODE;
        return await new Promise((resolve) => {
          let child;
          try { child = cp.spawn(file, argv, { windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"], windowsVerbatimArguments: viaCmd }); }
          catch (e) { resolve({ ok: false, error: String(e && e.message || e) }); return; }
          let out = "", err = "";
          child.stdout.on("data", (d) => { if (out.length < 4000000) out += d; });
          child.stderr.on("data", (d) => { if (err.length < 200000) err += d; });
          const timer = setTimeout(() => { try { child.kill(); } catch {} }, 180000);
          child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: String(e && e.message || e) }); });
          child.on("exit", (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, out, err }); });
        });
      } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    });
  } catch {}
})();
/** Signing an agent in from a button (a request of 2026-10-11: "the only way to setup agents in AionDX is to have a agent ... set them up").
 *  The agent's own CLI does the sign-in, so its credentials end up where that CLI keeps them and AionDX never holds a key: for Claude Code,
 *  claude auth login, which opens the sign-in page in the browser and, when the page shows a code instead of finishing, takes the code on
 *  its input. The page's sign-in panel starts it here (hidden), shows the link, passes a pasted code on, and asks claude auth status when it
 *  ends. One sign-in at a time; it is killed after ten minutes. An optional config folder (a second Claude account) must be a .claude*
 *  folder in the user's profile. */
(function __aiondxSignin() {
  try {
    const electron = require$$0$2;
    const cp = require("child_process");
    const os = require("os");
    let run = null;   // { child, out, code, started }
    const findClaude = () => {
      const dirs = String(process.env.PATH || process.env.Path || "").split(path__namespace.delimiter).filter(Boolean);
      for (const d of dirs) {
        const f = path__namespace.join(d.replace(/^"|"$/g, ""), "claude.exe");
        try { if (fs__namespace.statSync(f).isFile()) return f; } catch {}
      }
      const native = path__namespace.join(os.homedir(), ".local", "bin", "claude.exe");
      return fs__namespace.existsSync(native) ? native : null;
    };
    const envFor = (configDir) => {
      const env = Object.assign({}, process.env);
      for (const k of ["ELECTRON_RUN_AS_NODE", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "AIONUI_CONVERSATION_ID"]) delete env[k];
      if (configDir) { env.CLAUDE_CONFIG_DIR = configDir; env.CLAUDE_SECURESTORAGE_CONFIG_DIR = configDir; }
      return env;
    };
    const plain = (s) => String(s || "").replace(/\\x1b\\[[0-9;?]*[A-Za-z]/g, "");
    const linkIn = (s) => { const i = s.indexOf("https://"); if (i < 0) return null; return s.slice(i).split(/\\s/)[0]; };
    // The Claude launcher's config (the account router's accounts), where a newly signed-in account is added so every chat's account
    // menu offers it: beside the router AionDX installed, or beside the developer's copy in %APPDATA%\\npm.
    const routerDir = () => {
      if (process.env.AIONDX_ROUTER_DIR) return process.env.AIONDX_ROUTER_DIR;   // tests
      const dirs = [process.env.LOCALAPPDATA ? path__namespace.join(process.env.LOCALAPPDATA, "AionDX", "bin") : "", process.env.APPDATA ? path__namespace.join(process.env.APPDATA, "npm") : ""];
      return dirs.find((d) => d && fs__namespace.existsSync(path__namespace.join(d, "claude-account-router.js"))) || null;
    };
    electron.ipcMain.handle("aiondx:signin", async (_event, req) => {
      try {
        const op = req && req.op;
        if (req && req.agent && req.agent !== "claude") return { ok: false, error: "Only Claude Code signs in from here so far." };
        // An extra account signs in to its own folder, %USERPROFILE%\\.claude-<name>; none means this PC's usual Claude sign-in.
        const account = req && req.account ? String(req.account) : "";
        if (account && !/^[a-z0-9][a-z0-9-]{0,23}$/.test(account)) return { ok: false, error: "An account name is a short word: letters, digits and dashes." };
        const configDir = account ? path__namespace.join(os.homedir(), ".claude-" + account) : "";
        if (op === "register") {
          if (!account) return { ok: false, error: "Which account?" };
          const dir = routerDir();
          if (!dir) return { ok: false, error: "AionDX's Claude launcher is not installed, so there is no account list to add it to." };
          const file = path__namespace.join(dir, "claude-account-router.config.json");
          let cfg = {};
          try { cfg = JSON.parse(fs__namespace.readFileSync(file, "utf8")) || {}; } catch (e) { if (fs__namespace.existsSync(file)) return { ok: false, error: "The launcher's config is not readable JSON; it was left alone." }; }
          if (!cfg.accounts || typeof cfg.accounts !== "object") cfg.accounts = {};
          const label = String(req.label || account).slice(0, 60);
          cfg.accounts[account] = Object.assign({}, cfg.accounts[account] || {}, { label, configDir });
          if (fs__namespace.existsSync(file)) fs__namespace.copyFileSync(file, file + ".bak-signin");
          fs__namespace.writeFileSync(file + ".tmp", JSON.stringify(cfg, null, 2));
          fs__namespace.renameSync(file + ".tmp", file);
          return { ok: true, id: account, label, configDir };
        }
        if (op === "status") {
          const exe = findClaude();
          if (!exe) return { ok: true, installed: false };
          return await new Promise((resolve) => {
            cp.execFile(exe, ["auth", "status", "--json"], { env: envFor(configDir), windowsHide: true, timeout: 30000 }, (err, stdout) => {
              let j = null;
              try { j = JSON.parse(stdout); } catch {}
              resolve(j ? { ok: true, installed: true, loggedIn: !!j.loggedIn, method: j.authMethod || "", email: j.email || "", org: j.orgName || "", plan: j.subscriptionType || "" }
                        : { ok: false, installed: true, error: String(err && err.message || "no answer") });
            });
          });
        }
        if (op === "start") {
          if (run && run.code === null) return { ok: false, error: "A sign-in is already going; finish it or cancel it first." };
          const exe = findClaude();
          if (!exe) return { ok: false, error: "Claude Code is not installed on this PC." };
          if (configDir) fs__namespace.mkdirSync(configDir, { recursive: true });
          const child = cp.spawn(exe, ["auth", "login", "--claudeai"], { env: envFor(configDir), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
          const r = { child, out: "", code: null, started: Date.now() };
          run = r;
          child.stdout.on("data", (d) => { if (r.out.length < 20000) r.out += d; });
          child.stderr.on("data", (d) => { if (r.out.length < 20000) r.out += d; });
          child.on("error", (e) => { r.out += String(e && e.message || e); r.code = -1; });
          child.on("exit", (code) => { r.code = code === null ? -1 : code; clearTimeout(r.timer); });
          r.timer = setTimeout(() => { try { child.kill(); } catch {} }, 600000);
          for (let i = 0; i < 60 && r.code === null && !linkIn(plain(r.out)); i++) await new Promise((res) => setTimeout(res, 250));
          const url = linkIn(plain(r.out));
          if (!url) return { ok: r.code === null, url: null, text: plain(r.out).slice(-400) };
          return { ok: true, url };
        }
        if (op === "code") {
          if (!run || run.code !== null) return { ok: false, error: "No sign-in is waiting for a code." };
          const code = String(req.code || "").trim();
          if (!code || code.length > 2000 || /[\\r\\n]/.test(code)) return { ok: false, error: "That does not look like a sign-in code." };
          run.child.stdin.write(code + "\\n");
          return { ok: true };
        }
        if (op === "poll") {
          if (!run) return { ok: true, state: "none" };
          return { ok: true, state: run.code === null ? "running" : run.code === 0 ? "done" : "failed", text: plain(run.out).slice(-400) };
        }
        if (op === "cancel") {
          if (run && run.code === null) { try { run.child.kill(); } catch {} }
          return { ok: true };
        }
        return { ok: false, error: "unknown request" };
      } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    });
  } catch {}
})();
${HELPER_END}
`;

// [what, find, replace, expected count on an unpatched tree, marker proving it is done]
const EDITS = [
  // The standalone AionDX is its own app to Windows (taskbar grouping, pins, notifications), so it does not
  // share AionUi's id on a PC that has both; over an installed AionUi (the developer's layout) the id stays AionUi's.
  ['app id', 'const WINDOWS_APP_USER_MODEL_ID = "com.aionui.app";',
    'const WINDOWS_APP_USER_MODEL_ID = (() => { try { return fs__namespace.existsSync(path__namespace.join(process.resourcesPath || "", "aiondx", "release.json")) ? "com.aiondx.app" : "com.aionui.app"; } catch { return "com.aionui.app"; } })();',
    1, /com\.aiondx\.app/],
  ['helper block', 'const createWindow = ({ showOnReady = true } = {}) => {',
    HELPER + 'const createWindow = ({ showOnReady = true } = {}) => {', 1, /AIONDX-0009 BEGIN/],
  ['window icon', '  mainWindow = new require$$0$2.BrowserWindow({\n    width: windowWidth,',
    '  if (!devIcon && process.platform !== "darwin") devIcon = __aiondxIcon("app.png");\n  mainWindow = new require$$0$2.BrowserWindow({\n    width: windowWidth,', 1,
    /devIcon = __aiondxIcon\("app\.png"\)/],
  ['tray icon', 'const icon = electronNativeImage.createFromPath(path__namespace.join(resourcesPath, "app.png"));',
    'const icon = __aiondxIcon("app.png") || electronNativeImage.createFromPath(path__namespace.join(resourcesPath, "app.png"));', 1,
    /__aiondxIcon\("app\.png"\) \|\| electronNativeImage/],
  ['notification icon', 'const iconPath = path.join(resourcesPath, "app.png");',
    'const iconPath = __aiondxIconFile("app.png") || path.join(resourcesPath, "app.png");', 1,
    /__aiondxIconFile\("app\.png"\) \|\|/],
];

function count(hay, needle) { let n = 0, i = 0; while ((i = hay.indexOf(needle, i)) >= 0) { n++; i += needle.length; } return n; }

const mainFile = path.join(ext, 'out', 'main', 'index.js');
let main = fs.readFileSync(mainFile, 'utf8');
const notes = [];
// A patched tree: refresh the helper block itself, then treat each edit by its done-marker.
const hb = main.indexOf(HELPER_BEGIN);
if (hb >= 0) {
  const he = main.indexOf(HELPER_END, hb);
  if (he < 0) { console.error('0009: found AIONDX-0009 BEGIN without END'); process.exit(1); }
  main = main.slice(0, hb) + HELPER.slice(0, -1) + main.slice(he + HELPER_END.length);
  notes.push('helper block: replaced with this version');
}
for (const [what, find, repl, expected, done] of EDITS) {
  if (done.test(main)) { if (what !== 'helper block') notes.push(what + ': already done'); continue; }
  const n = count(main, find);
  if (n !== expected) { console.error(`0009: ${what}: expected ${expected} match(es), found ${n}. Nothing written.`); process.exit(1); }
  main = main.split(find).join(repl);
  notes.push(what + ': ' + n);
}

// The sidebar's top-left logo and name, in the renderer bundle that draws the layout.
const LOGO_RE = /(\w+)\.createElement\("svg",\{className:(\w+)\("w-5\.5 h-5\.5 absolute inset-0 m-auto",\{"scale-140":!(\w+)\}\),viewBox:"0 0 80 80",fill:"none"\},\1\.createElement\("path",\{key:"logo-path-1",[^}]*\}\),\1\.createElement\("circle",\{key:"logo-circle",[^}]*\}\),\1\.createElement\("path",\{key:"logo-path-2",[^}]*\}\)\)/g;
const LOGO_TO = '$1.createElement("img",{src:"./aiondx-mark.svg",alt:"AionDX",draggable:!1,className:"absolute inset-0 w-full h-full select-none"})';
const TILE_FROM = '"bg-black shrink-0 size-32px relative rd-0.5rem"';
const TILE_TO = '"shrink-0 size-32px relative rd-0.5rem overflow-hidden"';
const NAME_A = /("text-16px text-t-primary collapsed-hidden font-semibold"\},)"AionUi"\)/g;
const NAME_B = /(&&\(\w+\.preventDefault\(\),\w+\(\)\)\}\},)"AionUi"\)/g;
const layoutFiles = fs.readdirSync(path.join(ext, 'out', 'renderer', 'assets')).filter((f) => /\.js$/.test(f))
  .map((f) => path.join(ext, 'out', 'renderer', 'assets', f))
  .filter((f) => { const t = fs.readFileSync(f, 'utf8'); return t.includes('logo-path-1') || t.includes('aiondx-mark.svg'); });
if (layoutFiles.length !== 1) { console.error(`0009: expected one renderer file with the sidebar logo, found ${layoutFiles.length}. Nothing written.`); process.exit(1); }
let layout = fs.readFileSync(layoutFiles[0], 'utf8');
const layoutEdits = [
  ['sidebar logo', LOGO_RE, LOGO_TO, /aiondx-mark\.svg/],
  ['sidebar logo tile', TILE_FROM, TILE_TO, /"shrink-0 size-32px relative rd-0\.5rem overflow-hidden"/],
  ['sidebar name', NAME_A, '$1"AionDX")', /"text-16px text-t-primary collapsed-hidden font-semibold"\},"AionDX"\)/],
  ['sidebar name (settings)', NAME_B, '$1"AionDX")', /&&\(\w+\.preventDefault\(\),\w+\(\)\)\}\},"AionDX"\)/],
];
for (const [what, find, repl, done] of layoutEdits) {
  if (done.test(layout)) { notes.push(what + ': already done'); continue; }
  const n = typeof find === 'string' ? count(layout, find) : (layout.match(find) || []).length;
  if (n !== 1) { console.error(`0009: ${what}: expected 1 match, found ${n}. Nothing written.`); process.exit(1); }
  layout = typeof find === 'string' ? layout.split(find).join(repl) : layout.replace(find, repl);
  notes.push(what + ': 1 (' + path.basename(layoutFiles[0]) + ')');
}

// Renderer and PWA images.
const assets = path.join(ext, 'out', 'renderer', 'assets');
const logos = fs.readdirSync(assets).filter((f) => /^app-[A-Za-z0-9_-]+\.png$/.test(f));
if (logos.length !== 1) { console.error(`0009: expected one app-*.png logo in renderer assets, found ${logos.length}. Nothing written.`); process.exit(1); }

// The preload hands the page the one-click setup (the main process's aiondx:setup, in the helper block above).
const preloadFile = path.join(ext, 'out', 'preload', 'index.js');
let preload = fs.readFileSync(preloadFile, 'utf8');
if (/aiondxSetup/.test(preload)) notes.push('preload: aiondxSetup already there');
else {
  const anchor = 'const backendPort = electron.ipcRenderer.sendSync("get-backend-port");';
  const n = count(preload, anchor);
  if (n !== 1) { console.error(`0009: preload: expected 1 match, found ${n}. Nothing written.`); process.exit(1); }
  preload = preload.replace(anchor, '/* AIONDX-0009: the one-click setup (patches/0009-identity, main process aiondx:setup) */\n' +
    'electron.contextBridge.exposeInMainWorld("aiondxSetup", {\n' +
    '  scan: () => electron.ipcRenderer.invoke("aiondx:setup", { op: "scan" }),\n' +
    '  apply: (plan) => electron.ipcRenderer.invoke("aiondx:setup", { op: "apply", plan })\n' +
    '});\n' + anchor);
  notes.push('preload: aiondxSetup');
}
// ... and Claude Code's plugin commands (main process aiondx:plugins).
if (/aiondxPlugins/.test(preload)) notes.push('preload: aiondxPlugins already there');
else {
  const anchor = 'const backendPort = electron.ipcRenderer.sendSync("get-backend-port");';
  const n = count(preload, anchor);
  if (n !== 1) { console.error(`0009: preload (plugins): expected 1 match, found ${n}. Nothing written.`); process.exit(1); }
  preload = preload.replace(anchor, '/* AIONDX-0009: Claude Code plugins (patches/0009-identity, main process aiondx:plugins) */\n' +
    'electron.contextBridge.exposeInMainWorld("aiondxPlugins", {\n' +
    '  run: (args) => electron.ipcRenderer.invoke("aiondx:plugins", { args })\n' +
    '});\n' + anchor);
  notes.push('preload: aiondxPlugins');
}

// ... and an agent's sign-in from a button (main process aiondx:signin).
if (/aiondxSignin/.test(preload)) notes.push('preload: aiondxSignin already there');
else {
  const anchor = 'const backendPort = electron.ipcRenderer.sendSync("get-backend-port");';
  const n = count(preload, anchor);
  if (n !== 1) { console.error(`0009: preload (signin): expected 1 match, found ${n}. Nothing written.`); process.exit(1); }
  preload = preload.replace(anchor, '/* AIONDX-0009: an agent\'s sign-in from a button (patches/0009-identity, main process aiondx:signin) */\n' +
    'electron.contextBridge.exposeInMainWorld("aiondxSignin", {\n' +
    '  status: (agent, account) => electron.ipcRenderer.invoke("aiondx:signin", { op: "status", agent, account }),\n' +
    '  start: (agent, account) => electron.ipcRenderer.invoke("aiondx:signin", { op: "start", agent, account }),\n' +
    '  register: (account, label) => electron.ipcRenderer.invoke("aiondx:signin", { op: "register", agent: "claude", account, label }),\n' +
    '  code: (code) => electron.ipcRenderer.invoke("aiondx:signin", { op: "code", code }),\n' +
    '  poll: () => electron.ipcRenderer.invoke("aiondx:signin", { op: "poll" }),\n' +
    '  cancel: () => electron.ipcRenderer.invoke("aiondx:signin", { op: "cancel" })\n' +
    '});\n' + anchor);
  notes.push('preload: aiondxSignin');
}

fs.writeFileSync(mainFile, main);
fs.writeFileSync(preloadFile, preload);
fs.writeFileSync(layoutFiles[0], layout);
// The AionDX themes, for the renderer's first-run setup on a machine that has never had them.
const { THEMES } = require('./themes');
fs.writeFileSync(path.join(ext, 'out', 'renderer', 'aiondx-themes.js'),
  '/* AionDX themes (patches/0009-identity/themes.js), read by aionui-dx.js at first run. */\nwindow.__aionDxThemes = ' + JSON.stringify(THEMES) + ';\n');
notes.push('out/renderer/aiondx-themes.js');
const indexFile = path.join(ext, 'out', 'renderer', 'index.html');
let indexHtml = fs.readFileSync(indexFile, 'utf8');
if (!indexHtml.includes('aiondx-themes.js')) {
  const tag = '<script src="./aionui-dx.js" defer></script>';
  if (!indexHtml.includes(tag)) { console.error('0009: index.html has no aionui-dx.js tag (patch 0001 first). Nothing more written.'); process.exit(1); }
  indexHtml = indexHtml.replace(tag, '<script src="./aiondx-themes.js" defer></script>\n    ' + tag);
  notes.push('index.html: aiondx-themes.js');
} else notes.push('index.html: aiondx-themes.js already there');
// The page title and the web-app names read AionDX (the window takes its title from the page).
for (const [from, to] of [['<title>AionUi</title>', '<title>AionDX</title>'],
                          ['<meta name="application-name" content="AionUi" />', '<meta name="application-name" content="AionDX" />'],
                          ['<meta name="apple-mobile-web-app-title" content="AionUi" />', '<meta name="apple-mobile-web-app-title" content="AionDX" />']]) {
  if (indexHtml.includes(from)) { indexHtml = indexHtml.split(from).join(to); notes.push('index.html: ' + to); }
}
// AionDX's Welcome screen (patch 0001) is the first screen, so AionUi's own three-page Opening guide is
// marked seen before the app reads the mark (the bundle shows the guide while
// localStorage['onboarding.openingGuideSeen_v1'] !== 'true'). It has to run before the app's module
// script, which is why it is an inline script and not part of the deferred aionui-dx.js.
if (!indexHtml.includes('openingGuideSeen_v1')) {
  const mod = indexHtml.match(/<script type="module"[^>]*><\/script>/);
  if (!mod) { console.error('0009: index.html has no module script tag. Nothing more written.'); process.exit(1); }
  indexHtml = indexHtml.replace(mod[0], "<script>/* AionDX patch 0009: the Welcome screen replaces AionUi's Opening guide */" +
    "try{localStorage.setItem('onboarding.openingGuideSeen_v1','true')}catch(e){}</script>\n    " + mod[0]);
  notes.push('index.html: Opening guide marked seen');
} else notes.push('index.html: Opening guide mark already there');
fs.writeFileSync(indexFile, indexHtml);
fs.copyFileSync(path.join(__dirname, 'icon', 'aiondx.svg'), path.join(ext, 'out', 'renderer', 'aiondx-mark.svg'));
notes.push('out/renderer/aiondx-mark.svg');
fs.copyFileSync(PNG(1024), path.join(assets, logos[0]));
notes.push('in-app logo: ' + logos[0]);
for (const dir of [path.join(ext, 'out', 'renderer', 'pwa'), path.join(ext, 'public', 'pwa')]) {
  if (!fs.existsSync(dir)) continue;
  for (const s of [180, 192, 512]) {
    const f = path.join(dir, `icon-${s}.png`);
    if (fs.existsSync(f)) fs.copyFileSync(PNG(s), f);
  }
  notes.push('pwa icons: ' + path.relative(ext, dir));
}
fs.mkdirSync(path.join(ext, 'out', 'aiondx'), { recursive: true });
fs.copyFileSync(PNG(256), path.join(ext, 'out', 'aiondx', 'app.png'));
notes.push('out/aiondx/app.png');
for (const n of notes) console.log('0009: ' + n);
