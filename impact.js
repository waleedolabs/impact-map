#!/usr/bin/env node
'use strict';
// impact.js <project-folder> [options]
// Builds ONE html page: a map of your project (parts and what depends on what), and a second map of the permissions you gave Claude.
//   --out impact-map.html     where to write the page
//   --name "My app"           name shown on the page (default: the folder name)
//   --names names.json        your own names for parts: { "a1": {"name": "...", "desc": "..."} }
//   --user-settings <file>    also read your personal Claude Code settings.json (you have to point to a copy of it yourself)
//   --approvals <file.json>   use ready-made approvals data (for demos)
//   --lang ar|en|auto         language of the page and of what this tool prints (auto: Arabic on an Arabic computer, else English)
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

// language of the page and of what the tool prints: --lang ar|en|auto (auto: Arabic if the computer's language is Arabic, otherwise English)
function pickLang(v) {
  if (v === 'ar' || v === 'en') return v;
  const env = String(process.env.IMPACT_LANG || process.env.LC_ALL || process.env.LANG || '');
  let loc = ''; try { loc = Intl.DateTimeFormat().resolvedOptions().locale || ''; } catch (e) { /* keep empty */ }
  return /^ar/i.test(env) || (!env && /^ar/i.test(loc)) ? 'ar' : 'en';
}
const MSG = {
  ar: {
    nothing: 'ما لقيت دوال JavaScript أو TypeScript بهالمجلد.', foundOther: (l) => ' لقيت ملفات ' + l + '، وهالأنواع لسا مو مدعومة.', checkFolder: ' تأكد إنك أعطيت مجلد المشروع نفسه.',
    ts: (n) => 'ما انقرأ ' + n + ' ملف TypeScript لأنو حزمة typescript مو موجودة (شغّل npm install بالمشروع وأعد التشغيل)',
    skipped: (l, more) => 'ملفات انتخطت: ' + l + (more ? ' وغيرها' : ''), dyn: (l) => 'بعض الملفات بتحمّل كود بطريقة ما بنقدر نقراها (' + l + ')، فالروابط منها ناقصة',
    langs: (l) => 'لغات ما انقرأت: ' + l, estimate: 'الخريطة تقدير مبني على قراءة الكود، مو ضمان', and: ' و', comma: '، ',
    noteFound: 'هاي الصلاحيات الدائمة المحفوظة بملفات إعدادات Claude Code بس. الموافقات اللي بتضغط عليها «نعم» مرة وحدة ما بتنحفظ، فما بقدر أشوفها هون.',
    noteNone: 'ما لقيت صلاحيات محفوظة: دوّرت على .claude/settings.json و settings.local.json بمجلد المشروع وبالمجلدات اللي فوقه. إعداداتك الشخصية (بمجلد .claude عندك بالبيت) ما بقراها إلا إذا نسختها ومررتها بـ --user-settings. الموافقات اللي بتضغط عليها «نعم» مرة وحدة ما بتنحفظ.',
    noneSentence: 'ما في صلاحيات دائمة محفوظة بهالمشروع.', missingDir: 'المجلد غير موجود: ', done: 'تم. الصفحة: ',
    counts: (s) => '  ' + s.files + ' ملف، ' + s.functions + ' دالة، ' + s.edges + ' رابط، ' + s.areas + ' مناطق.', note: '  ملاحظة: ', open: '  افتح الملف بأي متصفح.',
  },
  en: {
    nothing: 'No JavaScript or TypeScript functions found in this folder.', foundOther: (l) => ' Found ' + l + ', and those languages are not supported yet.', checkFolder: ' Make sure you gave the project folder itself.',
    ts: (n) => n + ' TypeScript file(s) were not read because the typescript package is not installed (run npm install in the project and run this again)',
    skipped: (l, more) => 'Skipped files: ' + l + (more ? ' and others' : ''), dyn: (l) => 'Some files load code in a way we cannot read (' + l + '), so links from them are missing',
    langs: (l) => 'Languages not read: ' + l, estimate: 'The map is an estimate from reading the code, not a guarantee', and: ' and ', comma: ', ',
    noteFound: 'These are the standing permissions saved in Claude Code settings files only. Approvals you click "Yes" on once are not saved, so they cannot be shown here.',
    noteNone: 'No saved permissions found: I looked for .claude/settings.json and settings.local.json in the project folder and the folders above it. Your personal settings (the .claude folder in your home) are read only if you copy that file and pass it with --user-settings. Approvals you click "Yes" on once are not saved.',
    noneSentence: 'No standing permissions are saved for this project.', missingDir: 'Folder does not exist: ', done: 'Done. Page: ',
    counts: (s) => '  ' + s.files + ' files, ' + s.functions + ' functions, ' + s.edges + ' links, ' + s.areas + ' areas.', note: '  Note: ', open: '  Open the file in any browser.',
  },
};

function build(root, opt) {
  const lang = pickLang(opt.lang), M = MSG[lang];
  const name = opt.name || path.basename(root);
  const graph = analyzeProject(root);
  if (!graph.stats.functions) {
    const other = otherLanguages(root), langs = Object.keys(other);
    throw new Error(M.nothing + (langs.length ? M.foundOther(langs.map((l) => l + '×' + other[l]).join(M.and)) : M.checkFolder));
  }
  const names = opt.names ? JSON.parse(fs.readFileSync(opt.names, 'utf8')) : {};
  // the page carries both languages (the reader can switch inside the page); `lang` only decides which one it opens in
  const groupedAll = {}; for (const l of ['ar', 'en']) groupedAll[l] = groupProject(graph, root, { names, lang: l });
  const grouped = groupedAll[lang];
  const other = otherLanguages(root);
  const warningsFor = (MM) => {
    const w = [];
    if (graph.stats.skippedTypeScript) w.push(MM.ts(graph.stats.skippedTypeScript));
    const otherSkipped = graph.skipped.filter((s) => !/TypeScript file/.test(s.why));
    if (otherSkipped.length) w.push(MM.skipped(otherSkipped.slice(0, 3).map((s) => s.file + ' (' + s.why + ')').join(MM.comma), otherSkipped.length > 3));
    const dyn = graph.problems.filter((p) => /variable name/.test(p.note));
    if (dyn.length) w.push(MM.dyn(dyn.slice(0, 3).map((p) => p.file).join(MM.comma)));
    if (Object.keys(other).length) w.push(MM.langs(Object.keys(other).map((l) => l + '×' + other[l]).join(MM.and)));
    w.push(MM.estimate); return w;
  };
  const warningsAll = { ar: warningsFor(MSG.ar), en: warningsFor(MSG.en) }, warnings = warningsAll[lang];

  // permissions: standing permissions saved by Claude Code for this project (and your personal file, only if you point to it)
  const apprFor = (l) => {
    const MM = MSG[l];
    if (opt.approvals) {   // ready-made demo data; for English a sibling "<name>.en.json" is used when it exists
      let f = opt.approvals; const en = f.replace(/\.json$/, '.en.json');
      if (l === 'en' && en !== f && fs.existsSync(en)) f = en;
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    }
    const a = analyzeApprovals({ project: root, user: opt['user-settings'], lang: l });
    if (a.files.length) { delete a.project; delete a.files; return Object.assign(a, { demo: false, label: name, note: MM.noteFound }); }
    return { demo: false, label: name, note: MM.noteNone, rules: [], mode: null, dirs: [], hooks: [], summary: { capKeys: [], allowed: 0, denied: 0, byRisk: { red: 0, yellow: 0, green: 0 }, sentence: MM.noneSentence } };
  };
  const apprAll = { ar: apprFor('ar'), en: apprFor('en') }, appr = apprAll[lang];
  const slim = { nodes: graph.nodes.map((n) => ({ id: n.id, name: n.name, file: n.file, kind: n.kind, start: n.start, parent: n.parent, caps: n.caps })), edges: graph.edges.map((e) => ({ from: e.from, to: e.to, how: e.how })),
    facts: graph.facts, dataRefs: graph.dataRefs, pkg: graph.pkg, problems: graph.problems.map((p) => ({ file: p.file })) };
  const project = { name, stats: { files: graph.stats.files, functions: graph.stats.functions, edges: graph.stats.edges, areas: grouped.stats.areas, parts: grouped.stats.parts }, warnings, warningsAll, lang };
  let html = fs.readFileSync(path.join(__dirname, 'map', 'template.html'), 'utf8');
  if (lang === 'en') html = html.replace('<html lang="ar" dir="rtl">', '<html lang="en" dir="ltr">');
  const put = (k, v) => { html = html.split('/*' + k + '*/null').join(JSON.stringify(v).replace(/</g, '\\u003c')); };
  html = html.split('/*CONFJS*/').join(fs.readFileSync(path.join(__dirname, 'analyzer', 'confidence.js'), 'utf8').replace(/<\/script/gi, '<\\/script'));
  put('GRAPH', slim); put('AREAS', { ar: groupedAll.ar.areas, en: groupedAll.en.areas }); put('RESULTS', null); put('APPROVALS', apprAll); put('PROJECT', project);
  return { html, graph, grouped, groupedAll, project, appr, apprAll };
}

module.exports = { build };

if (require.main === module) {
  const opt = parseArgs(process.argv.slice(2));
  if (!opt._[0] || opt.help) { console.log('usage: node impact.js <project-folder> [--out impact-map.html] [--name "My app"] [--names names.json] [--user-settings settings.json] [--lang ar|en|auto] [--json graph.json]'); process.exit(opt.help ? 0 : 2); }
  const root = path.resolve(opt._[0]);
  const CM = MSG[pickLang(opt.lang)];
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) { console.error(CM.missingDir + root); process.exit(2); }
  try {
    const r = build(root, opt), out = path.resolve(opt.out || 'impact-map.html');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, r.html);
    if (opt.json) { fs.mkdirSync(path.dirname(path.resolve(opt.json)), { recursive: true }); fs.writeFileSync(opt.json, JSON.stringify(r.graph, null, 1)); }
    console.log(CM.done + out);
    console.log(CM.counts(r.project.stats));
    r.project.warnings.forEach((w) => console.log(CM.note + w));
    console.log(CM.open);
  } catch (e) { console.error(e.message); process.exit(1); }
}
