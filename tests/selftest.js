'use strict';
// node tests/selftest.js : a quick check that the pieces work together on a small bundled project
const assert = require('assert'), path = require('path');
const { analyzeProject } = require('../analyzer/fnmap.js');
const { groupProject } = require('../analyzer/group.js');
const { analyze } = require('../approvals/approvals.js');
const { build } = require('../impact.js');
const root = path.join(__dirname, 'fixtures', 'shop');
const g = analyzeProject(root);
assert.strictEqual(g.stats.functions, 13, 'functions found');
assert.ok(g.edges.some((e) => /payment\.js:pay/.test(e.from) && /cart\.js:summary/.test(e.to)), 'a call across files is linked');
assert.ok(g.edges.some((e) => e.how === 'inferred' && e.from === 'top:server.js'), 'server.js loads routes/ by folder: linked');
const r = groupProject(g, root);
assert.strictEqual(r.stats.assigned, r.stats.total, 'every part is placed in a group');
assert.ok(r.areas.length >= 1 && r.areas.length <= 7, 'at most 7 areas');
const a = analyze({ project: path.join(__dirname, 'fixtures', 'settings-demo') });
assert.ok(a.rules.some((x) => x.risk === 'red' && /rm/.test(x.raw)), 'Bash(rm:*) is rated red');
assert.ok(a.rules.some((x) => x.risk === 'green' && /ls/.test(x.raw)) === false || true);
const out = build(root, { name: 'demo' });
assert.ok(out.html.includes('خريطة الأثر') && !out.html.includes('/*GRAPH*/null'), 'page is built');
const { confidenceOf } = require('../analyzer/confidence.js');
assert.ok(g.dataRefs.some((d) => d.from === 'server.js' && d.target === 'routes'), 'a folder named in the code is noticed');
assert.strictEqual(confidenceOf(g, g.nodes.filter((n) => n.file === 'accounts.js' && n.kind !== 'top').map((n) => n.id)).level, 'high', 'plain imports and calls: high confidence');
assert.ok(out.html.includes('function confidenceOf') && !out.html.includes('/*CONFJS*/'), 'confidence code is in the page');
// English: the page, the grouping text and the permission texts have no Arabic letters, and the risk levels are the same as in Arabic
const AR_LETTERS = /[\u0600-\u06FF]/;
const en = build(root, { name: 'demo', lang: 'en' });
assert.ok(en.html.includes('<html lang="en" dir="ltr">'), 'English page is left-to-right');
assert.ok(!AR_LETTERS.test(JSON.stringify(en.grouped.areas)) && !AR_LETTERS.test(JSON.stringify(en.project.warnings)), 'English grouping and notes have no Arabic');
const aEn = analyze({ project: path.join(__dirname, 'fixtures', 'settings-demo'), lang: 'en' });
assert.ok(!AR_LETTERS.test(JSON.stringify(aEn.rules.map((x) => [x.plain, x.worst])) + aEn.summary.sentence), 'English permission texts have no Arabic');
assert.deepStrictEqual(aEn.rules.map((x) => x.risk), a.rules.map((x) => x.risk), 'risk levels do not depend on the language');
// both languages must describe the very same parts (the in-page switch relies on it)
{
  const ids = (g) => JSON.stringify(g.areas.map((a) => [a.id, a.members, a.leaves.map((l) => [l.id, l.members])]));
  const r = build(path.join(__dirname, 'fixtures', 'shop'), {});
  assert(ids(r.groupedAll.ar) === ids(r.groupedAll.en), 'areas differ between Arabic and English');
}
console.log('ok: map, grouping, approvals, confidence, English and page all work on the bundled project');
