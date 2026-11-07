#!/usr/bin/env node
/**
 * test-menu.js - aiondx-menu.js (patch 0009): what the right-click menu offers for each kind of target, and what each entry does. No Electron: the
 * template builder takes everything it touches in `deps`.
 *
 *   node patches\0009-identity\test-menu.js
 */
'use strict';
const { buildTemplate, askPage, setupSpellcheck } = require('./aiondx-menu');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '   [' + String(detail).slice(0, 300) + ']')); };
const labels = (t) => (t || []).map((i) => i.label || i.type);
const log = [];
const deps = (extra) => Object.assign({
  wc: { replaceMisspelling: (s) => log.push('replace:' + s), copyImageAt: (x, y) => log.push('copyImage:' + x + ',' + y), session: { addWordToSpellCheckerDictionary: (w) => log.push('learn:' + w) } },
  clipboard: { writeText: (t) => log.push('clip:' + t) },
  shell: { showItemInFolder: (p) => log.push('show:' + p), openExternal: (u) => log.push('open:' + u) },
  imagePath: '',
}, extra || {});
const click = (t, label) => { const i = t.find((x) => x.label === label); log.length = 0; i.click(); return log.slice(); };

(async () => {
  check('nothing under the pointer: no menu', buildTemplate({}, deps()) === null);
  check('selected text: Copy', JSON.stringify(labels(buildTemplate({ selectionText: ' some words ' }, deps()))) === JSON.stringify(['Copy']));
  check('blank selection: no menu', buildTemplate({ selectionText: '   ' }, deps()) === null);
  let t = buildTemplate({ isEditable: true, editFlags: { canCut: true, canCopy: false, canPaste: true, canSelectAll: true } }, deps());
  check('a text box: Cut, Copy, Paste, a line, Select all', JSON.stringify(labels(t)) === JSON.stringify(['Cut', 'Copy', 'Paste', 'separator', 'Select all']) && t[0].enabled === true && t[1].enabled === false, JSON.stringify(labels(t)));

  t = buildTemplate({ isEditable: true, misspelledWord: 'helo', dictionarySuggestions: ['hello', 'help', 'hole', 'halo', 'hell', 'heel', 'held'], editFlags: {} }, deps());
  check('a misspelled word: up to five suggestions, Add to dictionary, then the text box entries', JSON.stringify(labels(t).slice(0, 8)) === JSON.stringify(['hello', 'help', 'hole', 'halo', 'hell', 'Add to dictionary', 'separator', 'Cut']), JSON.stringify(labels(t)));
  check('a suggestion replaces the word', JSON.stringify(click(t, 'help')) === JSON.stringify(['replace:help']));
  check('Add to dictionary teaches the word', JSON.stringify(click(t, 'Add to dictionary')) === JSON.stringify(['learn:helo']));
  t = buildTemplate({ isEditable: true, misspelledWord: 'zzqx', dictionarySuggestions: [], editFlags: {} }, deps());
  check('no suggestions says so, greyed', t[0].label === 'No suggestions' && t[0].enabled === false);
  t = buildTemplate({ isEditable: false, misspelledWord: 'helo', dictionarySuggestions: ['hello'], selectionText: 'helo' }, deps());
  check('a misspelled word outside a text box is not offered corrections', JSON.stringify(labels(t)) === JSON.stringify(['Copy']));

  t = buildTemplate({ linkURL: 'https://example.com/a?b=1', selectionText: '' }, deps());
  check('a web link: Open link in browser, Copy link', JSON.stringify(labels(t)) === JSON.stringify(['Open link in browser', 'Copy link']), JSON.stringify(labels(t)));
  check('Copy link puts the address on the clipboard', JSON.stringify(click(t, 'Copy link')) === JSON.stringify(['clip:https://example.com/a?b=1']));
  check('Open link in browser asks the system', JSON.stringify(click(t, 'Open link in browser')) === JSON.stringify(['open:https://example.com/a?b=1']));
  t = buildTemplate({ linkURL: 'mailto:someone@example.com?subject=x' }, deps());
  check('a mail link: Copy email address, with only the address', JSON.stringify(labels(t)) === JSON.stringify(['Copy email address']) && JSON.stringify(click(t, 'Copy email address')) === JSON.stringify(['clip:someone@example.com']));
  t = buildTemplate({ linkURL: 'file:///C:/x.txt' }, deps());
  check('a file link is not opened by the system from here (only copied)', JSON.stringify(labels(t)) === JSON.stringify(['Copy link']));
  t = buildTemplate({ linkURL: 'https://example.com/', selectionText: 'text', isEditable: false }, deps());
  check('a link with selected text: the link entries, a line, Copy', JSON.stringify(labels(t)) === JSON.stringify(['Open link in browser', 'Copy link', 'separator', 'Copy']));

  t = buildTemplate({ mediaType: 'image', x: 40, y: 50, srcURL: 'data:image/png;base64,AAAA' }, deps({ imagePath: 'C:\\pics\\one.png' }));
  check('a picture: Copy image, Open image location', JSON.stringify(labels(t)) === JSON.stringify(['Copy image', 'Open image location']) && t[1].enabled === true, JSON.stringify(labels(t)));
  check('Copy image copies the picture under the pointer', JSON.stringify(click(t, 'Copy image')) === JSON.stringify(['copyImage:40,50']));
  check('Open image location shows the file in its folder', JSON.stringify(click(t, 'Open image location')) === JSON.stringify(['show:C:\\pics\\one.png']));
  t = buildTemplate({ mediaType: 'image', x: 1, y: 2 }, deps());
  check('a picture with no file: the location entry is greyed and says why', t[1].enabled === false && /no file/.test(t[1].label), JSON.stringify(labels(t)));
  t = buildTemplate({ mediaType: 'image', linkURL: 'https://example.com/x', x: 1, y: 2 }, deps({ imagePath: 'C:\\a.png' }));
  check('a linked picture has both sets, link first', JSON.stringify(labels(t)) === JSON.stringify(['Open link in browser', 'Copy link', 'separator', 'Copy image', 'Open image location']), JSON.stringify(labels(t)));

  // An entry that throws (the picture went, Explorer refused) is swallowed: a menu click never breaks the app.
  t = buildTemplate({ mediaType: 'image', x: 1, y: 2 }, deps({ imagePath: 'C:\\a.png', shell: { showItemInFolder: () => { throw new Error('no'); } }, wc: { copyImageAt: () => { throw new Error('gone'); } } }));
  let threw = false; try { t[0].click(); t[1].click(); } catch (e) { threw = true; }
  check('an entry that fails does not throw', !threw);

  // The page's answer for the picture: a string, within a time limit, never an error.
  check('askPage returns the page\'s path', (await askPage({ executeJavaScript: () => Promise.resolve('C:\\x.png') }, 1, 2, 200)) === 'C:\\x.png');
  check('askPage returns nothing when the page answers late', (await askPage({ executeJavaScript: () => new Promise((r) => setTimeout(() => r('late'), 600)) }, 1, 2, 100)) === '');
  check('askPage returns nothing when the page throws', (await askPage({ executeJavaScript: () => Promise.reject(new Error('x')) }, 1, 2, 100)) === '' && (await askPage({ executeJavaScript: () => { throw new Error('y'); } }, 1, 2, 100)) === '');
  check('askPage returns nothing for a non-string answer', (await askPage({ executeJavaScript: () => Promise.resolve({ a: 1 }) }, 1, 2, 100)) === '');
  let sent = '';
  await askPage({ executeJavaScript: (code) => { sent = code; return Promise.resolve(''); } }, '12; alert(1)', 34.7, 100);
  check('the coordinates are made into whole numbers before they go into code (text that is not a number becomes 0)', /imagePathAt\(0,34\)/.test(sent) && !/alert/.test(sent), sent);

  // Spell checking: the PC's language and English, nothing when the build has no checker.
  const calls = [];
  const ses = { availableSpellCheckerLanguages: ['en-US', 'de', 'fr'], setSpellCheckerLanguages: (l) => calls.push(['langs', l.join()]), setSpellCheckerEnabled: (v) => calls.push(['on', v]) };
  setupSpellcheck(ses, 'de-DE');
  check('spelling: the PC\'s language where Chromium has it, else its base language, and English', JSON.stringify(calls) === JSON.stringify([['langs', 'de,en-US'], ['on', true]]), JSON.stringify(calls));
  calls.length = 0;
  setupSpellcheck(ses, 'ja-JP');
  check('spelling: a language it does not have falls back to English', JSON.stringify(calls[0]) === JSON.stringify(['langs', 'en-US']), JSON.stringify(calls));
  let ok = true; try { setupSpellcheck(null, 'en-US'); setupSpellcheck({}, 'en-US'); } catch (e) { ok = false; }
  check('spelling: a session with no checker is left alone', ok);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
