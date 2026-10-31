'use strict';
// evaluate_trial.js <dir>: plays the edited game, and checks what the edit left behind.
const fs = require('fs'), path = require('path'), { chromium } = require('playwright');
const { runSession } = require('./play.js');
const { execFileSync } = require('child_process');
(async () => {
  const dir = process.argv[2], file = path.join(dir, 'index.html');
  const orig = JSON.parse(execFileSync('node', [path.join(__dirname, 'fnmap.js'), '/home/claude/waleedolabs/glitchrun']));
  const now = JSON.parse(execFileSync('node', [path.join(__dirname, 'fnmap.js'), dir]));
  const names = (g) => new Set(g.nodes.filter((n) => n.file === 'index.html' && n.kind === 'function').map((n) => n.name));
  const o = names(orig), n = names(now);
  const removed = [...o].filter((x) => !n.has(x)), added = [...n].filter((x) => !o.has(x));
  const src = fs.readFileSync(file, 'utf8');
  const dangling = removed.filter((nm) => new RegExp('(^|[^\\w$.])' + nm.replace(/\$/g, '\\$') + '\\s*\\(').test(src));
  const fx = ['beep', 'pulse', 'toast', 'nextToast', 'burst', 'tapeSlap', 'buzz', 'earn'];
  const origText = fs.readFileSync('/home/claude/waleedolabs/glitchrun/index.html', 'utf8').split('\n').length;
  const browser = await chromium.launch();
  const out = {};
  for (const mode of ['server', 'offline']) { const r = await runSession(browser, file, mode); out[mode] = { reachedEnd: r.reachedEnd, errors: r.errors.map((e) => e.text) }; }
  await browser.close();
  console.log(JSON.stringify({
    dir, linesBefore: origText, linesAfter: src.split('\n').length,
    removedFunctions: removed, addedFunctions: added,
    effectFunctionsStillDefined: fx.filter((x) => n.has(x)),
    danglingCallsToRemovedFunctions: dangling,
    play: out,
  }, null, 1));
})();
