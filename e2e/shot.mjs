// Usage: node shot.mjs <steps.json>
// Steps: [{ "goto": "/path" } | { "click": "text or css" } | { "fill": [sel, text] } | { "wait": ms } | { "shot": "name" } | { "eval": "js" } | { "press": "Enter" }]
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const steps = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const out = process.env.SHOTS ?? './shots';
fs.mkdirSync(out, { recursive: true });

const state = './state.json';
const camArgs = process.env.CAMERA ? ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-video-capture=' + process.cwd() + '/qr.mjpeg'] : [];
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: camArgs });
const context = await browser.newContext({
  viewport: { width: Number(process.env.WIDTH ?? 390), height: 844 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
  colorScheme: process.env.SCHEME ?? 'light',
  permissions: process.env.CAMERA ? ['camera'] : [],
  storageState: fs.existsSync(state) && !process.env.FRESH ? state : undefined,
});
const page = await context.newPage();
const logs = [];
let dialogMode = process.env.DIALOG ?? 'dismiss';
page.on('dialog', async (d) => { logs.push('[dialog ' + d.type() + '] ' + d.message().split(String.fromCharCode(10)).join(' | ').slice(0, 160)); if (dialogMode === 'dismiss') await d.dismiss(); else if (dialogMode === 'accept') await d.accept(); else await d.accept(dialogMode); });
page.on('console', (m) => {
  if (['error', 'warning'].includes(m.type())) logs.push(`[${m.type()}] ${m.text().slice(0, 300)}`);
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message.slice(0, 300)}`));

// 8082 by default: 8081 is the dev-client server a phone may be using. Override with BASE=.
const base = process.env.BASE ?? 'http://localhost:8082';
for (const s of steps) {
  try {
    if (s.goto) await page.goto(base + s.goto, { waitUntil: 'networkidle', timeout: 90000 });
    else if (s.click) {
      const loc = s.click.startsWith('css=') ? page.locator(s.click.slice(4)) : page.getByText(s.click, { exact: !!s.exact });
      await loc.filter({ visible: true }).first().click({ timeout: 8000 });
    } else if (s.longpress) {
      const loc = page.getByText(s.longpress).filter({ visible: true }).first();
      const box = await loc.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(900);
      await page.mouse.up();
    } else if (s.tap) {
      // Click the first match that is actually on top at its centre (inactive tabs stay in the DOM).
      let done = false;
      for (const loc of await page.getByText(s.tap, { exact: !!s.exact }).all()) {
        if (!(await loc.isVisible())) continue;
        await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
        const box = await loc.boundingBox();
        if (!box || box.width === 0) continue;
        const x = box.x + box.width / 2, y = box.y + box.height / 2;
        const onTop = await loc.evaluate((el, [px, py]) => { const t = document.elementFromPoint(px, py); return !!t && (el.contains(t) || t.contains(el)); }, [x, y]);
        if (onTop) { await page.mouse.click(x, y); done = true; break; }
      }
      if (!done) throw new Error('no on-top match for ' + s.tap);
    } else if (s.drag) {
      const loc = page.getByText(s.drag[0]).filter({ visible: true }).first();
      const b = await loc.boundingBox();
      const y = b.y + b.height / 2, x0 = 60;
      await page.mouse.move(x0, y); await page.mouse.down();
      for (let i = 1; i <= 12; i++) { await page.mouse.move(x0 + (s.drag[1] * i) / 12, y); await page.waitForTimeout(16); }
      await page.mouse.up();
    } else if (s.fill) await page.locator(s.fill[0]).filter({ visible: true }).first().fill(s.fill[1], { timeout: 8000 });
    else if (s.press) await page.keyboard.press(s.press);
    else if (s.back) await page.goBack();
    else if (s.dialog) dialogMode = s.dialog;
    else if (s.wait) await page.waitForTimeout(s.wait);
    else if (s.scroll) { await page.mouse.move(195, 400); await page.mouse.wheel(0, s.scroll); }
    else if (s.eval) console.log('eval:', JSON.stringify(await page.evaluate(s.eval)));
    else if (s.shot) await page.screenshot({ path: `${out}/${s.shot}.png` });
    else if (s.text) console.log('text:', (await page.locator('body').innerText()).slice(0, s.text));
  } catch (e) {
    logs.push(`[step-fail] ${JSON.stringify(s)}: ${e.message.split('\n')[0]}`);
  }
}
await context.storageState({ path: state });
console.log(logs.length ? logs.join('\n') : 'no console errors');
await browser.close();
