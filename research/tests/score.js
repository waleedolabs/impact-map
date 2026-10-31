'use strict';
// score.js: compares the hook's tier with independent labels.
// usage: node score.js  (reads corpus_real.json, corpus_synth.json, label_A.json, label_B.json)
const fs = require('fs'), path = require('path');
const { decide } = require('../../hook/permission_hook.js');
const load = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));
const sets = { real: load('corpus_real.json'), synth: load('corpus_synth.json') };
const A = load('label_A.json'), B = load('label_B.json');
const T = ['green', 'yellow', 'red'];
const rows = [];
for (const [name, list] of Object.entries(sets)) for (const c of list) {
  let h; try { h = decide({ tool_name: c.tool_name, tool_input: c.tool_input, cwd: c.cwd }); } catch (e) { h = { tier: 'red', effect: 'ERROR ' + e.message }; }
  const a = A[c.id], b = B[c.id];
  rows.push({ set: name, id: c.id, tool: c.tool_name, hook: h.tier, effect: h.effect, a, b, intended: c.intended,
              agree: a && a === b ? a : null, cmd: (c.tool_input.command || c.tool_input.file_path || c.tool_input.url || c.tool_input.query || '').toString().replace(/\s+/g, ' ').slice(0, 110) });
}
const pct = (n, d) => (d ? Math.round((100 * n) / d) + '%' : '-');
const report = {};
for (const scope of ['real', 'synth', 'all']) {
  const R = rows.filter((r) => scope === 'all' || r.set === scope);
  const both = R.filter((r) => r.agree);
  const m = {}; T.forEach((x) => { m[x] = {}; T.forEach((y) => (m[x][y] = 0)); });
  both.forEach((r) => m[r.agree][r.hook]++);
  const exact = both.filter((r) => r.agree === r.hook).length;
  const dangerousMiss = both.filter((r) => r.agree === 'red' && r.hook !== 'red');
  const overCaution = both.filter((r) => r.agree !== 'red' && r.hook === 'red');
  const underYellow = both.filter((r) => r.agree === 'yellow' && r.hook === 'green');
  report[scope] = {
    n: R.length, labelersAgree: both.length, labelerAgreementRate: pct(both.length, R.length),
    hookMatchesConsensus: exact + '/' + both.length + ' (' + pct(exact, both.length) + ')',
    confusion_labelRow_hookCol: m,
    dangerousMisses: dangerousMiss.map((r) => r.id + ' [' + r.hook + ' but labelers red] ' + r.cmd),
    overCautionInterrupts: overCaution.length + ' of ' + both.filter((r) => r.agree !== 'red').length + ' non-red calls',
    yellowRatedGreen: underYellow.length,
    hookInterruptRate: pct(R.filter((r) => r.hook === 'red').length, R.length),
    labelersInterruptRate: pct(R.filter((r) => r.a === 'red').length, R.length) + ' / ' + pct(R.filter((r) => r.b === 'red').length, R.length),
  };
}
const generatorAgrees = rows.filter((r) => r.set === 'synth' && r.agree && r.intended).length;
report.generatorIntendedMatchesBothLabelers = rows.filter((r) => r.set === 'synth' && r.agree && r.agree === r.intended).length + '/' + generatorAgrees;
console.log(JSON.stringify(report, null, 1));
fs.writeFileSync(path.join(__dirname, 'score_rows.json'), JSON.stringify(rows, null, 1));
