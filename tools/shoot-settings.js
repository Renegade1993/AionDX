'use strict';
// shoot-settings.js - photographs every Settings page of the built app (the staged one, through live-app.js, on a hidden desktop, in a
// throwaway profile), light and dark, at a set window size, and writes what each page holds (headings, labels, controls) beside the
// pictures. For the Settings makeover: the "before" set, and the "after" set with --script <edited aiondx-ui.js>.
//   node tools\shoot-settings.js --out <folder> [--script patches\0001-renderer-dx\aiondx-ui.js] [--width 1720 --height 1392] [--only <word>]
const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('./live-app');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const out = path.resolve(opt('--out', path.join(__dirname, '..', '.tmp', 'settings-shots')));
const script = opt('--script', null);
const W = +opt('--width', 1720), H = +opt('--height', 1392);
const only = opt('--only', null);

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const app = await launch({ port: 9561, deadlineMs: 600000 });
  const report = [];
  try {
    await app.send('Page.enable');
    if (script) {
      await app.overrideScript('aiondx-ui.js', path.resolve(script));
      // the voice panel's own script, from patch 0011 beside it
      const voice = path.join(path.dirname(path.resolve(script)), '..', '0011-voice', 'aiondx-voice-ui.js');
      if (fs.existsSync(voice)) await app.overrideScript('aiondx-voice-ui.js', voice);
      const mobile = path.join(path.dirname(path.resolve(script)), '..', '0020-mobile-settings', 'aiondx-mobile-settings.js');
      if (fs.existsSync(mobile)) await app.overrideScript('aiondx-mobile-settings.js', mobile);
      // the Changelog's pictures, from beside the script (the build copies them in; a staged app from before has none)
      const pics = path.join(path.dirname(path.resolve(script)), 'changelog');
      if (fs.existsSync(pics)) await app.overrideFolder('aiondx-changelog/', pics);
    }
    await app.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    for (let i = 0; i < 60; i++) { if (await app.js('!!document.querySelector("#root") && document.readyState === "complete"')) break; await sleep(500); }
    await sleep(4000);
    // a fresh profile's Welcome dialog and tip bubbles would cover the pages
    await app.js(`(() => { const s = document.createElement('style'); s.textContent = '.aiondx-welcome-backdrop,.aiondx-coach{display:none !important}.aiondx-coach-target{outline:none !important}'; document.head.appendChild(s); return 0; })()`);
    // past the Welcome screen of a fresh profile: straight to Settings
    await app.js("location.hash = '#/settings/model'; 0");
    await sleep(2500);
    const items = await app.js(`[...document.querySelectorAll('.settings-sider__item')].map((e, i) => ({ i, label: (e.textContent || '').trim(), dx: e.getAttribute('data-page') || null }))`);
    report.push('items: ' + JSON.stringify(items));
    for (const theme of ['light', 'dark']) {
      await app.js(`(() => { document.body.setAttribute('arco-theme', '${theme}'); document.documentElement.setAttribute('data-theme', '${theme}'); return 0; })()`);
      for (const it of items || []) {
        if (only && it.label.toLowerCase().indexOf(only.toLowerCase()) < 0) continue;
        await app.js(`(() => { const e = document.querySelectorAll('.settings-sider__item')[${it.i}]; if (e) e.click(); return 0; })()`);
        await sleep(1800);
        const name = (it.label || ('item' + it.i)).replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
        const shot = await app.send('Page.captureScreenshot', { format: 'png' });
        if (shot.result && shot.result.data) fs.writeFileSync(path.join(out, name + '-' + theme + '.png'), Buffer.from(shot.result.data, 'base64'));
        if (theme === 'light') {
          const what = await app.js(`(() => { const s = document.querySelector('.settings-sider'); const m = [...document.querySelectorAll('main, [class*="content"]')].find((e) => !s || (!e.contains(s) && !s.contains(e) && e.offsetWidth > 600)) || document.body;
            const t = (s) => [...m.querySelectorAll(s)].map((e) => (e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 90)).filter(Boolean);
            return { hash: location.hash, headings: t('h1,h2,h3,h4,.arco-typography,[class*="title"]').slice(0, 30), labels: t('label,.arco-form-label-item,[class*="label"]').slice(0, 60),
              selects: m.querySelectorAll('select').length, arcoSelects: m.querySelectorAll('.arco-select').length, checks: m.querySelectorAll('input[type=checkbox]').length,
              switches: m.querySelectorAll('.arco-switch').length, buttons: t('button').slice(0, 40), inputs: m.querySelectorAll('input:not([type=checkbox]),textarea').length }; })()`);
          report.push('== ' + it.label + '\n' + JSON.stringify(what, null, 1));
        }
      }
    }
    // the Changelog (under About), when this build has it
    for (const theme of ['light', 'dark']) {
      await app.js(`(() => { document.body.setAttribute('arco-theme', '${theme}'); document.documentElement.setAttribute('data-theme', '${theme}'); location.hash = '#/settings/about?aiondx=changelog'; return 0; })()`);
      await sleep(2500);
      if (await app.js(`!!document.querySelector('[data-testid="aiondx-changelog"]')`)) {
        const shot = await app.send('Page.captureScreenshot', { format: 'png' });
        if (shot.result && shot.result.data) fs.writeFileSync(path.join(out, 'changelog-' + theme + '.png'), Buffer.from(shot.result.data, 'base64'));
      }
    }
    // the About group and its pages, for the Changelog's place
    report.push('about: ' + JSON.stringify(await app.js(`[...document.querySelectorAll('.settings-sider__group-header, .settings-sider [class*="group"]')].map((e) => (e.textContent || '').trim().slice(0, 40)).slice(0, 20)`)));
  } catch (e) {
    report.push('ERROR ' + (e.stack || e.message));
  } finally {
    fs.writeFileSync(path.join(out, 'pages.txt'), report.join('\n') + '\n');
    await app.close();
  }
  console.log('shots in ' + out);
  process.exit(0);
})();
