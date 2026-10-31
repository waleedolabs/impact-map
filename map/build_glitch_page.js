'use strict';
// build_glitch_page.js <graph.json> <results.json|-> <out.html>
const fs = require('fs');
const [graphFile, resFile, outFile] = process.argv.slice(2);
const g = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
const tpl = fs.readFileSync(__dirname + '/glitch-template.html', 'utf8');

const S = (s) => s.split(/\s+/).filter(Boolean);
const AREAS = [
  { id: 'loop', name: 'دورة اللعب', angle: -90, desc: 'قلب اللعبة: بيستقبل كلامك وبيشغّل كل شي بالترتيب.', leaves: [], members: S('turn send boot top:index.html') },
  { id: 'parse', name: 'فهم الأوامر', angle: -45, desc: 'بيحوّل كلامك (عربي أو فرانكو) لحركات بتفهمها اللعبة.', leaves: [
    { id: 'parse_cmd', name: 'تحليل الكلام', desc: 'تنظيف النص وتحويله لحركة.', members: S('norm frWord franco localParse parseMulti validActions sanitizeActions noneLine has') },
    { id: 'parse_ban', name: 'الكلمات الممنوعة', desc: 'كلمات اليوم الممنوعة.', members: S('dailyBanned bannedHit') } ] },
  { id: 'server', name: 'الخادم', angle: 0, desc: 'اللعبة والخادم (Cloudflare Worker): السارد الذكي والقلوب والإحصائيات.', leaves: [
    { id: 'srv_link', name: 'اتصال اللعبة', desc: 'الدوال داخل اللعبة اللي بتحكي مع الخادم.', members: S('api ev ensureRun serverTurn getPid setNarr') },
    { id: 'srv_ai', name: 'السارد الذكي', desc: 'استقبال كلامك على الخادم وسؤال الذكاء الاصطناعي.', members: S('route:/turn w:systemPrompt w:callOpenAI w:cleanReply w:c w:once w:norm') },
    { id: 'srv_count', name: 'العدّاد والقلوب', desc: 'القلوب والعدّادات والذاكرة المؤقتة والإحصائيات بالخادم.', members: S('route:/start route:/hearts route:/e route:/stats w:db w:incr w:getNum w:decr w:cachePut w:cacheGet w:sweep w:day w:num w:sign w:statsPage w:esc w:cors w:reply w:handle top:worker.js') } ] },
  { id: 'end', name: 'النهاية والمشاركة', angle: 45, desc: 'ما بعد الجولة: النتيجة، النجوم، وبطاقة المشاركة.', leaves: [
    { id: 'end_screen', name: 'شاشة النهاية', desc: 'بطاقة الفوز والخسارة وبدء جولة جديدة.', members: S('afterTurn showEnd closeEnd btn newRound') },
    { id: 'end_share', name: 'بطاقة المشاركة', desc: 'رسم البطاقة، واتساب، النسخ، وروابط التحدي.', members: S('drawCard rrect shareCard waShare copyLink done shareText siteLabel starStr keyCommand b64e b64d challengeUrl applyChallenge') } ] },
  { id: 'levels', name: 'المراحل', angle: 90, desc: 'تعريف المراحل السبع: الأحداث والثغرات والقصص.', leaves: [], members: ['LEVELS'] },
  { id: 'save', name: 'الحفظ على الجهاز', angle: 135, desc: 'ما بتتذكره اللعبة بمتصفحك: أفضل نتيجة، نجوم، أيام متتالية.', leaves: [
    { id: 'save_ls', name: 'التخزين والأيام', desc: 'القراءة والكتابة بذاكرة المتصفح.', members: S('lsGet lsSet loadPatched savePatched cacheKey cacheGet cacheSet loadBest saveBest loadStars saveStars streakNow touchDay dailyResult') } ] },
  { id: 'ui', name: 'الشاشة', angle: 180, desc: 'كل ما تشوفه: الواجهة والمؤثرات والصوت.', leaves: [
    { id: 'ui_draw', name: 'الرسم', desc: 'رسم المراحل واللوحة والرسائل.', members: S('el toBottom renderLevels updateHUD renderChips intro addThinking typeInto addTurn renderMeters trDom T $') },
    { id: 'ui_fx', name: 'المؤثرات والصوت', desc: 'الأصوات والاهتزاز والتنبيهات والألعاب النارية.', members: S('beep pulse toast nextToast burst tapeSlap buzz earn') } ] },
  { id: 'rules', name: 'قواعد اللعبة', angle: 225, desc: 'حالة الجولة وتنفيذ الحركات والربح والخسارة.', leaves: [
    { id: 'rules_state', name: 'حالة الجولة', desc: 'عدد الحركات، الثغرات المكتشفة، النجوم.', members: S('newState finalize patchedCount novelCount foundName runStars found unlocked') },
    { id: 'rules_move', name: 'تنفيذ الحركة', desc: 'تطبيق الحركة على العالم ونتيجتها.', members: S('apply applyNovel R') } ] },
];

const idsFor = (spec) => {
  if (spec.startsWith('route:') || spec.startsWith('top:')) return g.nodes.some((n) => n.id === spec) ? [spec] : [];
  if (spec === 'LEVELS') return g.nodes.filter((n) => n.kind === 'data').map((n) => n.id);
  const w = spec.startsWith('w:'), name = w ? spec.slice(2) : spec;
  return g.nodes.filter((n) => n.kind === 'function' && n.name === name && (n.file === 'worker.js') === w).map((n) => n.id);
};
const used = new Set();
const resolveMembers = (specs, where) => {
  const out = [];
  for (const sp of specs) { const ids = idsFor(sp); if (!ids.length) console.error('NO MATCH for', sp, 'in', where); ids.forEach((i) => { out.push(i); used.add(i); }); }
  return out;
};
for (const a of AREAS) {
  if (a.leaves.length) a.leaves.forEach((l) => { l.members = resolveMembers(l.members, l.id); });
  else a.members = resolveMembers(a.members, a.id);
}
const unassigned = g.nodes.filter((n) => !used.has(n.id)).map((n) => n.id);
console.error('nodes', g.nodes.length, 'assigned', used.size, 'unassigned:', unassigned);

const slim = {
  nodes: g.nodes.map((n) => ({ id: n.id, name: n.name, file: n.file, kind: n.kind, start: n.start, parent: n.parent })),
  edges: g.edges.map((e) => ({ from: e.from, to: e.to, how: e.how })),
};
const res = resFile !== '-' ? JSON.parse(fs.readFileSync(resFile, 'utf8')) : null;
let html = tpl.replace('/*GRAPH*/null', JSON.stringify(slim)).replace('/*AREAS*/null', JSON.stringify(AREAS)).replace('/*RESULTS*/null', JSON.stringify(res));
fs.writeFileSync(outFile, html);
console.error('wrote', outFile, html.length, 'bytes');
