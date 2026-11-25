'use strict';
/**
 * aiondx-menu.js - the right-click menu of AionDX (patches/0009-identity). Electron asks the main process for a menu only when the page did not handle
 * the right-click itself, so AionUi's own menus (the file tree, say) are untouched. The menu has, as the target allows:
 *   a misspelled word   suggestions, "Add to dictionary"
 *   a link              Open link in browser, Copy link
 *   a picture           Copy image, Open in photo viewer, Open image location
 *   a text box          Undo, Redo, Cut, Copy, Paste, Select all (the message box's Undo and Redo use the page's own history: undoState)
 *   selected text       Copy
 * buildTemplate() is pure (it takes what it needs in `deps`) so tests can run it without Electron. The wiring is install(), called from the helper
 * block in apply.js; it is also the only place that touches Electron.
 *
 * Where a picture's file is, the page knows and the main process does not: AionUi loads a picture as a data URL from a path. The page keeps the path
 * for each picture it loaded (window.__aionDx.imagePathAt(x, y), patches/0001-renderer-dx) and the menu asks for it with a short timeout, so a slow
 * or missing answer only greys out "Open image location".
 *
 * AIONDX_MENU_TEST_FILE (tests): the template's labels are written to that file, one JSON line per right-click, and no menu is shown.
 */
const fs = require('fs');

const SUGGESTIONS = 5;

/** The labels and actions for one right-click. deps: { wc, clipboard, shell, imagePath, openExternal, undo }; undo is the page's answer for
 *  the focused box ({ own, canUndo, canRedo }): own means the message box, whose Undo and Redo are the page's own history. */
function buildTemplate(params, deps) {
  params = params || {};
  deps = deps || {};
  const f = params.editFlags || {};
  const wc = deps.wc || {};
  const out = [];
  const sep = () => { if (out.length && out[out.length - 1].type !== 'separator') out.push({ type: 'separator' }); };

  if (params.isEditable && params.misspelledWord) {
    const sugg = Array.isArray(params.dictionarySuggestions) ? params.dictionarySuggestions.slice(0, SUGGESTIONS) : [];
    if (sugg.length) sugg.forEach((s) => out.push({ label: s, click: () => { try { wc.replaceMisspelling(s); } catch (e) { /* the box changed */ } } }));
    else out.push({ label: 'No suggestions', enabled: false });
    out.push({ label: 'Add to dictionary', click: () => { try { wc.session.addWordToSpellCheckerDictionary(params.misspelledWord); } catch (e) { /* no spellchecker */ } } });
    sep();
  }

  const link = String(params.linkURL || '');
  if (link) {
    if (/^https?:/i.test(link)) out.push({ label: 'Open link in browser', click: () => { try { (deps.openExternal || (deps.shell && deps.shell.openExternal))(link); } catch (e) { /* the system refused */ } } });
    const mail = /^mailto:/i.test(link);
    out.push({ label: mail ? 'Copy email address' : 'Copy link', click: () => { try { deps.clipboard.writeText(mail ? decodeURIComponent(link.replace(/^mailto:/i, '').split('?')[0]) : link); } catch (e) { /* no clipboard */ } } });
    sep();
  }

  if (params.mediaType === 'image') {
    out.push({ label: 'Copy image', click: () => { try { wc.copyImageAt(params.x, params.y); } catch (e) { /* the picture went */ } } });
    const where = deps.imagePath || '';
    // the system's own picture viewer (November 19th, 2026): its file, or a copy written for it when the picture has no file of its own
    const viewable = !!where || /^(data:image\/|file:|https?:)/i.test(String(params.srcURL || ''));
    out.push({
      label: viewable ? 'Open in photo viewer' : 'Open in photo viewer (no picture to open)',
      enabled: viewable && typeof deps.openPicture === 'function',
      click: () => { try { deps.openPicture(where, String(params.srcURL || '')); } catch (e) { /* the system refused */ } },
    });
    out.push({
      label: where ? 'Open image location' : 'Open image location (this picture has no file)',
      enabled: !!where,
      click: () => { try { deps.shell.showItemInFolder(where); } catch (e) { /* Explorer refused */ } },
    });
    sep();
  }

  if (params.isEditable) {
    const u = deps.undo && deps.undo.own ? deps.undo : null;
    const step = (dir) => { try { wc.executeJavaScript('(function(){try{var d=window.__aionDx;return !!(d&&d.undoStep&&d.undoStep(' + dir + '));}catch(e){return false;}})()'); } catch (e) { /* the page went */ } };
    if (u) {
      out.push({ label: 'Undo', accelerator: 'CmdOrCtrl+Z', enabled: !!u.canUndo, click: () => step(-1) });
      out.push({ label: 'Redo', accelerator: 'CmdOrCtrl+Y', enabled: !!u.canRedo, click: () => step(1) });
    } else {
      out.push({ role: 'undo', label: 'Undo', enabled: !!f.canUndo });
      out.push({ role: 'redo', label: 'Redo', enabled: !!f.canRedo });
    }
    out.push({ type: 'separator' });
    out.push({ role: 'cut', label: 'Cut', enabled: !!f.canCut });
    out.push({ role: 'copy', label: 'Copy', enabled: !!f.canCopy });
    out.push({ role: 'paste', label: 'Paste', enabled: !!f.canPaste });
    out.push({ type: 'separator' });
    out.push({ role: 'selectAll', label: 'Select all', enabled: !!f.canSelectAll });
  } else if (params.selectionText && String(params.selectionText).trim()) {
    out.push({ role: 'copy', label: 'Copy' });
  }
  while (out.length && out[out.length - 1].type === 'separator') out.pop();
  return out.length ? out : null;
}

/** The page's answer for the picture under the pointer: a file path, or ''. Never throws, never waits longer than `ms`. */
function askPage(wc, x, y, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(typeof v === 'string' ? v : ''); } };
    const timer = setTimeout(() => finish(''), ms || 400);
    try {
      const code = '(function(){try{var d=window.__aionDx;return d&&d.imagePathAt?d.imagePathAt(' + (Number(x) | 0) + ',' + (Number(y) | 0) + '):"";}catch(e){return "";}})()';
      Promise.resolve(wc.executeJavaScript(code)).then((v) => { clearTimeout(timer); finish(v); }, () => { clearTimeout(timer); finish(''); });
    } catch (e) { clearTimeout(timer); finish(''); }
  });
}

/** The page's undo state for the focused box: { own, canUndo, canRedo }, or { own: false } (any other box, no answer within `ms`). */
function askUndo(wc, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v && typeof v === 'object' && v.own ? v : { own: false }); } };
    const timer = setTimeout(() => finish(null), ms || 300);
    try {
      const code = '(function(){try{var d=window.__aionDx;return d&&d.undoMenu?d.undoMenu():null;}catch(e){return null;}})()';
      Promise.resolve(wc.executeJavaScript(code)).then((v) => { clearTimeout(timer); finish(v); }, () => { clearTimeout(timer); finish(null); });
    } catch (e) { clearTimeout(timer); finish(null); }
  });
}

/** A picture in the system's own viewer: its file when it has one, else a copy written to %TEMP%\AionDX-pictures (a data URL), a file:
 *  URL's file, or the web address in the browser. Returns what was opened. */
function openPicture(shell, filePath, src) {
  const path = require('path'), os = require('os'), crypto = require('crypto');
  if (filePath && fs.existsSync(filePath)) { shell.openPath(filePath); return filePath; }
  src = String(src || '');
  const m = /^data:image\/(png|jpeg|jpg|gif|webp|bmp|svg\+xml);base64,(.+)$/i.exec(src);
  if (m) {
    const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase() === 'svg+xml' ? 'svg' : m[1].toLowerCase();
    const buf = Buffer.from(m[2], 'base64');
    const dir = path.join(os.tmpdir(), 'AionDX-pictures');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'picture-' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12) + '.' + ext);
    if (!fs.existsSync(f)) fs.writeFileSync(f, buf);
    shell.openPath(f);
    return f;
  }
  if (/^file:/i.test(src)) { try { const f = require('url').fileURLToPath(src); shell.openPath(f); return f; } catch (e) { return ''; } }
  if (/^https?:/i.test(src)) { shell.openExternal(src); return src; }
  return '';
}

/** Free spell checking: Chromium's own checker on the language of the PC, English as the fall-back. */
function setupSpellcheck(session, locale) {
  try {
    if (!session || typeof session.setSpellCheckerLanguages !== 'function') return;
    const have = typeof session.availableSpellCheckerLanguages !== 'undefined' ? session.availableSpellCheckerLanguages : [];
    const want = String(locale || 'en-US');
    const picks = [want, want.split('-')[0], 'en-US'].filter((l) => !have.length || have.indexOf(l) >= 0);
    session.setSpellCheckerLanguages(Array.from(new Set(picks.length ? picks.slice(0, 2) : ['en-US'])));
    if (typeof session.setSpellCheckerEnabled === 'function') session.setSpellCheckerEnabled(true);
  } catch (e) { /* no spell checker on this build */ }
}

function install(electron) {
  try {
    try { setupSpellcheck(electron.session.defaultSession, electron.app.getLocale()); } catch (e) { /* before ready: the web-contents hook below retries */ }
    electron.app.on('web-contents-created', (_event, wc) => {
      try { setupSpellcheck(wc.session, electron.app.getLocale()); } catch (e) { /* ignore */ }
      wc.on('context-menu', (_e, params) => {
        const run = async () => {
          const imagePath = params && params.mediaType === 'image' ? await askPage(wc, params.x, params.y, 400) : '';
          const undo = params && params.isEditable ? await askUndo(wc, 300) : null;
          const items = buildTemplate(params, { wc, undo, clipboard: electron.clipboard, shell: electron.shell, imagePath, openExternal: (u) => electron.shell.openExternal(u),
            openPicture: (p, src) => openPicture(electron.shell, p, src) });
          const testFile = process.env.AIONDX_MENU_TEST_FILE;
          if (testFile) {
            try { fs.appendFileSync(testFile, JSON.stringify({ labels: (items || []).map((i) => i.label || i.type || i.role), misspelled: (params && params.misspelledWord) || '', suggestions: (params && params.dictionarySuggestions) || [], image: imagePath }) + '\n'); } catch (e) { /* no log */ }
            return;
          }
          if (!items) return;
          const win = electron.BrowserWindow.fromWebContents(wc);
          electron.Menu.buildFromTemplate(items).popup(win ? { window: win } : {});
        };
        run().catch(() => {});
      });
    });
  } catch (e) { /* the menu is a convenience */ }
}

module.exports = { buildTemplate, askPage, askUndo, setupSpellcheck, install, openPicture };
