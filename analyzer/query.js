#!/usr/bin/env node
'use strict';
// query.js <graph.json> <name-or-file> [--delete]
// Answers "what is affected if I change (or delete) this?" from the map, as plain text Claude can read out.
//   <name-or-file>: a function name, a file path, or part of either (case does not matter)
const fs = require('fs');

function load(f) { return JSON.parse(fs.readFileSync(f, 'utf8')); }

function find(g, q) {
  const s = q.toLowerCase().replace(/\\/g, '/');
  const exact = g.nodes.filter((n) => (n.kind === 'function' || n.kind === 'data') && n.name.toLowerCase() === s);
  if (exact.length) return exact;
  const file = g.nodes.filter((n) => n.file.toLowerCase() === s || n.file.toLowerCase().endsWith('/' + s));
  if (file.length) return g.nodes.filter((n) => file.some((f) => f.file === n.file) && n.kind !== 'top' && n.kind !== 'route');
  return g.nodes.filter((n) => (n.kind === 'function' || n.kind === 'data') && (n.name.toLowerCase().includes(s) || n.file.toLowerCase().includes(s))).slice(0, 12);
}

function impact(g, targets, mode) {
  const byId = new Map(g.nodes.map((n) => [n.id, n])), deps = {}, kids = {};
  g.edges.forEach((e) => (deps[e.to] = deps[e.to] || []).push(e));
  g.nodes.forEach((n) => { if (n.parent) (kids[n.parent] = kids[n.parent] || []).push(n.id); });
  const removed = new Set(targets.map((t) => t.id));
  if (mode === 'delete') { const q = [...removed]; while (q.length) for (const c of kids[q.shift()] || []) if (!removed.has(c)) { removed.add(c); q.push(c); } }
  const info = new Map(), queue = [...removed].map((id) => ({ id, d: 0 }));
  while (queue.length) {
    const c = queue.shift();
    for (const e of deps[c.id] || []) if (!removed.has(e.from) && !info.has(e.from)) { info.set(e.from, { d: c.d + 1, via: c.id, how: e.how }); queue.push({ id: e.from, d: c.d + 1 }); }
  }
  const lbl = (id) => { const n = byId.get(id); return n.kind === 'function' ? n.name + '()' : n.kind === 'top' ? 'main code of ' + n.file : n.kind === 'route' ? 'request ' + n.name : n.name; };
  const where = (id) => { const n = byId.get(id); return n.start ? n.file + ':' + n.start : n.file; };
  const direct = [], indirect = [], files = new Set();
  for (const [id, i] of info) { const n = byId.get(id); if (n.file && n.file[0] !== '(') files.add(n.file); if (n.kind === 'top') continue; (i.d === 1 ? direct : indirect).push({ id, ...i }); }
  return { removed, direct, indirect, files: [...files].sort(), lbl, where };
}

module.exports = { load, find, impact };

if (require.main === module) {
  const a = process.argv.slice(2), mode = a.includes('--delete') ? 'delete' : 'modify', pos = a.filter((x) => !x.startsWith('--'));
  if (pos.length < 2) { console.error('usage: node query.js <graph.json> <name-or-file> [--delete]'); process.exit(2); }
  const g = load(pos[0]), targets = find(g, pos[1]);
  if (!targets.length) { console.log('Nothing in the map matches "' + pos[1] + '". Try a function name or a file path.'); process.exit(0); }
  if (targets.length > 1 && !targets.every((t) => t.file === targets[0].file) && !(targets.length > 1 && /\.(js|ts|tsx|jsx|html)$/i.test(pos[1]))) {
    console.log('"' + pos[1] + '" matches several parts, be more specific:'); targets.forEach((t) => console.log('  - ' + t.name + ' (' + t.file + ':' + t.start + ')')); process.exit(0);
  }
  const r = impact(g, targets, mode);
  console.log((mode === 'delete' ? 'If you DELETE ' : 'If you CHANGE ') + targets.map((t) => t.name).slice(0, 6).join(', ') + (targets.length > 6 ? ' and ' + (targets.length - 6) + ' more' : '') + ':');
  console.log('Functions that directly depend on it (' + r.direct.length + '):'); r.direct.slice(0, 25).forEach((x) => console.log('  - ' + r.lbl(x.id) + ' (' + r.where(x.id) + ') ' + x.how + ' ' + r.lbl(x.via)));
  if (r.direct.length > 25) console.log('  ... and ' + (r.direct.length - 25) + ' more');
  console.log('May be affected further (' + r.indirect.length + '):'); r.indirect.slice(0, 15).forEach((x) => console.log('  - ' + r.lbl(x.id) + ' (' + r.where(x.id) + ')'));
  if (r.indirect.length > 15) console.log('  ... and ' + (r.indirect.length - 15) + ' more');
  console.log('Files involved (' + r.files.length + '): ' + r.files.slice(0, 20).join(', ') + (r.files.length > 20 ? ' ...' : ''));
  const c = require('./confidence.js').confidenceOf(g, [...targets.map((t) => t.id)], 'en');
  console.log('Confidence: ' + c.level.toUpperCase() + ' (' + { high: 'every link is written out in the code', medium: 'the map may miss some users, check these', low: 'the map may be missing users, check before acting' }[c.level] + ')');
  c.reasons.forEach((x) => console.log('  - ' + x));
  console.log('This is an estimate from reading the code (calls, imports, requests). Code that is loaded dynamically can be missed.');
}
