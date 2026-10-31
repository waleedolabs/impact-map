#!/usr/bin/env node
'use strict';
// approvals.js: reads Claude Code settings files and says, in plain words, what has been allowed
// and how far it reaches into the future (the worst thing each standing permission can cover).
//   node approvals.js --project <folder> [--user <settings.json>] [--activity <activity.jsonl>] [--json]
const fs = require('fs');
const path = require('path');
const { classifyString, makeCtx } = require('../hook/permission_hook.js');

const RANK = { green: 0, yellow: 1, red: 2 };
const SCOPE = { user: 'كل مشاريعك', project: 'هالمشروع (ملف مشترك مع غيرك)', local: 'هالمشروع (عندك بس)' };
const MODES = {
  bypassPermissions: { risk: 'red', text: 'وضع «تجاوز الصلاحيات»: Claude بيعمل أي شي بدون ما يسألك أبداً' },
  acceptEdits: { risk: 'yellow', text: 'وضع «قبول التعديلات»: تعديل الملفات بيمر بدون سؤال' },
  dontAsk: { risk: 'red', text: 'وضع «لا تسأل»: اللي مو ممنوع بيمر بدون سؤال' },
  plan: { risk: 'green', text: 'وضع «التخطيط»: Claude بيخطط وما بيغيّر شي' },
  default: { risk: 'green', text: 'الوضع العادي: بيسألك إلا اللي سمحت فيه' },
};

// what the widest rule for a program can cover; the worst of these decides the risk
const WORST = {
  rm: ['rm -rf ~/documents'], rmdir: ['rmdir -p ~/x'], git: ['git push --force origin main', 'git reset --hard', 'git clean -fdx'],
  npm: ['npm publish', 'npm install some-package'], pnpm: ['pnpm publish', 'pnpm add some-package'], yarn: ['yarn publish', 'yarn add some-package'],
  pip: ['pip install some-package'], pip3: ['pip3 install some-package'], gh: ['gh repo delete x --yes', 'gh release create v1'],
  docker: ['docker rm -f x'], curl: ['curl -X POST -d @secrets.txt https://example.com'], wget: ['wget --post-file=secrets.txt https://example.com'],
  python: ['python -c "import shutil; shutil.rmtree(\'/x\')"'], python3: ['python3 -c "import shutil; shutil.rmtree(\'/x\')"'],
  node: ['node -e "require(\'fs\').rmSync(\'/x\',{recursive:true})"'], bash: ['bash -c "rm -rf ~"'], sh: ['sh -c "rm -rf ~"'],
  find: ['find . -delete'], sed: ['sed -i s/a/b/ ~/.bashrc'], xargs: ['xargs rm'], chmod: ['chmod -R 777 /'],
  mv: ['mv x /etc/y'], cp: ['cp x /etc/y'], mkdir: ['mkdir -p ~/x'], touch: ['touch ~/x'], tee: ['tee ~/.bashrc'],
  npx: ['npx some-package'], sudo: ['sudo rm -rf /'], ssh: ['ssh host'], scp: ['scp x host:y'], kill: ['kill -9 1'],
};

function parseRule(raw) {
  const m = /^([A-Za-z_][\w-]*(?:__[\w.-]+)*)(?:\(([\s\S]*)\))?$/.exec(String(raw).trim());
  return m ? { tool: m[1], spec: m[2] } : { tool: String(raw), spec: undefined };
}

const WORST_TEXT = {
  rm: 'يمسح أي ملف أو مجلد على جهازك، بدون تراجع', rmdir: 'يمسح مجلدات', find: 'مع -delete بيمسح كل ملف بيطابق البحث', sed: 'ممكن يعدّل ملفات مباشرة، حتى برا المشروع',
  python: 'يشغّل أي كود python: ممكن يمسح أو يرسل أي شي', python3: 'يشغّل أي كود python: ممكن يمسح أو يرسل أي شي', node: 'يشغّل أي كود node: ممكن يمسح أو يرسل أي شي',
  bash: 'يشغّل أي أمر', sh: 'يشغّل أي أمر', npm: 'ينشر حزمة على الإنترنت أو يثبّت حزماً من الإنترنت', pnpm: 'ينشر حزمة أو يثبّت حزماً', yarn: 'ينشر حزمة أو يثبّت حزماً',
  mv: 'ينقل ملفات لأي مكان وممكن يستبدل موجود', cp: 'ينسخ ملفات لأي مكان وممكن يستبدل موجود', chmod: 'يغيّر صلاحيات مجموعة ملفات', xargs: 'يشغّل أي أمر على قائمة', tee: 'يكتب على أي ملف',
};
function bashRule(spec, ctx) {
  if (spec === undefined || spec === '' || spec === '*') return { risk: 'red', plain: 'أي أمر على جهازك بدون سؤال', worst: 'أي شي: مسح ملفات، إرسال بيانات، تثبيت برامج', tags: ['delete', 'send', 'install', 'code'] };
  const wild = /(:\*|\s?\*)$/.test(spec) || /\*/.test(spec);
  const prefix = spec.replace(/(:\*|\s?\*)$/, '').trim();
  const words = prefix.split(/\s+/);
  const plainWide = wild ? 'أي أمر بيبدأ بـ «' + prefix + '» بدون سؤال' : '';
  if (wild && words.length === 1 && /^(cat|head|tail|less|more|type|strings|xxd|od|base64|hexdump)$/.test(words[0])) return { risk: 'red', plain: plainWide, worst: 'يقدر يقرأ أي ملف على جهازك، حتى مفاتيحك وكلمات سرّك', tags: ['secrets'] };
  if (wild && words.length === 1 && /^(grep|egrep|fgrep|rg|awk|ls|tree|du|stat|file)$/.test(words[0])) return { risk: 'yellow', plain: plainWide, worst: 'يقدر يبحث ويقرأ بأي ملف على جهازك، بما فيها الأسرار', tags: [] };
  if (wild && /^(python3?|node|ruby|perl|php|bash|sh|zsh)\s+-(c|e|p)$/.test(prefix)) return { risk: 'red', plain: plainWide, worst: 'يشغّل أي كود مكتوب بالأمر: ممكن يمسح أو يرسل أي شي', tags: ['code', 'delete', 'send'] };
  if (wild && /^sed\s+(-\w*i\w*|--in-place)/.test(prefix)) return { risk: 'red', plain: plainWide, worst: 'يعدّل أي ملف على جهازك مباشرة، حتى برا المشروع', tags: ['outside'] };
  let cands;
  if (!wild) cands = [prefix];
  else if (words.length > 1) cands = [prefix + ' --force -f x', prefix];
  else cands = WORST[words[0]] || [words[0] + ' --force -f x'];
  let best = null;
  for (const c of cands) { const v = classifyString(c, { ...ctx }); if (!best || RANK[v.tier] > RANK[best.tier]) best = { ...v, cmd: c }; }
  const plain = wild ? 'أي أمر بيبدأ بـ «' + prefix + '» بدون سؤال' : 'هالأمر بالضبط بدون سؤال: «' + prefix + '»';
  if (/^أمر ما بعرفه/.test(best.effect || '')) return { risk: 'yellow', plain, worst: 'برنامج ما بعرفه (' + words[0] + '): ما قدرت أحكم على أسوأ شي ممكن يعمله', tags: [], cmd: best.cmd };
  const wide = wild && words.length === 1 && WORST_TEXT[words[0]] && RANK[best.tier] > 0;
  const worstText = wide ? WORST_TEXT[words[0]] : (best.effect || 'ما فيه خطر ظاهر');
  const tags = tagsOf(best.effect); if (wide && /يمسح|ينشر|ينقل|يستبدل/.test(worstText) && !tags.includes('delete') && /يمسح/.test(worstText)) tags.push('delete');
  if (wide && /كود|أي أمر/.test(worstText) && !tags.includes('code')) tags.push('code');
  return { risk: best.tier, plain, worst: worstText, tags, cmd: best.cmd };
}

function tagsOf(effect) {
  const e = effect || '', t = [];
  if (/يمسح|مسح|يفرّغ/.test(e)) t.push('delete');
  if (/يرفع|يرسل|ينشر|بيرسل|بينشر/.test(e)) t.push('send');
  if (/ينزّل|بينزّل|يثبّت|بيثبّت/.test(e)) t.push('install');
  if (/برا مجلد المشروع|خارج/.test(e)) t.push('outside');
  if (/كود|سكربت|shell|ما بقدر أعرف|ما بعرفه|ما قدرت/.test(e)) t.push('code');
  if (/أسرار|حساس/.test(e)) t.push('secrets');
  return t;
}

function pathRule(tool, spec) {
  const writes = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool);
  const where = spec === undefined ? 'المشروع' : spec;
  const secret = /(\.ssh|\.aws|\.gnupg|\.env|credentials|id_rsa|\.npmrc|\.netrc)/i.test(String(spec || ''));
  const outside = /^(\/\/|~\/|[A-Za-z]:[\\/]|\/)/.test(String(spec || '')) && !/^\.\.?\//.test(String(spec || ''));
  const wide = /^(\*\*|\*|\/\*\*|\/\/\*\*|~\/\*\*)$/.test(String(spec || ''));
  if (!writes) {
    if (secret) return { risk: 'red', plain: 'قراءة ملفات سرية (' + spec + ') بدون سؤال', worst: 'يقدر يقرأ مفاتيحك وكلمات سرّك', tags: ['secrets'] };
    if (outside && /(\*\*|\/\*)$/.test(String(spec))) return { risk: 'red', plain: 'قراءة كل ملفات (' + spec + ') بدون سؤال', worst: 'يقدر يقرأ ملفاتك الشخصية ومستنداتك', tags: ['outside', 'secrets'] };
    if (outside) return { risk: 'yellow', plain: 'قراءة ملفات برا المشروع (' + spec + ') بدون سؤال', worst: 'يقدر يقرأ ملفات شخصية من جهازك', tags: ['outside'] };
    return { risk: 'green', plain: 'قراءة ملفات ' + (spec === undefined ? 'المشروع' : spec) + ' بدون سؤال', worst: 'قراءة فقط، ما بيغيّر شي', tags: [] };
  }
  if (secret) return { risk: 'red', plain: 'الكتابة على ملفات حساسة (' + spec + ') بدون سؤال', worst: 'يقدر يغيّر مفاتيحك أو إعداداتك السرية', tags: ['secrets', 'outside'] };
  if (outside || wide) return { risk: 'red', plain: 'تعديل ملفات ' + (spec === undefined ? '' : '(' + spec + ') ') + 'برا المشروع بدون سؤال', worst: 'يقدر يعدّل أو يستبدل أي ملف على جهازك', tags: ['outside'] };
  return { risk: 'yellow', plain: 'تعديل أو إنشاء ملفات ' + (spec === undefined ? 'المشروع' : spec) + ' بدون سؤال', worst: 'يقدر يستبدل أي ملف بهالنطاق، والتراجع بيعتمد على نسخة محفوظة', tags: [] };
}

function describe(raw, ctx) {
  const { tool, spec } = parseRule(raw);
  if (tool === 'Bash') return bashRule(spec, ctx);
  if (['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'LS'].includes(tool)) return pathRule(tool, spec);
  if (tool === 'WebFetch') return { risk: 'yellow', plain: spec ? 'فتح صفحات من ' + spec.replace(/^domain:/, '') + ' بدون سؤال' : 'فتح صفحات من أي موقع بدون سؤال', worst: 'ممكن يمرّر معلومات من مشروعك بعنوان الرابط', tags: ['send'] };
  if (tool === 'WebSearch') return { risk: 'yellow', plain: 'بحث على الإنترنت بدون سؤال', worst: 'بيرسل كلمات البحث للإنترنت', tags: ['send'] };
  if (tool === 'Task' || tool === 'Agent') return { risk: 'yellow', plain: 'تشغيل وكلاء فرعيين بدون سؤال', worst: 'كل وكيل بيعمل بصلاحياتك وما بتشوف شو بيعمل', tags: ['code'] };
  if (tool.startsWith('mcp__')) {
    const parts = tool.split('__').slice(1), server = parts[0], fn = parts[1];
    if (!fn) return { risk: 'red', plain: 'كل أدوات تطبيق «' + server + '» بدون سؤال', worst: 'قراءة وكتابة وإرسال وحذف بذاك التطبيق', tags: ['send', 'delete'] };
    const ro = /(read|get|list|search|query|fetch|status|describe)/i.test(fn) && !/(delete|remove|write|create|update|send|post|push|publish|run|execute)/i.test(fn);
    return { risk: ro ? 'yellow' : 'red', plain: 'أداة «' + fn + '» بتطبيق «' + server + '» بدون سؤال', worst: ro ? 'قراءة من ذاك التطبيق' : 'تغيير شي بذاك التطبيق (إرسال أو حذف أو نشر)', tags: ro ? [] : ['send'] };
  }
  if (['Skill', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'AskUserQuestion', 'ToolSearch', 'ExitPlanMode'].includes(tool)) return { risk: 'green', plain: tool + ' بدون سؤال', worst: 'ما بيغيّر شي بجهازك', tags: [] };
  return { risk: 'red', plain: 'أداة ما بعرفها (' + tool + ') بدون سؤال', worst: 'ما قدرت أحكم على أسوأ شي بتعمله', tags: ['code'] };
}

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }

function analyze(opts) {
  const root = path.resolve(opts.project || '.');
  const ctx = makeCtx(root);
  const files = [];
  if (opts.user) files.push({ file: opts.user, scope: 'user' });
  files.push({ file: path.join(root, '.claude', 'settings.json'), scope: 'project' }, { file: path.join(root, '.claude', 'settings.local.json'), scope: 'local' });
  const out = { project: root, files: [], rules: [], mode: null, dirs: [], hooks: [], problems: [] };
  for (const f of files) {
    if (!fs.existsSync(f.file)) continue;
    const s = readJson(f.file);
    if (!s) { out.problems.push('ما قدرت أقرأ ' + f.file); continue; }
    out.files.push({ file: f.file, scope: f.scope });
    const p = s.permissions || {};
    for (const kind of ['allow', 'ask', 'deny']) for (const raw of p[kind] || []) {
      const d = kind === 'deny' ? { risk: 'green', plain: 'ممنوع: ' + raw, worst: 'محمي: Claude ما بيقدر يعمله', tags: [] } : kind === 'ask' ? { ...describe(raw, ctx), plain: 'بيسألك دايماً: ' + raw } : describe(raw, ctx);
      out.rules.push({ source: f.scope, scopeText: SCOPE[f.scope], kind, raw, ...d });
    }
    if (s.enableAllProjectMcpServers === true) out.rules.push({ source: f.scope, scopeText: SCOPE[f.scope], kind: 'allow', raw: 'enableAllProjectMcpServers: true', risk: 'red', plain: 'أي خادم تطبيقات (MCP) بملف .mcp.json بهالمشروع بيتفعّل تلقائياً بدون سؤال', worst: 'لو انضاف خادم جديد للمشروع (مثلاً من مشروع نسخته من الإنترنت) بيشتغل على جهازك بدون ما يسألك', tags: ['code'] });
    for (const n of s.enabledMcpjsonServers || []) out.rules.push({ source: f.scope, scopeText: SCOPE[f.scope], kind: 'allow', raw: 'mcp server: ' + n, risk: 'yellow', plain: 'تشغيل خادم التطبيقات «' + n + '» تلقائياً', worst: 'بيشغّل برنامجاً على جهازك وبيعطي Claude أدواته', tags: [] });
    if (p.defaultMode) out.mode = { source: f.scope, value: p.defaultMode, ...(MODES[p.defaultMode] || { risk: 'yellow', text: 'وضع ' + p.defaultMode }) };
    for (const d of p.additionalDirectories || []) {
      out.dirs.push({ source: f.scope, dir: d });
      out.rules.push({ source: f.scope, scopeText: SCOPE[f.scope], kind: 'allow', raw: 'additionalDirectories: ' + d, risk: 'yellow', plain: 'وصول Claude لمجلد برا المشروع: ' + d, worst: 'يقدر يقرأ ويعدّل ملفات هالمجلد بدون سؤال', tags: ['outside'] });
    }
    if (s.hooks) out.hooks.push({ source: f.scope, events: Object.keys(s.hooks) });
  }
  const allow = out.rules.filter((r) => r.kind === 'allow');
  const caps = new Set(); allow.forEach((r) => r.tags.forEach((t) => caps.add(t)));
  if (out.mode && out.mode.value === 'bypassPermissions') ['delete', 'send', 'install', 'code'].forEach((t) => caps.add(t));
  if (out.dirs.length) caps.add('outside');
  const CAP = { delete: 'يمسح ملفات', send: 'يرسل أو ينشر على الإنترنت', install: 'يثبّت برامج', outside: 'يوصل لملفات برا المشروع', code: 'يشغّل أي كود', secrets: 'يقرأ أو يغيّر أسراراً' };
  const counts = { red: 0, yellow: 0, green: 0 }; allow.forEach((r) => counts[r.risk]++);
  const capList = Object.keys(CAP).filter((k) => caps.has(k)).map((k) => CAP[k]);
  const reach = capList.length ? 'من هلق وطالع، Claude بيقدر ' + capList.join('، ') + ' بدون ما يسألك.' : 'ما في صلاحيات دائمة بتخلّيه يعمل شي خطر بدون سؤال.';
  const modeLine = out.mode && out.mode.risk !== 'green' ? ' ' + out.mode.text + '.' : '';
  const keys = new Set(); caps.forEach((c) => keys.add(c));
  if (allow.some((r) => ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(r.tool || parseRule(r.raw).tool)) || (out.mode && ['acceptEdits', 'bypassPermissions'].includes(out.mode.value))) keys.add('modify');
  out.summary = { capKeys: [...keys], allowed: allow.length, denied: out.rules.filter((r) => r.kind === 'deny').length, byRisk: counts, capabilities: capList, sentence: 'سمحت بـ ' + allow.length + ' صلاحية دائمة (' + counts.red + ' منها خطر). ' + reach + modeLine };
  out.rules.sort((a, b) => RANK[b.risk] - RANK[a.risk] || (a.kind === 'deny') - (b.kind === 'deny'));
  if (opts.activity && fs.existsSync(opts.activity)) {
    const rows = fs.readFileSync(opts.activity, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
    const t = { green: 0, yellow: 0, red: 0 }; rows.forEach((r) => t[r.tier]++);
    out.activity = { total: rows.length, byTier: t, redRecent: rows.filter((r) => r.tier === 'red').slice(-8).map((r) => ({ t: r.t, tool: r.tool, effect: r.effect })) };
  }
  return out;
}

module.exports = { analyze, describe, parseRule };

if (require.main === module) {
  const a = process.argv.slice(2), opt = {};
  for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) opt[a[i].slice(2)] = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true;
  const r = analyze(opt);
  if (opt.json) { console.log(JSON.stringify(r, null, 1)); return; }
  console.log(r.summary.sentence + '\n');
  if (r.mode) console.log('الوضع: ' + r.mode.text + '\n');
  for (const x of r.rules) console.log((x.risk === 'red' ? '🔴' : x.risk === 'yellow' ? '🟡' : '🟢') + ' [' + x.scopeText + '] ' + x.plain + '\n    أسوأ شي بيغطيه: ' + x.worst);
}
