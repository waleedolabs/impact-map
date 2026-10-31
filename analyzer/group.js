#!/usr/bin/env node
'use strict';
// group.js: turns the function graph into a small map: a few areas, each with a few parts.
// No manual work and no AI: sections the author marked in the code (banner comments) come first,
// then files, then the call links between functions decide what belongs together.
const fs = require('fs');
const path = require('path');

const MAX_AREAS = 7, MAX_LEAVES_PER_AREA = 4, MAX_ATOMS = 16;
const BANNER = /^\s*(?:\/\*+|\/\/+|#+)\s*[-=*#~_]{3,}\s*(.+?)\s*[-=*#~_]{3,}\s*(?:\*\/)?\s*$/;
const REGION = /^\s*(?:\/\/+|\/\*+)\s*#?region\s+(.+?)\s*(?:\*\/)?\s*$/i;

const AR = { storage: 'التخزين', store: 'المخزن', narrator: 'السارد', daily: 'اليومي', share: 'المشاركة', hud: 'لوحة المعلومات', route: 'التنقل', routes: 'المسارات', router: 'التوجيه', sheet: 'النافذة', end: 'النهاية', fx: 'المؤثرات', sound: 'الصوت', prompt: 'التعليمات للذكاء الاصطناعي', auth: 'الدخول', login: 'تسجيل الدخول', user: 'المستخدم', users: 'المستخدمين', db: 'قاعدة البيانات', database: 'قاعدة البيانات', api: 'الواجهة', util: 'أدوات مساعدة', utils: 'أدوات مساعدة', helpers: 'أدوات مساعدة', lib: 'المكتبة', config: 'الإعدادات', settings: 'الإعدادات', components: 'المكونات', component: 'المكوّن', pages: 'الصفحات', page: 'الصفحة', hooks: 'الخطّافات', server: 'الخادم', client: 'العميل', cart: 'السلة', payment: 'الدفع', payments: 'الدفع', checkout: 'إتمام الشراء', product: 'المنتج', products: 'المنتجات', order: 'الطلب', orders: 'الطلبات', mail: 'البريد', mailer: 'البريد', email: 'البريد', invoice: 'الفاتورة', invoices: 'الفواتير', admin: 'الإدارة', search: 'البحث', theme: 'المظهر', styles: 'التنسيق', header: 'الترويسة', footer: 'التذييل', nav: 'التنقل', layout: 'التخطيط', form: 'النموذج', forms: 'النماذج', modal: 'النافذة المنبثقة', button: 'الزر', list: 'القائمة', services: 'الخدمات', service: 'الخدمة', models: 'النماذج', model: 'النموذج', controllers: 'المتحكمات', controller: 'المتحكم', middleware: 'الوسيط', types: 'الأنواع', tests: 'الاختبارات', test: 'الاختبار', main: 'الرئيسي', index: 'الرئيسي', app: 'التطبيق', home: 'الرئيسية', dashboard: 'لوحة التحكم', profile: 'الملف الشخصي', accounts: 'الحسابات', account: 'الحساب', prices: 'الأسعار', parse: 'تحليل', parser: 'المحلّل', game: 'اللعبة', level: 'المرحلة', levels: 'المراحل', score: 'النتيجة', logging: 'السجل', log: 'السجل', cache: 'الذاكرة المؤقتة', session: 'الجلسة', notifications: 'الإشعارات', notify: 'الإشعارات', stats: 'الإحصائيات', top: 'الأعلى', bar: 'الشريط', turn: 'الدور', state: 'الحالة', ui: 'الواجهة', view: 'العرض', views: 'العروض', assets: 'الملفات', public: 'العام', scripts: 'السكربتات', docs: 'التوثيق' };
const CAPW = { NET: 'بيتصل بالإنترنت', STO: 'بيحفظ على الجهاز', FS: 'بيكتب ملفات', KEY: 'بيستعمل مفتاحاً سرياً', AI: 'بيستعمل ذكاء اصطناعي', DB: 'بيكتب على قاعدة بيانات', CLIP: 'بينسخ ويشارك', SND: 'صوت واهتزاز', EXEC: 'بيشغّل أوامر', SRV: 'بيستقبل طلبات' };

const STOP = new Set(['has', 'get', 'set', 'init', 'main', 'run', 'handle', 'helper', 'util', 'callback', 'fn', 'cb', 'then', 'done', 'btn', 'el', 'on', 'off', 'add', 'new', 'update', 'render', 'default', 'index', 'app']);
const GOOD_NAME = (n) => { const b = String(n).replace(/^.*\./, ''); return b.length >= 4 && !STOP.has(b.toLowerCase()); };
// the words that most of a group's function names share (norm, parse, render...), weighted by how used the functions are
const WSTOP = new Set(['get', 'set', 'has', 'is', 'on', 'off', 'to', 'of', 'the', 'new', 'add', 'run', 'do', 'make', 'handle', 'init', 'fn', 'cb', 'btn', 'el', 'tmp', 'val', 'res', 'req', 'obj', 'arr', 'str', 'num', 'idx', 'none', 'line', 'index', 'app', 'main', 'default', 'update', 'render', 'load', 'save', 'show', 'close', 'open', 'next', 'prev', 'apply', 'build', 'create', 'check', 'find', 'list']);
function commonWords(seg) {
  const c = {};
  for (const n of seg) { if (n.kind !== 'function') continue; const w = String(n.name).replace(/^.*\./, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9\u0600-\u06ff]+/).filter((x) => x.length >= 3 && !WSTOP.has(x)); new Set(w).forEach((x) => { c[x] = (c[x] || 0) + 1 + 0.1 * (degreeOfGlobal(n.id)); }); }
  return Object.keys(c).sort((x, y) => c[y] - c[x] || (x < y ? -1 : 1)).slice(0, 2);
}
let degreeOfGlobal = () => 0;
function humanize(s) {
  let t = String(s).replace(/\(.*?\)/g, ' ').replace(/[_\-./]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[^\p{L}\p{N} ]+/gu, ' ').trim().replace(/\s+/g, ' ');
  if (!t) return String(s);
  const words = t.split(' ').slice(0, 3);
  return words.map((w) => AR[w.toLowerCase()] || w).join(' ');
}

function groupProject(graph, root, opts) {
  opts = opts || {};
  const nodes = graph.nodes, byId = new Map(nodes.map((n) => [n.id, n]));
  const lineCache = {};
  const linesOf = (f) => lineCache[f] || (lineCache[f] = (() => { try { return fs.readFileSync(path.join(root, f), 'utf8').split('\n'); } catch (e) { return null; } })());
  const bannersOf = (f) => {
    const L = linesOf(f), out = []; if (!L) return out;
    L.forEach((l, i) => { if (l.length > 200) return; const m = BANNER.exec(l) || REGION.exec(l); if (m && /[\p{L}]/u.test(m[1])) out.push({ line: i + 1, text: m[1] }); });
    return out;
  };

  const degMap = new Map(); for (const e of graph.edges) { degMap.set(e.to, (degMap.get(e.to) || 0) + (e.n || 1)); degMap.set(e.from, (degMap.get(e.from) || 0) + 0.2 * (e.n || 1)); }
  const degreeOf = (id) => degMap.get(id) || 0;
  degreeOfGlobal = degreeOf;
  // ---- atoms: the smallest groups, from the author's own section banners, else the file
  const atoms = new Map(), atomOf = new Map();
  const base = (f) => path.posix.basename(f).replace(/\.[^.]+$/, '');
  const fnNodes = nodes.filter((n) => n.kind === 'function' || n.kind === 'data');
  const filesWithFns = [...new Set(fnNodes.map((n) => n.file))];
  for (const f of filesWithFns) {
    const topN = byId.get('top:' + f), lo = topN && topN.scriptStart ? topN.scriptStart : 0, hi = topN ? topN.end : 1e9;
    const bs = bannersOf(f).filter((x) => x.line >= lo && x.line <= hi), mine = fnNodes.filter((n) => n.file === f);
    for (const n of mine) {
      let b = null; for (const x of bs) if (x.line <= n.start) b = x;
      const label = b ? b.text.toLowerCase().replace(/\(.*?\)/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim() : '';
      const key = f + '#' + (label || '·');
      if (!atoms.has(key)) atoms.set(key, { id: key, file: f, name: b ? b.text : base(f), banner: !!b, members: [] });
      atoms.get(key).members.push(n.id); atomOf.set(n.id, key);
    }
  }
  // a stretch of code with no section banners and many functions: cut it where the fewest calls cross
  // (people write related functions next to each other, so the quietest points in the file are the section borders)
  for (const a of [...atoms.values()]) {
    if (a.banner || a.members.length < 16) continue;
    const ms = a.members.map((m) => byId.get(m)).sort((x, y) => x.start - y.start), n = ms.length, idx = new Map(ms.map((m, i) => [m.id, i]));
    const span = new Array(n + 1).fill(0);                          // span[p]: calls that cross the cut placed before function p
    for (const e of graph.edges) { const i = idx.get(e.from), j = idx.get(e.to); if (i === undefined || j === undefined || i === j) continue; const lo = Math.min(i, j), hi = Math.max(i, j); for (let p = lo + 1; p <= hi; p++) span[p] += (e.n || 1); }
    const k = Math.max(2, Math.min(6, Math.round(n / 8))), minSize = 4, cuts = [];
    const order = []; for (let p = minSize; p <= n - minSize; p++) order.push(p); order.sort((x, y) => span[x] - span[y] || x - y);
    for (const p of order) { if (cuts.length >= k - 1) break; if (cuts.every((c) => Math.abs(c - p) >= minSize)) cuts.push(p); }
    if (!cuts.length) continue; cuts.sort((x, y) => x - y);
    atoms.delete(a.id);
    let from = 0; [...cuts, n].forEach((to, gi) => {
      const seg = ms.slice(from, to); from = to; if (!seg.length) return;
      const top = commonWords(seg);
      const id = a.id + '~' + gi; atoms.set(id, { id, file: a.file, name: top.length ? top.join(' ') : a.name, banner: false, members: seg.map((x) => x.id) }); seg.forEach((x) => atomOf.set(x.id, id));
    });
  }
  if (!atoms.size) return { areas: [], stats: { atoms: 0 } };

  // routes and page-code nodes join the atom they work with
  const countAtom = (list) => { const c = {}; list.forEach((m) => { const a = atomOf.get(m); if (a) c[a] = (c[a] || 0) + 1; }); return Object.keys(c).sort((x, y) => c[y] - c[x])[0]; };
  const biggestAtomOfFile = (f) => [...atoms.values()].filter((a) => a.file === f).sort((x, y) => y.members.length - x.members.length)[0];
  for (const n of nodes) {
    if (n.kind !== 'route' && n.kind !== 'top') continue;
    let a = countAtom(graph.edges.filter((e) => e.from === n.id).map((e) => e.to));
    if (!a) a = countAtom(graph.edges.filter((e) => e.to === n.id).map((e) => e.from));
    if (!a && n.file && n.file[0] !== '(') { const b = biggestAtomOfFile(n.file); a = b && b.id; }
    if (!a) a = [...atoms.keys()][0];
    atoms.get(a).members.push(n.id); atomOf.set(n.id, a);
  }
  // anything else (should not happen) goes to the biggest atom
  for (const n of nodes) if (!atomOf.has(n.id)) { const a = [...atoms.values()].sort((x, y) => y.members.length - x.members.length)[0]; a.members.push(n.id); atomOf.set(n.id, a.id); }

  // ---- links between atoms
  const W = new Map(); const wk = (a, b) => (a < b ? a + '\u0000' + b : b + '\u0000' + a);
  for (const e of graph.edges) { const a = atomOf.get(e.from), b = atomOf.get(e.to); if (!a || !b || a === b) continue; W.set(wk(a, b), (W.get(wk(a, b)) || 0) + (e.n || 1)); }
  const sizeOf = (c) => c.members.length;
  const dirOf = (f) => path.posix.dirname(f);
  // Same scoring as before, computed fast: each group keeps its links to other groups and its folders,
  // and only pairs that share a link or a folder are compared (every other pair scores 0).
  let nextCid = 0; const dirIndex = new Map(); const byCid = new Map();
  function initClusters(list) {
    dirIndex.clear(); byCid.clear(); const atomC = new Map();
    for (const c of list) { c.cid = ++nextCid; byCid.set(c.cid, c); c.dirs = new Set([...c.files].map(dirOf)); c.nb = new Map(); for (const a of c.atoms) atomC.set(a, c);
      for (const d of c.dirs) { if (!dirIndex.has(d)) dirIndex.set(d, new Set()); dirIndex.get(d).add(c); } }
    for (const [k, w] of W) { const [a, b] = k.split('\u0000'), A = atomC.get(a), B = atomC.get(b); if (!A || !B || A === B) continue; A.nb.set(B.cid, (A.nb.get(B.cid) || 0) + w); B.nb.set(A.cid, (B.nb.get(A.cid) || 0) + w); }
    return list;
  }
  const shares = (x, y) => { const [s, l] = x.size <= y.size ? [x, y] : [y, x]; for (const v of s) if (l.has(v)) return 1; return 0; };
  function score(A, B) {   // how much two groups belong together
    const w = A.nb.get(B.cid) || 0;
    return w / Math.sqrt(sizeOf(A) * sizeOf(B)) + 0.6 * shares(A.files, B.files) + 0.2 * shares(A.dirs, B.dirs);
  }
  let clusters = initClusters([...atoms.values()].map((a) => ({ atoms: [a.id], files: new Set([a.file]), members: a.members.slice(), leaves: [a] })));

  // fold tiny groups into their closest neighbour, then cap the number of parts
  const merge = (i, j) => {
    const A = clusters[i], B = clusters[j];
    A.atoms.push(...B.atoms); B.files.forEach((f) => A.files.add(f)); A.members.push(...B.members); A.leaves.push(...B.leaves);
    for (const d of B.dirs) { A.dirs.add(d); const set = dirIndex.get(d); set.delete(B); set.add(A); }
    for (const [cid, w] of B.nb) { if (cid === A.cid) continue; A.nb.set(cid, (A.nb.get(cid) || 0) + w); const C = byCid.get(cid); C.nb.set(A.cid, (C.nb.get(A.cid) || 0) + w); C.nb.delete(B.cid); }
    A.nb.delete(B.cid); byCid.delete(B.cid); clusters.splice(j, 1);
  };
  function mergeBest(filter, limitLeaves) {
    const idx = new Map(clusters.map((c, i) => [c, i]));
    let bs = -1, bi = -1, bj = -1;
    const ok = (A, B) => filter(A, B) && !(limitLeaves && A.leaves.length + B.leaves.length > limitLeaves);
    for (let i = 0; i < clusters.length; i++) {
      const A = clusters[i], seen = new Set();
      const look = (B) => {
        const j = idx.get(B); if (j === undefined || j <= i || seen.has(j)) return; seen.add(j);
        if (!ok(A, B)) return;
        const s = score(A, B);   // same tie rule as a full scan: the first pair (smallest i, then j) with the top score
        if (s > bs || (s === bs && (i < bi || (i === bi && j < bj)))) { bs = s; bi = i; bj = j; }
      };
      for (const cid of A.nb.keys()) look(byCid.get(cid));
      for (const d of A.dirs) for (const B of dirIndex.get(d)) look(B);
    }
    if (bi < 0) {   // nothing related: like before, take the first allowed pair
      outer: for (let i = 0; i < clusters.length; i++) for (let j = i + 1; j < clusters.length; j++) if (ok(clusters[i], clusters[j])) { bi = i; bj = j; break outer; }
    }
    if (bi < 0) return false; merge(bi, bj); return true;
  }
  // 1) atoms with a single function join a neighbour (they are not worth a box of their own)
  while (clusters.filter((c) => c.members.length < 2).length && clusters.length > 1) { const tiny = (a, b) => a.members.length < 2 || b.members.length < 2; if (!mergeBest(tiny, 0)) break; }
  // 2) too many parts: merge the closest until the limit
  while (clusters.length > MAX_ATOMS) if (!mergeBest(() => true, 0)) break;
  // the parts (leaves) are the clusters we have now; areas are formed by grouping them further
  const leaves = clusters.map((c, i) => ({ id: 'l' + (i + 1), cluster: c, members: c.members, files: c.files, atoms: c.atoms, name: c.leaves.slice().sort((x, y) => y.members.length - x.members.length)[0].name }));
  let areaC = clusters.map((c, i) => ({ atoms: c.atoms.slice(), files: new Set(c.files), members: c.members.slice(), leaves: [leaves[i]] }));
  clusters = initClusters(areaC);
  while (clusters.length > MAX_AREAS) { if (!mergeBest(() => true, MAX_LEAVES_PER_AREA) && !mergeBest(() => true, MAX_LEAVES_PER_AREA + 3)) { mergeBest(() => true, 0); } }

  // ---- naming and describing
  const memberFns = (ids) => ids.map((i) => byId.get(i)).filter((n) => n && n.kind === 'function');
  const degree = new Map(); for (const e of graph.edges) { degree.set(e.to, (degree.get(e.to) || 0) + (e.n || 1)); degree.set(e.from, (degree.get(e.from) || 0) + 0.2 * (e.n || 1)); }
  function describe(ids) {
    const fns = memberFns(ids).sort((a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0));
    const caps = new Set(); ids.forEach((i) => (byId.get(i).caps || []).forEach((c) => caps.add(c)));
    const capText = Object.keys(CAPW).filter((k) => caps.has(k)).map((k) => CAPW[k]).slice(0, 3).join('، ');
    return (fns.length ? fns.length + ' دالة، أهمها: ' + fns.slice(0, 3).map((f) => f.name.replace(/^.*\./, '') + '()').join('، ') + '.' : 'بيانات أو أجزاء بدون دوال.') + (capText ? ' ' + capText + '.' : '');
  }
  const areas = clusters.map((c, i) => {
    const lv = c.leaves;
    const names = (opts.names || {});
    const leafOut = lv.map((l) => ({ id: l.id, name: (names[l.id] && names[l.id].name) || humanize(l.name), desc: (names[l.id] && names[l.id].desc) || describe(l.members), members: l.members }));
    if (lv.length === 1) return { id: 'a' + (i + 1), name: leafOut[0].name, desc: leafOut[0].desc, leaves: [], members: lv[0].members, fixedId: lv[0].id };
    const main = lv.slice().sort((x, y) => y.members.length - x.members.length)[0];
    const an = (names['a' + (i + 1)] && names['a' + (i + 1)].name) || humanize(main.name);
    return { id: 'a' + (i + 1), name: an, desc: (names['a' + (i + 1)] && names['a' + (i + 1)].desc) || lv.map((l) => humanize(l.name)).join('، '), leaves: leafOut, members: [] };
  });
  // stable, readable order: biggest first
  areas.sort((a, b) => (b.members.length + b.leaves.reduce((s, l) => s + l.members.length, 0)) - (a.members.length + a.leaves.reduce((s, l) => s + l.members.length, 0)));
  // names must be unique
  const seen = {}; const uniq = (o) => { const k = o.name; seen[k] = (seen[k] || 0) + 1; if (seen[k] > 1) o.name = k + ' ' + seen[k]; };
  areas.forEach((a) => { uniq(a); a.leaves.forEach(uniq); });
  areas.forEach((a, i) => { a.id = a.fixedId || a.id; delete a.fixedId; });
  const assigned = new Set(); areas.forEach((a) => { a.members.forEach((m) => assigned.add(m)); a.leaves.forEach((l) => l.members.forEach((m) => assigned.add(m))); });
  return { areas, stats: { atoms: atoms.size, areas: areas.length, parts: areas.reduce((s, a) => s + (a.leaves.length || 1), 0), assigned: assigned.size, total: nodes.length, withBanners: [...atoms.values()].filter((a) => a.banner).length } };
}

module.exports = { groupProject, humanize };
