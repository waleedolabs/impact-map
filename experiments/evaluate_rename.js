'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), { chromium } = require('playwright');
const { runSession } = require('./play.js');
(async () => {
  const dir = process.argv[2];
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), wk = fs.readFileSync(path.join(dir, 'worker.js'), 'utf8');
  const count = (s, w) => (s.match(new RegExp(w, 'g')) || []).length;
  const WL = vm.runInNewContext('(' + wk.match(/const LEVELS = (\{.*\});/)[1] + ')');
  const client = {}; let cur = null;
  html.split('\n').forEach((l) => {
    const a = l.match(/^\s*id: "(\w+)", title/); if (a) { cur = a[1]; client[cur] = []; }
    if (cur && /^\s*actions: \[\[/.test(l)) client[cur] = [...l.matchAll(/\["(\w+)",/g)].map((x) => x[1]);
  });
  const mismatches = Object.keys(WL).filter((k) => WL[k].actions.map((x) => x[0]).join() !== (client[k] || []).join());
  const keyId = (WL.room.actions.find((a) => /key/.test(a[0])) || [])[0];
  const browser = await chromium.launch(); const play = {};
  for (const mode of ['server', 'offline']) { const r = await runSession(browser, path.join(dir, 'index.html'), mode, { keyId }); play[mode] = { reachedEnd: r.reachedEnd, errors: r.errors.map((e) => e.text) }; }
  await browser.close();
  console.log(JSON.stringify({ dir, take_key: { index: count(html, 'take_key'), worker: count(wk, 'take_key') }, grab_key: { index: count(html, 'grab_key'), worker: count(wk, 'grab_key') },
    roomActionsClient: client.room, roomActionsServer: WL.room.actions.map((a) => a[0]), levelsOutOfSync: mismatches, play }, null, 1));
})();
