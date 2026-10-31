'use strict';
// experiment_runtime.js <graph.json> <original index.html> <out.json> [concurrency]
// Deletes each function of the game for real, plays the scripted session, and compares what broke with what the map predicted.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { runSession } = require('./play.js');

const [graphFile, htmlFile, outFile, conc = '6'] = process.argv.slice(2);
const g = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
const src = fs.readFileSync(htmlFile, 'utf8').split('\n');
const fns = g.nodes.filter((n) => n.file === 'index.html' && n.kind === 'function');
const byId = new Map(g.nodes.map((n) => [n.id, n]));

function ownerAt(line) {                       // innermost named function that contains this line
  let best = null;
  for (const n of fns) if (n.start <= line && line <= n.end && (!best || n.end - n.start < best.end - best.start)) best = n;
  return best ? best.id : 'top:index.html';
}
function predictedUsers(target) {              // functions that call or pass the target on
  return new Set(g.edges.filter((e) => e.to === target.id && ['calls', 'passes', 'uses'].includes(e.how)).map((e) => e.from));
}

(async () => {
  const browser = await chromium.launch();
  const work = path.join(path.dirname(outFile), 'variants'); fs.mkdirSync(work, { recursive: true });
  const jobs = fns.map((f) => f);
  const results = [];
  let next = 0;

  async function one(f) {
    const first = src[f.start - 1] || '';
    const ok = new RegExp('^\\s*(async\\s+)?function\\s+' + f.name.replace(/\$/g, '\\$') + '\\b|^\\s*var\\s+' + f.name.replace(/\$/g, '\\$') + '\\s*=').test(first);
    if (!ok) return { id: f.id, name: f.name, skipped: 'start line is not a clean function definition' };
    const lines = src.slice();
    for (let i = f.start - 1; i <= f.end - 1; i++) lines[i] = '';   // blank, so line numbers stay the same
    const vdir = path.join(work, 'v' + f.start); fs.mkdirSync(vdir, { recursive: true });
    const file = path.join(vdir, 'index.html');
    fs.writeFileSync(file, lines.join('\n'));
    const modes = {};
    for (const mode of ['server', 'offline']) modes[mode] = await runSession(browser, file, mode);
    fs.rmSync(vdir, { recursive: true, force: true });
    const pred = predictedUsers(f);
    const seen = new Set(), other = [];
    for (const mode of Object.keys(modes)) for (const e of modes[mode].errors) {
      if (e.text.includes(f.name + ' is not defined')) seen.add(ownerAt(e.line));
      else other.push(e.text);
    }
    const unpredicted = [...seen].filter((x) => !pred.has(x) && x !== f.id);
    return {
      id: f.id, name: f.name, line: f.start,
      predicted: [...pred].map((x) => (byId.get(x) || {}).name || x),
      observed: [...seen].map((x) => (byId.get(x) || {}).name || x),
      unpredicted: unpredicted.map((x) => (byId.get(x) || {}).name || x),
      otherErrors: [...new Set(other)].slice(0, 3),
      gameReachedEnd: { server: modes.server.reachedEnd, offline: modes.offline.reachedEnd },
    };
  }

  async function worker() {
    while (next < jobs.length) {
      const f = jobs[next++];
      try { results.push(await one(f)); } catch (e) { results.push({ id: f.id, name: f.name, skipped: 'runner error: ' + e.message }); }
      fs.writeFileSync(outFile, JSON.stringify({ done: results.length, total: jobs.length, results }, null, 1));
    }
  }
  await Promise.all(Array.from({ length: +conc }, worker));
  fs.writeFileSync(outFile, JSON.stringify({ done: results.length, total: jobs.length, finished: true, results }, null, 1));
  await browser.close();
})();
