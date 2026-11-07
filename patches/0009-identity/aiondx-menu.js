'use strict';
/**
 * aiondx-menu.js - the right-click menu of AionDX (patches/0009-identity). Electron asks the main process for a menu only when the page did not handle
 * the right-click itself, so AionUi's own menus (the file tree, say) are untouched. The menu has, as the target allows:
 *   a misspelled word   suggestions, "Add to dictionary"
 *   a link              Open link in browser, Copy link
 *   a picture           Copy image, Open image location
 *   a text box          Cut, Copy, Paste, Select all
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

/** The labels and actions for one right-click. deps: { wc, clipboard, shell, imagePath, openExternal }. */
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
    out.push({
      label: where ? 'Open image location' : 'Open image location (this picture has no file)',
      enabled: !!where,
      click: () => { try { deps.shell.showItemInFolder(where); } catch (e) { /* Explorer refused */ } },
    });
    sep();
  }

  if (params.isEditable) {
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
          const items = buildTemplate(params, { wc, clipboard: electron.clipboard, shell: electron.shell, imagePath, openExternal: (u) => electron.shell.openExternal(u) });
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

module.exports = { buildTemplate, askPage, setupSpellcheck, install };
