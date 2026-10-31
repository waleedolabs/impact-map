'use strict';
const fs = require('fs');
const { decide } = require('/home/claude/impact/hook/permission_hook.js');
const C = require('./corpus_holdout.json'), L1 = require('./label_1.json'), L2 = require('./label_2.json');
const rows = C.map((c) => {
  let h; try { h = decide({ tool_name: c.tool_name, tool_input: c.tool_input, cwd: c.cwd }); } catch (e) { h = { tier: 'red', effect: 'ERROR ' + e.message }; }
  const cmd = (c.tool_input.command || c.tool_input.file_path || c.tool_input.url || c.tool_input.query || c.tool_input.pattern || '').toString().replace(/\s+/g, ' ');
  return { id: c.id, tool: c.tool_name, hook: h.tier, effect: h.effect, l1: L1[c.id], l2: L2[c.id], cmd };
});
const ask = (t) => t === 'red';
const bothRed = rows.filter((r) => r.l1 === 'red' && r.l2 === 'red');
const eitherRed = rows.filter((r) => ask(r.l1) || ask(r.l2));
const noneRed = rows.filter((r) => !ask(r.l1) && !ask(r.l2));
const gray = rows.filter((r) => ask(r.l1) !== ask(r.l2));
const pct = (n, d) => d ? Math.round(100 * n / d) + '%' : '-';
const out = {
  n: rows.length,
  interruptRate: { hook: pct(rows.filter((r) => ask(r.hook)).length, rows.length), cautiousLabeler: pct(rows.filter((r) => ask(r.l1)).length, rows.length), pragmaticLabeler: pct(rows.filter((r) => ask(r.l2)).length, rows.length) },
  labelersAgreeOnAskVsAllow: (rows.length - gray.length) + '/' + rows.length,
  bothSayRed: bothRed.length, hookAskedOnThose: bothRed.filter((r) => ask(r.hook)).length,
  eitherSaysRed: eitherRed.length, hookAskedOnThose2: eitherRed.filter((r) => ask(r.hook)).length,
  noneSayRed: noneRed.length, hookInterruptedAnyway: noneRed.filter((r) => ask(r.hook)).length,
  grayCases: gray.length,
  exactTierMatch: { cautious: rows.filter((r) => r.hook === r.l1).length + '/60', pragmatic: rows.filter((r) => r.hook === r.l2).length + '/60' },
};
console.log(JSON.stringify(out, null, 1));
console.log('\n--- MISSED (both labelers red, hook allowed):'); bothRed.filter((r) => !ask(r.hook)).forEach((r) => console.log(r.id, r.tool, r.hook, '|', r.cmd.slice(0, 110)));
console.log('\n--- MISSED by the cautious labeler only (hook allowed, cautious=red, pragmatic!=red):'); rows.filter((r) => ask(r.l1) && !ask(r.l2) && !ask(r.hook)).forEach((r) => console.log(r.id, r.tool, r.l2, '|', r.cmd.slice(0, 110)));
console.log('\n--- FALSE INTERRUPTS (neither labeler red, hook asked):'); noneRed.filter((r) => ask(r.hook)).forEach((r) => console.log(r.id, r.tool, r.l1 + '/' + r.l2, '|', r.cmd.slice(0, 90), '|', r.effect.slice(0, 80)));
console.log('\n--- gray (labelers split) and what the hook said:'); gray.forEach((r) => console.log(r.id, 'cautious=' + r.l1, 'pragmatic=' + r.l2, 'hook=' + r.hook, '|', r.cmd.slice(0, 80)));
fs.writeFileSync('holdout_rows.json', JSON.stringify(rows, null, 1));
