'use strict';
// file_level_check.js <project> [--only prefix/] : delete each file for real, see which other files can no longer load, compare with the map's prediction.
// Files that already fail to load before anything is deleted (missing packages, needs a browser...) are left out, so they are not counted as 'broken'.
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const { analyzeProject } = require('../analyzer/fnmap.js');
const root = path.resolve(process.argv[2]); const onlyAt = process.argv.indexOf('--only'), only = onlyAt > 0 ? process.argv[onlyAt + 1] : '';
const g = analyzeProject(root);
const files = [...new Set(g.nodes.map((n) => n.file))].filter((f) => /\.(js|cjs|mjs)$/.test(f) && !/^test\//.test(f) && !/node_modules/.test(f));
const rev = {};
for (const e of g.edges) { const a = e.from.startsWith('route:') ? (g.nodes.find((n) => n.id === e.from) || {}).file : e.from.split(':')[0] === 'top' ? e.from.slice(4) : e.from.split(':')[0]; const b = e.to.startsWith('route:') ? (g.nodes.find((n) => n.id === e.to) || {}).file : e.to.startsWith('top:') ? e.to.slice(4) : e.to.split(':')[0]; if (!a || !b || a === b || a.startsWith('(')) continue; (rev[b] = rev[b] || new Set()).add(a); }
const closure = (f) => { const out = new Set(), todo = [f]; while (todo.length) for (const d of rev[todo.pop()] || []) if (!out.has(d) && d !== f) { out.add(d); todo.push(d); } return out; };
const loads = (dir, o) => cp.spawnSync('node', ['-e', "require('./" + o + "')"], { cwd: dir, encoding: 'utf8', timeout: 20000 }).status === 0;
const okBefore = new Set(files.filter((o) => loads(root, o)));
console.log('files that load before any deletion:', okBefore.size, 'of', files.length);
let total = 0, missed = 0, false_ = 0, rows = [];
for (const f of files.filter((x) => !only || x.startsWith(only))) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chk-')), d = path.join(tmp, 'p'); fs.cpSync(root, d, { recursive: true, filter: (s) => !/\.git/.test(s) && !/node_modules/.test(path.relative(root, s)) }); if (fs.existsSync(path.join(root, 'node_modules'))) fs.symlinkSync(path.join(root, 'node_modules'), path.join(d, 'node_modules'), 'dir');
  fs.rmSync(path.join(d, f));
  const broken = new Set();
  for (const o of okBefore) { if (o === f) continue; if (!loads(d, o)) broken.add(o); }
  fs.rmSync(tmp, { recursive: true, force: true });
  const pred = closure(f); const m = [...broken].filter((x) => !pred.has(x)), fa = [...pred].filter((x) => okBefore.has(x) && !broken.has(x));
  total += broken.size; missed += m.length; false_ += fa.length; rows.push([f, broken.size, m, fa]);
}
rows.forEach((r) => console.log(r[0].padEnd(22), 'broke', r[1], r[2].length ? 'MISSED ' + r[2] : '', r[3].length ? 'false-alarm ' + r[3] : ''));
console.log('TOTAL broken files', total, '| missed by the map', missed, '| predicted but did not break', false_);
