'use strict';
// play.js: plays a scripted session of the game in a headless browser and reports script errors.
// usage as module: runSession(htmlFile, 'server' | 'offline') -> { errors: [{text, line}], reached: {...} }
const { chromium } = require('playwright');
const path = require('path');

const MOCK = (text, keyId) => {
  if (/مفتاح/.test(text)) return [keyId || 'take_key'];
  if (/افتح/.test(text)) return ['open_door'];
  if (/اطلع/.test(text)) return ['exit'];
  if (/حيط/.test(text)) return ['glitch_wall'];
  return ['look'];
};

async function runSession(browser, htmlFile, mode, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  const grab = (text) => {
    const m = text.match(/index\.html:(\d+):\d+/);
    errors.push({ text: text.split('\n')[0].slice(0, 160), line: m ? +m[1] : 0, all: [...text.matchAll(/index\.html:(\d+):\d+/g)].map((x) => +x[1]) });
  };
  page.on('pageerror', (e) => grab(String(e.stack || e)));
  page.on('console', (m) => { if (m.type() === 'error' && /Error/.test(m.text())) grab(m.text()); });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith('file:')) return route.continue();
    if (u.includes('workers.dev')) {
      if (mode !== 'server') return route.abort();
      const p = new URL(u).pathname;
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      let body = { ok: true };
      if (p === '/start') body = { ok: true, run: 'r1' };
      if (p === '/turn') {
        let t = ''; try { t = JSON.parse(route.request().postData() || '{}').text || ''; } catch (e) {}
        body = { ok: true, actions: MOCK(t, opts.keyId), story: 'ok', scores: null };
      }
      return route.fulfill({ status: 200, headers: Object.assign({ 'content-type': 'application/json' }, cors), body: JSON.stringify(body) });
    }
    return route.abort();
  });

  const say = async (text) => {
    try {
      await page.fill('#cmd', text, { timeout: 1500 });
      await page.press('#cmd', 'Enter', { timeout: 1500 });
      await page.waitForFunction(() => { const b = document.getElementById('send'); return b && !b.disabled; }, null, { timeout: 2500 });
    } catch (e) { /* the game may be stuck because something was deleted; keep going */ }
  };
  const click = async (sel) => { try { await page.click(sel, { timeout: 800 }); await page.waitForTimeout(120); } catch (e) {} };

  await page.goto('file://' + path.resolve(htmlFile));
  await page.waitForTimeout(400);
  // level 1: normal win
  await click('#hint');
  await say('خذ المفتاح');
  await click('#hint'); await click('#hint');
  await say('افتح الباب');
  await say('اطلع من الباب');
  await page.waitForTimeout(1400);
  const reachedEnd = await page.evaluate(() => { const e = document.getElementById('endCard'); return !!e && !e.hidden; }).catch(() => false);
  // end card buttons: share, whatsapp, copy
  for (let i = 1; i <= 3; i++) await click('#endCard .row button:nth-child(' + i + ')');
  await click('#endCard .row button:last-child');          // next level / again
  await page.waitForTimeout(300);
  // level 2: lose by wasting moves
  for (let i = 0; i < 7; i++) await say('كلام فاضي ' + i);
  await page.waitForTimeout(1400);
  await click('#endCard .row button:last-child');
  // level strip, locked level, sound toggle, challenge-of-the-day button
  await click('#levels .lvbtn:nth-child(5)');
  await click('#levels .lvbtn:nth-child(1)');
  await click('#snd');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await ctx.close();
  return { errors, reachedEnd };
}

module.exports = { runSession };

if (require.main === module) {
  (async () => {
    const browser = await chromium.launch();
    const t0 = Date.now();
    for (const mode of ['server', 'offline']) {
      const r = await runSession(browser, process.argv[2], mode);
      console.log(mode, 'reached end card:', r.reachedEnd, 'errors:', r.errors.length, JSON.stringify(r.errors.slice(0, 5)), (Date.now() - t0) + 'ms');
    }
    await browser.close();
  })();
}
