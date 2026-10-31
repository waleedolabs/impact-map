// confidence.js: how much to trust the map's answer for one part (a function, a file, or a group of them).
// Plain ES5 on purpose: impact.js copies this function into the page, and query.js uses it from Node.
// It never makes the answer bigger or smaller; it says what the map cannot see around this part, so you know when to double-check.
function confidenceOf(G, members, lang) {
  var ar = lang !== 'en', i, j;
  if (!G._byId) { G._byId = {}; G.nodes.forEach(function (n) { G._byId[n.id] = n; }); }
  if (!G._into) { G._into = {}; G.edges.forEach(function (e) { (G._into[e.to] = G._into[e.to] || []).push(e); }); }
  var byId = G._byId, into = G._into, mine = {}, files = {}, R = [];
  members.forEach(function (m) { mine[m] = 1; var n = byId[m]; if (n && n.file && n.file.charAt(0) !== '(') files[n.file] = 1; });
  var fileList = Object.keys(files);
  function q(x) { return ar ? '«' + x + '»' : '"' + x + '"'; }
  function list(xs) { var u = xs.filter(function (x, k) { return xs.indexOf(x) === k; }); return u.slice(0, 2).map(q).join(ar ? ' و' : ' and ') + (u.length > 2 ? (ar ? ' وغيرها' : ' and others') : ''); }
  function add(level, a, e) { R.push({ level: level, text: ar ? a : e }); }

  var users = 0, passed = [], inferredFrom = [];
  function look(e) {
    if (mine[e.from]) return; var f = byId[e.from];
    if (e.how === 'inferred') inferredFrom.push(f ? f.file : e.from); else users++;
  }
  members.forEach(function (m) { (into[m] || []).forEach(function (e) {
    look(e);
    var from = byId[e.from], n = byId[m];
    // only a function handing it on counts (a callback): at the top of a file it is exporting or importing it (module.exports = { f }, const { f } = require(...))
    if (!mine[e.from] && e.how === 'passes' && !(from && from.kind === 'top')) passed.push(n ? n.name : m);
  }); });
  fileList.forEach(function (f) { (into['top:' + f] || []).forEach(look); });

  if (inferredFrom.length) add('medium', 'ملفه بيتحمّل بطريقة ديناميكية من ' + list(inferredFrom) + ' (كل ملفات مجلد)، فالروابط له مستنتجة مو مكتوبة.',
    'its file is loaded dynamically by ' + list(inferredFrom) + ' (every file in a folder), so the links to it are inferred, not written out.');
  if (passed.length) add('medium', list(passed) + ' بيتمرّر كقيمة (مثلاً دالة رد)، فمين بيشغّله فعلياً ممكن يكون أبعد من اللي بالخريطة.',
    list(passed) + ' is passed around as a value (e.g. a callback), so whoever finally runs it can be further away than the map shows.');
  var dyn = [];
  fileList.forEach(function (f) { var x = G.facts && G.facts[f]; if (x && x.dynFrom) dyn = dyn.concat(x.dynFrom); });
  if (dyn.length) add('medium', list(dyn) + ' بيوصل لدوال هون بأسماء بتنحسب وقت التشغيل (مثل obj[name])، وهالاستدعاءات ما بتبيّن بالخريطة.',
    list(dyn) + ' reaches functions here by names worked out at run time (like obj[name]); those calls do not show on the map.');
  var data = [];
  (G.dataRefs || []).forEach(function (d) {
    if (files[d.from]) return; if (inferredFrom.indexOf(d.from) >= 0) return;
    for (i = 0; i < fileList.length; i++) if (fileList[i] === d.target || fileList[i].indexOf(d.target + '/') === 0 || fileList[i].replace(/\.[^./]+$/, '') === d.target) { data.push(d.from); break; }
  });
  if (data.length) add('medium', list(data) + ' بيذكر هالملف أو مجلده بالاسم (بيقراه كبيانات أو بيشغّله)، وهالنوع من الاعتماد ما بيبيّن بالروابط.',
    list(data) + ' names this file or its folder in the code (reads it as data or runs it); that kind of dependency is not a link on the map.');
  if (G.pkg && G.pkg.main && !G.pkg.private && files[G.pkg.main]) add('medium', 'هالملف هو مدخل الحزمة (main)، فكود برا المشروع ممكن يستعمله.',
    'this file is the package entry (main), so code outside the project may use it.');
  function dir(f) { var k = f.lastIndexOf('/'); return k < 0 ? '' : f.slice(0, k); }
  // a loader that picks files by a name worked out at run time usually picks them from its own folder
  var lost = (G.problems || []).map(function (p) { return p.file; }).filter(function (f) {
    if (files[f]) return false;
    var d = dir(f); return fileList.some(function (x) { return d ? x.indexOf(d + '/') === 0 : x.indexOf('/') < 0; });
  });
  if (lost.length) {
    // only where it matters most: the map says nobody uses it, and somewhere code is loaded by a name we cannot read
    if (!users && !inferredFrom.length) add('low', 'ما في شي بالخريطة بيعتمد عليه، بس ' + list(lost) + ' بيحمّل كود باسم ما بينعرف قبل التشغيل، فممكن يكون مستعمل من هناك.',
      'nothing on the map depends on it, but ' + list(lost) + ' loads code by a name only known at run time, so it may be used from there.');
  }
  var level = 'high';
  R.forEach(function (r) { if (r.level === 'low') level = 'low'; else if (level === 'high') level = 'medium'; });
  if (!R.length) R.push({ level: 'high', text: ar ? 'كل الروابط له مكتوبة صراحة بالكود (استدعاء أو استيراد مباشر)، وما لقينا تحميل ديناميكي أو قراءة كبيانات بتوصله.'
    : 'every link to it is written out in the code (direct calls or imports); no dynamic loading or data reads reach it.' });
  return { level: level, reasons: R.slice(0, 5).map(function (r) { return r.text; }) };
}
if (typeof module !== 'undefined') module.exports = { confidenceOf: confidenceOf };
