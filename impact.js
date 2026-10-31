#!/usr/bin/env node
'use strict';
// impact.js <project-folder> [options]
// Builds ONE html page: a map of your project (parts and what depends on what), and a second map of the permissions you gave Claude.
//   --out impact-map.html     where to write the page
//   --name "My app"           name shown on the page (default: the folder name)
//   --names names.json        your own names for parts: { "a1": {"name": "...", "desc": "..."} }
//   --user-settings <file>    also read your personal Claude Code settings.json (you have to point to a copy of it yourself)
//   --approvals <file.json>   use ready-made approvals data (for demos)
//   --json graph.json         also save the raw map
const fs = require('fs');
const path = require('path');
const { analyzeProject } = require('./analyzer/fnmap.js');
const { groupProject } = require('./analyzer/group.js');
const { analyze: analyzeApprovals } = require('./approvals/approvals.js');

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith('--')) { const k = argv[i].slice(2); o[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; } else o._.push(argv[i]); }
  return o;
}
const UNSUPPORTED = /\.(py|java|kt|swift|go|rs|php|rb|cs|cpp|c|dart|scala)$/i;
function otherLanguages(root) {
  const ig = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.gradle', '__pycache__', 'venv', '.venv', 'target', 'Pods', '.idea']), c = {};
  (function w(d, depth) { let ns; try { ns = fs.readdirSync(d); } catch (e) { return; } for (const n of ns) { if (ig.has(n)) continue; const p = path.join(d, n); let st; try { st = fs.statSync(p); } catch (e) { continue; } if (st.isDirectory()) { if (depth < 6) w(p, depth + 1); } else { const m = UNSUPPORTED.exec(n); if (m) c[m[1].toLowerCase()] = (c[m[1].toLowerCase()] || 0) + 1; } } })(root, 0);
  return c;
}

function build(root, opt) {
  const name = opt.name || path.basename(root);
  const graph = analyzeProject(root);
  if (!graph.stats.functions) {
    const other = otherLanguages(root), langs = Object.keys(other);
    throw new Error('ما لقيت دوال JavaScript أو TypeScript بهالمجلد.' + (langs.length ? ' لقيت ملفات ' + langs.map((l) => l + '×' + other[l]).join(' و') + '، وهالأنواع لسا مو مدعومة.' : ' تأكد إنك أعطيت مجلد المشروع نفسه.'));
  }
  const names = opt.names ? JSON.parse(fs.readFileSync(opt.names, 'utf8')) : {};
  const grouped = groupProject(graph, root, { names });
  const warnings = [];
  if (graph.stats.skippedTypeScript) warnings.push('ما انقرأ ' + graph.stats.skippedTypeScript + ' ملف TypeScript لأنو حزمة typescript مو موجودة (شغّل npm install بالمشروع وأعد التشغيل)');
  const otherSkipped = graph.skipped.filter((s) => !/TypeScript file/.test(s.why));
  if (otherSkipped.length) warnings.push('ملفات انتخطت: ' + otherSkipped.slice(0, 3).map((s) => s.file + ' (' + s.why + ')').join('، ') + (otherSkipped.length > 3 ? ' وغيرها' : ''));
  const dyn = graph.problems.filter((p) => /variable name/.test(p.note));
  if (dyn.length) warnings.push('بعض الملفات بتحمّل كود بطريقة ما بنقدر نقراها (' + dyn.slice(0, 3).map((p) => p.file).join('، ') + ')، فالروابط منها ناقصة');
  const other = otherLanguages(root);
  if (Object.keys(other).length) warnings.push('لغات ما انقرأت: ' + Object.keys(other).map((l) => l + '×' + other[l]).join(' و'));
  warnings.push('الخريطة تقدير مبني على قراءة الكود، مو ضمان');

  // permissions: standing permissions saved by Claude Code for this project (and your personal file, only if you point to it)
  let appr;
  if (opt.approvals) appr = JSON.parse(fs.readFileSync(opt.approvals, 'utf8'));
  else {
    const a = analyzeApprovals({ project: root, user: opt['user-settings'] });
    if (a.files.length) { delete a.project; delete a.files; appr = Object.assign(a, { demo: false, label: name, note: 'هاي الصلاحيات الدائمة المحفوظة بملفات إعدادات Claude Code بس. الموافقات اللي بتضغط عليها «نعم» مرة وحدة ما بتنحفظ، فما بقدر أشوفها هون.' }); }
    else appr = { demo: false, label: name, note: 'ما لقيت ملف إعدادات Claude Code بهالمشروع (.claude/settings.local.json)، يعني ما في صلاحيات دائمة محفوظة. الموافقات اللي بتضغط عليها «نعم» مرة وحدة ما بتنحفظ.', rules: [], mode: null, dirs: [], hooks: [], summary: { capKeys: [], allowed: 0, denied: 0, byRisk: { red: 0, yellow: 0, green: 0 }, sentence: 'ما في صلاحيات دائمة محفوظة بهالمشروع.' } };
  }
  const slim = { nodes: graph.nodes.map((n) => ({ id: n.id, name: n.name, file: n.file, kind: n.kind, start: n.start, parent: n.parent, caps: n.caps })), edges: graph.edges.map((e) => ({ from: e.from, to: e.to, how: e.how })) };
  const project = { name, stats: { files: graph.stats.files, functions: graph.stats.functions, edges: graph.stats.edges, areas: grouped.stats.areas, parts: grouped.stats.parts }, warnings };
  let html = fs.readFileSync(path.join(__dirname, 'map', 'template.html'), 'utf8');
  const put = (k, v) => { html = html.split('/*' + k + '*/null').join(JSON.stringify(v).replace(/</g, '\\u003c')); };
  put('GRAPH', slim); put('AREAS', grouped.areas); put('RESULTS', null); put('APPROVALS', appr); put('PROJECT', project);
  return { html, graph, grouped, project, appr };
}

module.exports = { build };

if (require.main === module) {
  const opt = parseArgs(process.argv.slice(2));
  if (!opt._[0] || opt.help) { console.log('usage: node impact.js <project-folder> [--out impact-map.html] [--name "My app"] [--names names.json] [--user-settings settings.json] [--json graph.json]'); process.exit(opt.help ? 0 : 2); }
  const root = path.resolve(opt._[0]);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) { console.error('المجلد غير موجود: ' + root); process.exit(2); }
  try {
    const r = build(root, opt), out = path.resolve(opt.out || 'impact-map.html');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, r.html);
    if (opt.json) { fs.mkdirSync(path.dirname(path.resolve(opt.json)), { recursive: true }); fs.writeFileSync(opt.json, JSON.stringify(r.graph, null, 1)); }
    console.log('تم. الصفحة: ' + out);
    console.log('  ' + r.project.stats.files + ' ملف، ' + r.project.stats.functions + ' دالة، ' + r.project.stats.edges + ' رابط، ' + r.project.stats.areas + ' مناطق.');
    r.project.warnings.forEach((w) => console.log('  ملاحظة: ' + w));
    console.log('  افتح الملف بأي متصفح.');
  } catch (e) { console.error(e.message); process.exit(1); }
}
