'use strict';
const { describe } = require('/home/claude/impact/approvals/approvals.js');
const { makeCtx } = require('/home/claude/impact/hook/permission_hook.js');
const rules = require('./rules.json'), C = require('./label_cautious.json'), P = require('./label_pragmatic.json');
const ctx = makeCtx('/home/dev/shopapp');
const RANK = { green: 0, yellow: 1, red: 2 };
const rows = [...new Set(rules)].map((raw) => { const d = describe(raw, ctx); return { raw, tool: d.risk, c: C[raw], p: P[raw], worst: d.worst }; });
const pct = (n, d) => d ? Math.round(100 * n / d) + '%' : '-';
const both = rows.filter((r) => r.c === r.p);
const lowerThanBoth = rows.filter((r) => RANK[r.tool] < Math.min(RANK[r.c], RANK[r.p]));          // tool clearly too relaxed
const lowerThanOne = rows.filter((r) => RANK[r.tool] < Math.max(RANK[r.c], RANK[r.p]) && !lowerThanBoth.includes(r));
const higherThanBoth = rows.filter((r) => RANK[r.tool] > Math.max(RANK[r.c], RANK[r.p]));
const m = (key) => { const x = {}; ['green', 'yellow', 'red'].forEach((a) => { x[a] = { green: 0, yellow: 0, red: 0 }; }); rows.forEach((r) => x[r[key]][r.tool]++); return x; };
console.log(JSON.stringify({
  n: rows.length, labelersAgree: both.length + '/' + rows.length,
  exactMatch: { cautious: rows.filter((r) => r.tool === r.c).length + '/' + rows.length, pragmatic: rows.filter((r) => r.tool === r.p).length + '/' + rows.length },
  redByTool: rows.filter((r) => r.tool === 'red').length, redByCautious: rows.filter((r) => r.c === 'red').length, redByPragmatic: rows.filter((r) => r.p === 'red').length,
  bothRed: rows.filter((r) => r.c === 'red' && r.p === 'red').length, toolRedOnThose: rows.filter((r) => r.c === 'red' && r.p === 'red' && r.tool === 'red').length,
  confusion_cautiousRow_toolCol: m('c'), confusion_pragmaticRow_toolCol: m('p'),
}, null, 1));
console.log('\n--- tool RELAXED vs BOTH labelers:'); lowerThanBoth.forEach((r) => console.log(r.raw, '| tool=' + r.tool, 'c=' + r.c, 'p=' + r.p, '|', r.worst));
console.log('\n--- tool relaxed vs one labeler:'); lowerThanOne.forEach((r) => console.log(r.raw, '| tool=' + r.tool, 'c=' + r.c, 'p=' + r.p));
console.log('\n--- tool STRICTER than both labelers:'); higherThanBoth.forEach((r) => console.log(r.raw, '| tool=' + r.tool, 'c=' + r.c, 'p=' + r.p, '|', r.worst));
