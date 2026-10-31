'use strict';
// grouping_check.js: how close is the automatic grouping to the grouping I wrote by hand for the game?
const fs = require('fs');
const { analyzeProject } = require('../analyzer/fnmap.js'); const { groupProject } = require('../analyzer/group.js');
const root = '/home/claude/waleedolabs/glitchrun'; const g = analyzeProject(root); const r = groupProject(g, root);
const manual = fs.readFileSync('/home/claude/impact/map/build_glitch_page.js', 'utf8');
// manual leaves from the AREAS table: members are written as names (w: prefix = worker.js)
const S = (s) => s.split(/\s+/).filter(Boolean);
const AREAS = eval('(' + manual.slice(manual.indexOf('const AREAS = [') + 14, manual.indexOf('const idsFor')).trim().replace(/;$/, '') + ')');
const idsFor = (spec) => { if (spec.startsWith('route:') || spec.startsWith('top:')) return g.nodes.some((n) => n.id === spec) ? [spec] : []; if (spec === 'LEVELS') return g.nodes.filter((n) => n.kind === 'data').map((n) => n.id); const w = spec.startsWith('w:'), name = w ? spec.slice(2) : spec; return g.nodes.filter((n) => n.kind === 'function' && n.name === name && (n.file === 'worker.js') === w).map((n) => n.id); };
const manualLeaf = new Map(), manualArea = new Map(); let k = 0;
for (const a of AREAS) { const groups = a.leaves.length ? a.leaves.map((l) => l.members) : [a.members]; groups.forEach((ms) => { k++; ms.forEach((sp) => idsFor(sp).forEach((id) => { manualLeaf.set(id, 'L' + k); manualArea.set(id, a.id); })); }); }
const autoLeaf = new Map(), autoArea = new Map();
for (const a of r.areas) { const groups = a.leaves.length ? a.leaves.map((l) => ({ id: l.id, m: l.members })) : [{ id: a.id, m: a.members }]; groups.forEach((gr) => gr.m.forEach((id) => { autoLeaf.set(id, gr.id); autoArea.set(id, a.id); })); }
const fns = g.nodes.filter((n) => n.kind === 'function').map((n) => n.id).filter((id) => manualLeaf.has(id) && autoLeaf.has(id));
function pairF1(A, B) { let tp = 0, fp = 0, fn = 0; for (let i = 0; i < fns.length; i++) for (let j = i + 1; j < fns.length; j++) { const a = A.get(fns[i]) === A.get(fns[j]), b = B.get(fns[i]) === B.get(fns[j]); if (a && b) tp++; else if (b && !a) fp++; else if (a && !b) fn++; } const p = tp / (tp + fp || 1), rc = tp / (tp + fn || 1); return { precision: +p.toFixed(2), recall: +rc.toFixed(2), f1: +(2 * p * rc / (p + rc || 1)).toFixed(2) }; }
console.log('functions compared:', fns.length, '| manual parts', new Set(manualLeaf.values()).size, 'vs auto parts', new Set(autoLeaf.values()).size);
console.log('parts  (pair agreement, manual vs auto):', JSON.stringify(pairF1(manualLeaf, autoLeaf)));
console.log('areas  (pair agreement, manual vs auto):', JSON.stringify(pairF1(manualArea, autoArea)));
console.log('file split alone for reference (parts):', JSON.stringify(pairF1(manualLeaf, new Map(g.nodes.filter((n) => n.kind === 'function').map((n) => [n.id, n.file])))));
console.log('stats', JSON.stringify(r.stats));
r.areas.forEach((a) => console.log(' ', a.name, '|', a.leaves.length ? a.leaves.map((l) => l.name + '(' + l.members.length + ')').join(', ') : 'members ' + a.members.length));
