#!/usr/bin/env node
/**
 * apply.js - patch 0010's build step: AionDX as its own product, no longer AionUi's. Run by tools\build-release.ps1 on the extracted
 * asar, after 0001, 0003, 0006 and 0009:
 *
 *   node patches\0010-official-identity\apply.js <extracted asar dir> <AionDX version> [--check] [--report FILE]
 *
 * What it changes (each anchor must match its expected count on an unpatched tree, or show its done-marker on a patched one;
 * otherwise nothing is written):
 *   out/main/index.js
 *     Sentry          AionUi's Sentry project (a DSN baked into the bundle) no longer receives this app's crash reports.
 *     update check    "Check for updates" reads the GitHub releases of Renegade1993/AionDX (an asset named
 *                     AionDX-<version>-setup.exe) in place of AionUi's CDN feed, and offers a newer one.
 *     names           every display string that says AionUi says AionDX (see "the name pass").
 *   out/main/*.js, out/preload, out/renderer/assets/*.js
 *     names           the same pass over every bundle: login page, tray, notifications, dialogs, errors, in every language.
 *   out/renderer (the SystemSettings chunk)
 *     About page      AionDX, its version, its GitHub repository, issues and releases; AionUi's contact and website links gone.
 *   out/renderer (the index chunk)
 *     analytics       AionUi's Google Analytics property (page views, message counts, a device id) is no longer sent to.
 *     feedback        "Bug report" and the one-click feedback open AionDX's GitHub issues in the browser. They sent logs, a
 *                     database summary and a screenshot to AionUi's Sentry.
 *   out/renderer (the team page chunk)
 *     remove member   its confirm dialog had no button text, so Arco showed its Chinese defaults.
 *   out/renderer (the SendBox draft store, the upload hook)
 *     draft pictures  a picture or file attached to a message box is kept in localStorage (aiondx.sbdraft.v1) and comes back after
 *                     a restart; leaving a chat no longer cancels an upload still in flight.
 *   manifests, images, package.json description
 *
 * package.json's "version" and "name" stay AionUi's on purpose: AionUi refuses to start on data stamped by a newer version, and its
 * data folder (%APPDATA%\AionUi) is named from "name". The AionDX version is baked into the places that show it.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const ext = args[0];
const VERSION = args[1];
const CHECK = args.includes('--check');
const repI = args.indexOf('--report');
const REPORT = repI >= 0 ? args[repI + 1] : null;
if (!ext || !VERSION || !fs.existsSync(path.join(ext, 'out', 'main', 'index.js'))) {
  console.error('usage: node apply.js <extracted asar dir> <AionDX version> [--check] [--report FILE]');
  process.exit(2);
}
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(VERSION)) { console.error('0010: the version must look like 0.25.0 (got ' + VERSION + ')'); process.exit(2); }

const REPO = 'Renegade1993/AionDX';
const REPO_URL = 'https://github.com/' + REPO;
const MARK = 'AIONDX-0010';
const acorn = require(path.join(__dirname, '..', '..', 'vendor', 'node_modules', 'acorn'));

const files = new Map();     // path -> { text, orig }
function load(p) {
  if (!files.has(p)) { const t = fs.readFileSync(p, 'utf8'); files.set(p, { text: t, orig: t }); }
  return files.get(p);
}
const fail = (m) => { console.error('0010: ' + m); process.exit(1); };
const notes = [];
const say = (m) => { notes.push(m); console.log('  ' + m); };

function listJs(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJs(p)); else if (/\.js$/.test(e.name)) out.push(p);
  }
  return out;
}
const MAIN = path.join(ext, 'out', 'main', 'index.js');
const ASSETS = path.join(ext, 'out', 'renderer', 'assets');
const rendererJs = listJs(ASSETS);
const mainJs = listJs(path.join(ext, 'out', 'main')).concat(listJs(path.join(ext, 'out', 'preload')));
// AionDX's own scripts, and the built-in MCP scripts, which the app runs from app.asar.unpacked (a copy in the asar is not what runs, and the
// packer refuses to change one).
const OWN = /aionui-dx\.js$|aiondx-themes\.js$|builtin-mcp-[\w-]+\.js$/;

/** The one renderer chunk whose text contains every needle. */
function chunk(label, ...needles) {
  const hits = rendererJs.filter((f) => !OWN.test(f) && needles.every((n) => load(f).text.includes(n)));
  if (hits.length !== 1) fail(label + ': expected one chunk, found ' + hits.length + ' (' + hits.map((h) => path.basename(h)).join(', ') + ')');
  return hits[0];
}
/** Replace `from` (string or RegExp without the g flag) in a file: exactly `count` times, or already done (its marker present). */
function edit(file, label, from, to, opts) {
  opts = opts || {};
  const f = load(file);
  const count = opts.count === undefined ? 1 : opts.count;
  if (opts.done && f.text.includes(opts.done)) { say(label + ': already done'); return; }
  const re = from instanceof RegExp ? new RegExp(from.source, from.flags.replace('g', '') + 'g') : null;
  const n = re ? (f.text.match(re) || []).length : f.text.split(from).length - 1;
  if (n !== count) fail(label + ': expected ' + count + ' match(es) in ' + path.basename(file) + ', found ' + n);
  f.text = re ? f.text.replace(re, to) : f.text.split(from).join(typeof to === 'function' ? to() : to);
  say(label + ': ' + n + ' place' + (n === 1 ? '' : 's'));
}

// ---------------------------------------------------------------------------------------------------- main process
console.log('main process');
edit(MAIN, 'Sentry off', /dsn: "https:\/\/[0-9a-f]+@[a-z0-9.]*sentry\.io\/\d+",/, 'dsn: void 0, /* ' + MARK + ': no crash reports to AionUi\'s Sentry project */',
  { done: MARK + ': no crash reports' });

const UPDATE_HELPER = '/* ' + MARK + ' BEGIN: the update check reads AionDX\'s own releases (patches/0010-official-identity). */\n' +
  'const AIONDX_VERSION = ' + JSON.stringify(VERSION) + ';\n' +
  'const AIONDX_REPO = ' + JSON.stringify(REPO) + ';\n' +
  'const AIONDX_SUMS = new Map();\n' +
  '/** The release\'s SHA256SUMS.txt: an installer is run only when its hash is the one published there. */\n' +
  'async function __aiondxFetchSums(rel) {\n' +
  '  const sums = (rel.assets || []).find((a) => a && a.name === "SHA256SUMS.txt");\n' +
  '  if (!sums) return;\n' +
  '  const res = await fetch(sums.browser_download_url, { headers: { "User-Agent": "AionDX" } });\n' +
  '  if (!res.ok) return;\n' +
  '  for (const line of (await res.text()).split(/\\r?\\n/)) {\n' +
  '    const m = /^([0-9a-f]{64})\\s+\\*?(.+?)\\s*$/i.exec(line);\n' +
  '    if (m) AIONDX_SUMS.set(m[2], m[1].toLowerCase());\n' +
  '  }\n' +
  '}\n' +
  '/** The release list. AIONDX_RELEASES_URL (the tests\' stand-in server) and AIONDX_DOWNLOADS_DIR (where the update is saved) exist for the tests. */\n' +
  'async function __aiondxReleases() {\n' +
  '  const url = process.env.AIONDX_RELEASES_URL || ("https://api.github.com/repos/" + AIONDX_REPO + "/releases");\n' +
  '  const res = await fetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "AionDX" }, signal: AbortSignal.timeout(30000) });\n' +
  '  if (!res.ok) throw new Error("GitHub answered " + res.status);\n' +
  '  const list = await res.json();\n' +
  '  if (!Array.isArray(list)) throw new Error("GitHub sent something other than a list of releases");\n' +
  '  return list;\n' +
  '}\n' +
  'async function __aiondxCheckUpdate() {\n' +
  '  const releases = await __aiondxReleases();\n' +
  '  let best = null;\n' +
  '  for (const rel of releases) {\n' +
  '    if (!rel || rel.draft) continue;\n' +
  '    const asset = (rel.assets || []).find((a) => /^AionDX-\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.]+)?-setup\\.exe$/i.test(a && a.name || ""));\n' +
  '    if (!asset) continue;\n' +
  '    const version = /^AionDX-(.+)-setup\\.exe$/i.exec(asset.name)[1];\n' +
  '    if (!semver.valid(version)) continue;\n' +
  '    if (!best || semver.gt(version, best.version)) best = { rel, asset, version };\n' +
  '  }\n' +
  '  if (!best) return { success: true, data: { currentVersion: AIONDX_VERSION, updateAvailable: false } };\n' +
  '  try { await __aiondxFetchSums(best.rel); } catch {}\n' +
  '  const asset = { name: best.asset.name, url: best.asset.browser_download_url, fallbackUrl: best.asset.browser_download_url, size: best.asset.size || 0, contentType: best.asset.content_type };\n' +
  '  const latest = { tagName: best.rel.tag_name, version: best.version, name: best.rel.name || best.rel.tag_name, body: best.rel.body || "", htmlUrl: best.rel.html_url || "",\n' +
  '    publishedAt: best.rel.published_at, prerelease: !!best.rel.prerelease, draft: false, assets: [asset], recommendedAsset: asset };\n' +
  '  return { success: true, data: { currentVersion: AIONDX_VERSION, updateAvailable: semver.gt(best.version, AIONDX_VERSION), latest } };\n' +
  '}\n' +
  '/** Install a downloaded update: only AionDX\'s own installer, from the Downloads folder, whose SHA-256 is the one the release publishes. It runs\n' +
  ' *  silently and closes this app; /UPDATE=yes makes it start AionDX again when it is done. */\n' +
  '(function __aiondxUpdateInstall() {\n' +
  '  try {\n' +
  '    const electron = require$$0$2;\n' +
  '    if (process.env.AIONDX_DOWNLOADS_DIR) { try { electron.app.setPath("downloads", process.env.AIONDX_DOWNLOADS_DIR); } catch {} }\n' +
  '    electron.ipcMain.handle("aiondx:update-install", async (_event, file) => {\n' +
  '      try {\n' +
  '        const p = path__namespace.resolve(String(file || ""));\n' +
  '        const name = path__namespace.basename(p);\n' +
  '        const dl = path__namespace.resolve(electron.app.getPath("downloads"));\n' +
  '        if (path__namespace.dirname(p).toLowerCase() !== dl.toLowerCase() || !/^AionDX-\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.]+)?-setup(?: \\(\\d+\\))?\\.exe$/i.test(name)) return { ok: false, error: "this is not an AionDX installer in the Downloads folder" };\n' +
  '        if (!fs__namespace.existsSync(p)) return { ok: false, error: "the installer is no longer in the Downloads folder" };\n' +
  '        const key = name.replace(/ \\(\\d+\\)(?=\\.exe$)/, "");\n' +
  '        if (!AIONDX_SUMS.has(key)) { try { await __aiondxCheckUpdate(); } catch {} }\n' +
  '        const want = AIONDX_SUMS.get(key);\n' +
  '        if (!want) return { ok: false, error: "no published checksum was found for " + key + "; check for updates again" };\n' +
  '        const got = await new Promise((resolve, reject) => {\n' +
  '          const h = require("node:crypto").createHash("sha256");\n' +
  '          const s = fs__namespace.createReadStream(p);\n' +
  '          s.on("data", (d) => h.update(d)); s.on("error", reject); s.on("end", () => resolve(h.digest("hex")));\n' +
  '        });\n' +
  '        if (got !== want) return { ok: false, error: "the downloaded installer does not match the checksum the release publishes, so it was not run" };\n' +
  '        const child = require("node:child_process").spawn(p, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CLOSEAPPLICATIONS", "/UPDATE=yes"], { detached: true, stdio: "ignore", windowsHide: true });\n' +
  '        child.unref();\n' +
  '        setTimeout(() => { try { electron.app.quit(); } catch {} setTimeout(() => { try { electron.app.exit(0); } catch {} }, 6000); }, 700);\n' +
  '        return { ok: true };\n' +
  '      } catch (e) { return { ok: false, error: String(e && e.message || e) }; }\n' +
  '    });\n' +
  '  } catch {}\n' +
  '})();\n' +
  '/** An update looked for by itself: 30 seconds after the app starts, then every 6 hours. A newer release opens the app\'s update card (the Help\n' +
  ' *  menu and About page open it too); the card opens only once a window has finished loading, and the check tries again every 15 s until one\n' +
  ' *  has (up to 5 times), so a slow start does not lose it. A dismissed card comes back at the next run. AIONDX_NO_UPDATE_CHECK=1 turns it off;\n' +
  ' *  the tests leave it off. */\n' +
  '(function __aiondxUpdateWatch() {\n' +
  '  try {\n' +
  '    const electron = require$$0$2;\n' +
  '    const own = process.resourcesPath ? path__namespace.join(process.resourcesPath, "aiondx", "release.json") : "";\n' +
  '    if (!own || !fs__namespace.existsSync(own) || process.env.AIONDX_NO_UPDATE_CHECK === "1") return;\n' +
  '    const windowReady = () => electron.BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && !w.webContents.isDestroyed() && !w.webContents.isLoading() && /index\\.html/.test(w.webContents.getURL()));\n' +
  '    const run = async () => {\n' +
  '      try {\n' +
  '        const r = await __aiondxCheckUpdate();\n' +
  '        if (!(r && r.success && r.data && r.data.updateAvailable && r.data.latest)) return;\n' +
  '        for (let i = 0; i < 5 && !windowReady(); i++) await new Promise((res) => setTimeout(res, 15000));\n' +
  '        if (windowReady()) update$d.open.emit({ source: "startup" });\n' +
  '      } catch {}\n' +
  '    };\n' +
  '    electron.app.whenReady().then(() => {\n' +
  '      const first = setTimeout(run, Number(process.env.AIONDX_UPDATE_FIRST_MS) || 30000); if (first.unref) first.unref();\n' +
  '      const again = setInterval(run, 6 * 3600 * 1000); if (again.unref) again.unref();\n' +
  '    });\n' +
  '  } catch {}\n' +
  '})();\n' +
  '/* ' + MARK + ' END */\n';
if (!load(MAIN).text.includes('async function __aiondxCheckUpdate()')) {
  edit(MAIN, 'update check: helper', 'const DEFAULT_REPO = "iOfficeAI/AionUi";', UPDATE_HELPER + 'const DEFAULT_REPO = ' + JSON.stringify(REPO) + ';');
  edit(MAIN, 'update check: user agent', 'const DEFAULT_USER_AGENT = "AionUi";', 'const DEFAULT_USER_AGENT = "AionDX";');
  const old = '        const repo = resolveRepo(params?.repo);\n' +
    '        const currentVersion2 = require$$0$2.app.getVersion();\n' +
    '        const manifest = await fetchCdnManifest();\n' +
    '        const latest = mapCdnManifestToRelease(manifest, repo);\n' +
    '        const currentSemver = semver.valid(currentVersion2) || semver.coerce(currentVersion2)?.version;\n' +
    '        if (!currentSemver || !latest) {\n' +
    '          return { success: true, data: { currentVersion: currentVersion2, updateAvailable: false } };\n' +
    '        }\n' +
    '        const enrichment = await fetchReleaseNotesEnrichment(repo, latest.version);\n' +
    '        return {\n' +
    '          success: true,\n' +
    '          data: {\n' +
    '            currentVersion: currentVersion2,\n' +
    '            updateAvailable: semver.gt(latest.version, currentSemver),\n' +
    '            latest: {\n' +
    '              ...latest,\n' +
    '              body: enrichment.body,\n' +
    '              name: enrichment.name,\n' +
    '              htmlUrl: enrichment.htmlUrl ?? "",\n' +
    '              publishedAt: enrichment.publishedAt ?? latest.publishedAt\n' +
    '            }\n' +
    '          }\n' +
    '        };\n';
  edit(MAIN, 'update check: provider', old, '        return await __aiondxCheckUpdate();\n');
} else say('update check: already done');

// ------------------------------------------------------------------------------------------------ renderer chunks
console.log('renderer');
const about = chunk('About page', '"settings.helpDocumentation"', 'https://x.com/WailiVery');
edit(about, 'About: version', '"v","2.2.2"', '"v",' + JSON.stringify(VERSION), { done: '"v",' + JSON.stringify(VERSION) });
edit(about, 'About: update check version', 'fallbackVersion:"2.2.2"', 'fallbackVersion:' + JSON.stringify(VERSION), { done: 'fallbackVersion:' + JSON.stringify(VERSION) });
edit(about, 'About: repository link', 'x("https://github.com/iOfficeAI/AionUi")', 'x(' + JSON.stringify(REPO_URL) + ')', { done: 'x(' + JSON.stringify(REPO_URL) + ')' });
edit(about, 'About: links', /\{title:t\("settings\.helpDocumentation"\),url:"https:\/\/github\.com\/iOfficeAI\/AionUi\/wiki",icon:(e\.createElement\(U,\{theme:"outline",size:"16",className:"rtl-mirror"\}\))\},\{title:t\("settings\.updateLog"\),url:"https:\/\/github\.com\/iOfficeAI\/AionUi\/releases",icon:\1\},\{title:t\("settings\.bugReport"\),onClick:\(\)=>h\(!0\),icon:\1\},\{title:t\("settings\.contactMe"\),url:"https:\/\/x\.com\/WailiVery",icon:\1\},\{title:t\("settings\.officialWebsite"\),url:"https:\/\/www\.aionui\.com",icon:\1\}/,
  (m, icon) => '{title:t("settings.helpDocumentation"),url:' + JSON.stringify(REPO_URL + '#readme') + ',icon:' + icon + '},{title:t("settings.updateLog"),url:' + JSON.stringify(REPO_URL + '/releases') + ',icon:' + icon + '},{title:t("settings.bugReport"),url:' + JSON.stringify(REPO_URL + '/issues') + ',icon:' + icon + '}',
  { done: JSON.stringify(REPO_URL + '/issues') });

const team = chunk('team page', 'team.removeAgent.confirmContent', 'Remove this member from the team?', 'okButtonProps:{status:"danger"}');
edit(team, 'remove member: button text', /([\w$]+)\("team\.removeAgent\.confirmContent",\{defaultValue:"Remove this member from the team\?"\}\),okButtonProps:\{status:"danger"\},onOk:([\w$]+)\}/,
  (m, t, ok) => t + '("team.removeAgent.confirmContent",{defaultValue:"Remove this member from the team?"}),okText:' + t + '("common.remove",{defaultValue:"Remove"}),cancelText:' + t + '("common.cancel",{defaultValue:"Cancel"}),okButtonProps:{status:"danger"},onOk:' + ok + '}',
  { done: '"Remove this member from the team?"}),okText:' });

const main = chunk('app chunk', 'Failed to flush feedback report', 'VITE_FIREBASE_MEASUREMENT_ID', 'diagnosticsContext');
edit(main, 'analytics: no config, so none is sent', /return Object\.values\(([\w$]+)\)\.some\(([\w$]+)=>\2===null\)\?null:\1\}/, 'return null/*' + MARK + '*/}', { done: 'return null/*' + MARK + '*/}' });
edit(main, 'analytics: events dropped', /function ([\w$]+)\(([\w$]+),([\w$]+)\)\{if\(!([\w$]+)\(\)\|\|!([\w$]+)\)\{([\w$]+)\.push\(\{eventName:\2,params:\3\}\);return\}/,
  (m, fn, e, t, q, ea, qc) => 'function ' + fn + '(' + e + ',' + t + '){return/*' + MARK + '*/;if(!' + q + '()||!' + ea + '){' + qc + '.push({eventName:' + e + ',params:' + t + '});return}', { done: '{return/*' + MARK + '*/;if(!' });
edit(main, 'feedback: the opener goes to GitHub issues', /(\.useCallback\(async ([\w$]+)=>\{)(const [\w$]+=[\w$]+\(\),[\w$]+=[\w$]+\([\w$]+\),[\w$]+=[\w$]+\|\|\2\?\.diagnosticsContext\?)/,
  (m, head, b, rest) => head + 'if(window.aiondxFeedback){window.aiondxFeedback(' + b + ');return}' + rest, { done: 'window.aiondxFeedback(' });
edit(main, 'feedback: the submit goes to GitHub issues', /async function ([\w$]+)\(([\w$]+)\)\{(const ([\w$]+)=\[\.\.\.\2\.attachments\?\?\[\]\];let ([\w$]+),([\w$]+)=\2\.collectLogs)/,
  (m, fn, e, rest) => 'async function ' + fn + '(' + e + '){if(window.aiondxFeedback){return window.aiondxFeedback(' + e + ')}' + rest, { done: 'return window.aiondxFeedback(' });

// Self-update: the update card's "Install now" runs the downloaded installer through the main process (checked, silent, restarts the app).
const ctrl = chunk('update controller', '.openFile.invoke(', 'showItemInFolder.invoke(', 'downloadPath');
edit(ctrl, 'update: install runs the installer silently', /([\w$]+)\.openFile\.invoke\(([\w$]+)\.downloadPath\)/,
  (m, k, h) => '(window.aiondxInstallUpdate?window.aiondxInstallUpdate(' + h + '.downloadPath,()=>' + k + '.openFile.invoke(' + h + '.downloadPath)):' + k + '.openFile.invoke(' + h + '.downloadPath))',
  { count: 2, done: 'window.aiondxInstallUpdate?' });
const PRELOAD = path.join(ext, 'out', 'preload', 'index.js');
edit(PRELOAD, 'preload: aiondxUpdate', 'const backendPort = electron.ipcRenderer.sendSync("get-backend-port");',
  '/* ' + MARK + ': the update install (patches/0010-official-identity, main process aiondx:update-install) */\n' +
  'electron.contextBridge.exposeInMainWorld("aiondxUpdate", {\n  install: (file) => electron.ipcRenderer.invoke("aiondx:update-install", file)\n});\n' +
  'const backendPort = electron.ipcRenderer.sendSync("get-backend-port");', { done: 'exposeInMainWorld("aiondxUpdate"' });

// A picture attached to a message box: kept across a restart, and not cancelled by leaving the chat.
const draft = chunk('draft store', 'acp:new Map,codex:new Map,aionrs:new Map');
const DRAFT_KEY = 'aiondx.sbdraft.v1';
const DRAFT_CODE = '/* ' + MARK + ' BEGIN: pictures and files attached to a message box survive a restart (patches/0010-official-identity). */' +
  'const __aiondxTs=new Map,__aiondxSave=()=>{try{const o={v:1};for(const k of["acp","codex","aionrs"]){o[k]=[];a[k].forEach((d,id)=>{if(d&&(d.uploadFile&&d.uploadFile.length||d.atPath&&d.atPath.length)){const key=k+"|"+id;__aiondxTs.has(key)||__aiondxTs.set(key,Date.now());o[k].push([id,{atPath:d.atPath||[],uploadFile:d.uploadFile||[]},__aiondxTs.get(key)])}})}localStorage.setItem(' + JSON.stringify(DRAFT_KEY) + ',JSON.stringify(o))}catch{}};' +
  'try{const r=JSON.parse(localStorage.getItem(' + JSON.stringify(DRAFT_KEY) + ')||"null");if(r&&r.v===1){const now=Date.now();for(const k of["acp","codex","aionrs"])for(const[id,d,ts]of r[k]||[])if(now-ts<2592e6&&d&&(d.uploadFile&&d.uploadFile.length||d.atPath&&d.atPath.length)){a[k].set(id,{_type:k,content:"",atPath:d.atPath||[],uploadFile:d.uploadFile||[]});__aiondxTs.set(k+"|"+id,ts)}}}catch{}' +
  '/* ' + MARK + ' END */';
edit(draft, 'drafts: restore from localStorage', 'const a={acp:new Map,codex:new Map,aionrs:new Map};', 'const a={acp:new Map,codex:new Map,aionrs:new Map};' + DRAFT_CODE, { done: MARK + ' BEGIN: pictures and files attached' });
edit(draft, 'drafts: save on every change', 'case"aionrs":r?a.aionrs.set(t,r):a.aionrs.delete(t);break}}', 'case"aionrs":r?a.aionrs.set(t,r):a.aionrs.delete(t);break}__aiondxSave()}', { done: 'break}__aiondxSave()}' });

const abort = chunk('upload hook', 'exceptConversationId:');
const abortRe = /function ([\w$]+)\(([\w$]+),([\w$]+)\)\{([\w$]+)\.useEffect\(\(\)=>\(([\w$]+)\(\{source:\3,exceptConversationId:\2\?\?null\}\),\(\)=>\{\5\(\{source:\3\}\)\}\),\[\2,\3\]\)\}/;
if (abortRe.test(load(abort).text)) edit(abort, 'uploads: leaving a chat no longer cancels them', abortRe, (m, fn, e, t, react) => 'function ' + fn + '(' + e + ',' + t + '){' + react + '.useEffect(()=>{/* ' + MARK + ': an upload goes on when the chat is left */},[' + e + ',' + t + '])}');
else if (load(abort).text.includes(MARK + ': an upload goes on')) say('uploads: already done');
else fail('uploads: the abort hook was not found');

// The version the page falls back to when the update check cannot answer.
for (const f of rendererJs) {
  if (OWN.test(f)) continue;
  const t = load(f).text;
  const n = t.split('fallbackVersion:"2.2.2"').length - 1;
  if (n) edit(f, 'version fallback in ' + path.basename(f), 'fallbackVersion:"2.2.2"', 'fallbackVersion:' + JSON.stringify(VERSION), { count: n });
}

// ----------------------------------------------------------------------------------------------- the name pass
console.log('names');
// Left alone: links, e-mail addresses, paths, folder and product keys, environment variable names, log prefixes. Display text is mixed case
// (AionUi, AionUI) and the keys are lower case or upper case, so the test is case sensitive.
const KEEP = /https?:\/\/|\.com\b|github\.com|iOfficeAI|@|[\\\/]AionUi\b|AionUi[\\\/]|[\\\/]aionui\b|aionui[\\\/]|\.aionui|\baionui[-_.:]|AIONUI_|AionUi-Dev|\.exe\b|com\.aionui|\[AionUi[\]:]/;
// Names that look like display text and are keys: the credential store's service name, a legacy MCP server name, the user's own CSS
// block markers, the in-app browser's version string.
const KEEP_EXACT = new Set(['AionUi Desktop', 'AionUi Desktop (', 'AionUi Image Generation', 'AionUi in-app browser (Chrome/', '/* AionUi Theme Background Start */', '/* AionUi Theme Background End */']);
let renamed = 0;
const renamedSet = new Map();
const left = new Map();
function namePass(file) {
  const f = load(file);
  if (!/AionU[iI]/.test(f.text)) return;
  const toks = [];
  try {
    acorn.parse(f.text, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true, allowHashBang: true, onToken: (t) => { if (t.type.label === 'string' || t.type.label === 'template') toks.push(t); } });
  } catch (e) {
    try {
      toks.length = 0;
      acorn.parse(f.text, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true, allowHashBang: true, onToken: (t) => { if (t.type.label === 'string' || t.type.label === 'template') toks.push(t); } });
    } catch (e2) { say('name pass: could not parse ' + path.basename(file) + ' (' + String(e2.message).slice(0, 60) + '); left as it is'); return; }
  }
  const out = [];
  let last = 0;
  for (const t of toks) {
    const raw = f.text.slice(t.start, t.end);
    if (!/AionU[iI]/.test(raw)) continue;
    const v = String(t.value);
    const before = f.text.slice(Math.max(0, t.start - 90), t.start);
    const inPath = /(?:join|resolve|relative|dirname|basename)\([^)]*$/.test(before) || /(?:appData|userData|APPDATA|dataDir|dataPath|baseDir)\w*\s*[,+]\s*$/.test(before);
    if (KEEP.test(v) || KEEP_EXACT.has(v) || inPath) { left.set(v.slice(0, 90), (left.get(v.slice(0, 90)) || 0) + 1); continue; }
    const next = raw.replace(/AionU[iI]/g, 'AionDX');
    out.push(f.text.slice(last, t.start), next);
    last = t.end;
    renamed++;
    renamedSet.set(v.slice(0, 90), (renamedSet.get(v.slice(0, 90)) || 0) + 1);
  }
  if (!out.length) return;
  f.text = out.join('') + f.text.slice(last);
}
[...new Set(mainJs.concat(rendererJs))].filter((f) => !OWN.test(f)).forEach(namePass);
say('name pass: ' + renamed + ' strings now say AionDX; ' + [...left.values()].reduce((a, b) => a + b, 0) + ' left as paths, links, folder names and identifiers');

// ----------------------------------------------------------------------------------- manifests, images, package.json
console.log('files');
function writeText(p, text) { if (!CHECK) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); } }
for (const rel of ['out/renderer/manifest.webmanifest', 'public/manifest.webmanifest']) {
  const p = path.join(ext, rel);
  if (!fs.existsSync(p)) continue;
  const f = load(p);
  const fixed = f.text.replace(/"name": "AionUi"/, '"name": "AionDX"').replace(/"short_name": "AionUi"/, '"short_name": "AionDX"').replace(/AionUi WebUI for mobile and desktop browsers\./, 'AionDX WebUI for mobile and desktop browsers.');
  if (fixed !== f.text) { f.text = fixed; say(rel + ': named AionDX'); }
}
{
  const p = path.join(ext, 'package.json');
  const f = load(p);
  let j = JSON.parse(f.text);
  j.description = 'AionDX: one app for Claude Code, Codex, Gemini, Antigravity and the other agents AionUi supports.';
  j.author = { name: 'AionDX' };
  const text = JSON.stringify(j, null, 2) + (f.text.endsWith('\n') ? '\n' : '');
  if (text !== f.text) { f.text = text; say('package.json: description and author'); }
}
const MARK_1024 = path.join(__dirname, '..', '0009-identity', 'icon', 'png', 'aiondx-1024.png');
for (const rel of ['static/images/brand/app.png', 'out/main/static/images/brand/app.png']) {
  const p = path.join(ext, rel);
  if (!fs.existsSync(p)) continue;
  const have = fs.readFileSync(p);
  const want = fs.readFileSync(MARK_1024);
  if (!have.equals(want)) { if (!CHECK) fs.writeFileSync(p, want); say(rel + ': the AionDX mark'); }
}

// -------------------------------------------------------------------------------------------------------------- write
let changed = 0;
for (const [p, f] of files) if (f.text !== f.orig) { changed++; if (!CHECK) fs.writeFileSync(p, f.text); }
console.log((CHECK ? 'checked' : 'wrote') + ': ' + changed + ' file(s) changed');
if (REPORT) {
  const lines = ['# 0010 report', '', 'renamed strings (' + renamed + ' places, ' + renamedSet.size + ' distinct; first 90 chars):'];
  [...renamedSet.entries()].sort().forEach(([v, n]) => lines.push('  x' + n + ' ' + JSON.stringify(v)));
  lines.push('', 'left as they were (paths, links, folder names, identifiers):');
  [...left.entries()].sort().forEach(([v, n]) => lines.push('  x' + n + ' ' + JSON.stringify(v)));
  fs.writeFileSync(REPORT, lines.join('\n') + '\n');
}
