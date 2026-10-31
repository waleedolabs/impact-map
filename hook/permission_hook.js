#!/usr/bin/env node
'use strict';
// permission_hook.js: a Claude Code PreToolUse hook.
// Reads the tool call as JSON on stdin and answers with allow / ask.
//   green  : cannot change anything                     -> allow silently
//   yellow : changes things inside the project folder    -> allow, written to the activity log
//   red    : deletes, sends, installs, leaves the project, or cannot be understood -> ask, with a plain sentence (Arabic by default, English with lang 'en' / env IMPACT_LANG=en)
// For edits to code it also looks up the function map, so the question can say who depends on what is being changed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const RANK = { green: 0, yellow: 1, red: 2 };
const worst = (a, b) => (RANK[b.tier] > RANK[a.tier] ? b : a);
const verdict = (tier, effect) => ({ tier, effect });
// L(ctx, arabic, english): picks the text for ctx.lang ('ar' is the default; 'en' is English). Tiers never depend on the language.
const L = (ctx, ar, en) => (ctx && ctx.lang === 'en' ? en : ar);

// ---------------------------------------------------------------- paths
const HOME = os.homedir();
const SECRET = /(^|\/)(\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.config\/gcloud|\.netrc|\.npmrc|\.pypirc|\.git-credentials|id_rsa|id_ed25519|\.env(\..*)?|credentials(\.json)?|secrets?(\.\w+)?)$/i;

const isSecret = (p) => SECRET.test(String(p).replace(/\\/g, '/'));

function makePaths(root) {
  const inProject = (p) => p === root || p.startsWith(root + path.sep);
  function resolve(arg, cwd) {
    if (arg == null) return null;
    if (/[$`]/.test(arg)) return null;                // a variable or substitution: the target is unknown
    if (arg === '/dev/null') return '/dev/null';
    if (arg.startsWith('~')) arg = path.join(HOME, arg.slice(1));
    return path.resolve(cwd, arg);
  }
  return { inProject, resolve };
}

// ---------------------------------------------------------------- shell parsing
function splitShell(cmd) {
  const segs = []; let cur = '', q = null, subst = false, heredocs = [];
  let seg = { text: '', body: '' };
  const push = () => { seg.text = cur.trim(); if (seg.text) segs.push(seg); seg = { text: '', body: '' }; cur = ''; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i], n = cmd[i + 1];
    if (q === "'") { cur += c; if (c === "'") q = null; continue; }
    if (c === '\\' && n !== undefined) { cur += c + n; i++; continue; }
    if (q === '"') { if (c === '$' && n === '(' || c === '`') subst = true; cur += c; if (c === '"') q = null; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === '$' && n === '(' && cmd[i + 2] !== '(') subst = true;
    if (c === '<' && n === '(' || c === '>' && n === '(') subst = true;
    if (c === '<' && n === '<' && cmd[i + 2] !== '<') {           // here-document
      const m = /^<<-?\s*(['"]?)([A-Za-z_][\w]*)\1/.exec(cmd.slice(i));
      if (m) { heredocs.push(m[2]); cur += m[0]; i += m[0].length - 1; continue; }
    }
    if (c === '\n') {
      if (heredocs.length) {                                       // swallow the body up to its terminator
        const term = heredocs.shift(); let j = i + 1, body = '';
        while (j < cmd.length) {
          const e = cmd.indexOf('\n', j), line = cmd.slice(j, e === -1 ? cmd.length : e);
          if (line.trim() === term) { j = e === -1 ? cmd.length : e; break; }
          body += line + '\n'; j = e === -1 ? cmd.length : e + 1;
        }
        seg.body += body; i = j; continue;
      }
      push(); continue;
    }
    if ((c === '&' && n === '&') || (c === '|' && n === '|')) { push(); i++; continue; }
    if (c === ';' || (c === '|') ) { push(); continue; }
    if (c === '&' && n !== '>' && cmd[i - 1] !== '>' && cmd[i - 1] !== '&') { push(); continue; }
    cur += c;
  }
  push();
  return { segs, subst };
}

function words(text) {
  const out = []; let cur = '', q = null, has = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q === "'") { if (c === "'") q = null; else cur += c; continue; }
    if (q === '"') { if (c === '\\' && text[i + 1] !== undefined) { cur += text[++i]; continue; } if (c === '"') q = null; else cur += c; continue; }
    if (c === "'" || c === '"') { q = c; has = true; continue; }
    if (c === '\\' && text[i + 1] !== undefined) { cur += text[++i]; has = true; continue; }
    if (/\s/.test(c)) { if (cur || has) out.push(cur); cur = ''; has = false; continue; }
    cur += c; has = true;
  }
  if (cur || has) out.push(cur);
  return out;
}

function takeRedirects(ws) {
  const rest = [], targets = [];
  for (let i = 0; i < ws.length; i++) {
    const m = /^(\d*|&)(>>?|>\|)(.*)$/.exec(ws[i]);
    if (m) {
      let t = m[3];
      if (!t) t = ws[++i];
      if (t && !t.startsWith('&')) targets.push(t);
      continue;
    }
    if (/^\d*<$/.test(ws[i])) { i++; continue; }
    if (/^<[^<(]/.test(ws[i])) continue;
    rest.push(ws[i]);
  }
  return { rest, targets };
}

// ---------------------------------------------------------------- command tables
const READ_ONLY = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'echo', 'printf', 'true', 'false', 'date', 'whoami', 'which', 'type', 'file', 'stat', 'du', 'df', 'tree', 'diff', 'cmp', 'sort', 'uniq', 'cut', 'tr', 'grep', 'egrep', 'fgrep', 'rg', 'basename', 'dirname', 'realpath', 'readlink', 'printenv', 'uname', 'id', 'hostname', 'sleep', 'test', '[', 'sha256sum', 'sha1sum', 'md5sum', 'base64', 'ps', 'nproc', 'free', 'column', 'fold', 'nl', 'od', 'xxd', 'hexdump', 'strings', 'less', 'more', 'jq', 'yq', 'seq', 'expr', 'comm', 'paste', 'join', 'tac', 'rev', 'cd', 'env', 'locale', 'lscpu', 'uptime', 'git-status', 'wait', 'export', 'set', 'unset', 'alias', 'exit', ':']);
const WRITERS = new Set(['mkdir', 'touch', 'cp', 'mv', 'ln', 'install', 'tee', 'truncate', 'chmod', 'dd']);
const DELETERS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'trash', 'trash-put']);
const NETWORK = new Set(['ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'netcat', 'ftp', 'telnet', 'socat', 'nmap']);
const SYSTEM = new Set(['sudo', 'su', 'doas', 'kill', 'pkill', 'killall', 'mount', 'umount', 'mkfs', 'fdisk', 'parted', 'systemctl', 'service', 'crontab', 'chown', 'chgrp', 'useradd', 'usermod', 'passwd', 'reboot', 'shutdown', 'halt', 'iptables', 'ufw', 'sysctl', 'docker', 'podman', 'kubectl', 'helm', 'terraform', 'aws', 'gcloud', 'az', 'gsutil', 'bq', 'eval', 'source', '.']);
const INSTALLERS = new Set(['apt', 'apt-get', 'dpkg', 'yum', 'dnf', 'brew', 'snap', 'pacman', 'apk', 'conda', 'mamba', 'gem', 'bundle']);
const RISKY_CODE = /(\bunlink\w*\(|\brmSync\b|\brmdirSync\b|\bfs\.rm\(|\brmtree\b|os\.(remove|unlink|rmdir)\b|requests\.(post|put|delete|patch)\b|urllib\.request|\bsocket\b|\bsmtplib\b|\bftplib\b|\bhttps?\.(request|get)\(|\bfetch\(\s*['"`]https?:\/\/(?!localhost|127\.)|['"`]\s*(rm\s+-|curl\s|wget\s|sudo\s|ssh\s|scp\s|dd\s+if=|mkfs)|\bpython\d?\s+-c\b.*\bos\.system|\bchild_process\b[^;\n]*\b(rm|curl|wget|sudo|ssh|scp)\b|\beval\(|__import__)/;
const WRITE_CODE = /(writeFile|appendFile|createWriteStream|\.write\(|open\([^)]*['"][wa]b?\+?['"]|mkdir|copyFile|rename|\.save\()/;
function outsideWrite(code, ctx) {
  if (!WRITE_CODE.test(code)) return null;
  for (const m of code.matchAll(/['"`](\/[^'"`\s]+|~\/[^'"`\s]*)['"`]/g)) {
    const p = ctx.P.resolve(m[1], ctx.cwd);
    if (p && p !== '/dev/null' && !ctx.P.inProject(p) && !/^\/(usr|opt|lib|bin|proc|sys)\b/.test(p) && (p.split('/').length >= 3 || /^\/(tmp|etc|var|root|home)\b/.test(p))) return p;
    if (p && isSecret(p)) return p;
  }
  return null;
}

const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', 'rev-list', 'cat-file', 'ls-tree', 'reflog', 'grep', 'whatchanged', 'var', 'version', '--version', 'help']);
const GIT_LOCAL_WRITE = new Set(['add', 'commit', 'stash', 'mv', 'tag', 'init', 'switch', 'merge', 'cherry-pick', 'apply', 'am', 'notes', 'worktree', 'submodule']);
const GIT_DANGER = new Set(['push', 'clean', 'gc', 'prune', 'filter-branch', 'update-ref', 'rebase', 'pull', 'fetch', 'clone', 'remote']);

function pathArgs(ws, skipFlags = true) { return ws.slice(1).filter((w) => !(skipFlags && w.startsWith('-'))); }

function classifyOne(ws, ctx, body) {
  if (!ws.length) return verdict('green', '');
  // wrappers and assignments
  let i = 0;
  while (i < ws.length && /^[A-Za-z_]\w*=/.test(ws[i])) i++;
  ws = ws.slice(i);
  if (!ws.length) return verdict('green', L(ctx, 'ضبط متغيّر', 'setting a variable'));
  const wrap = ['nohup', 'time', 'command', 'nice', 'ionice', 'stdbuf', 'setsid', 'unbuffer'];
  while (wrap.includes(ws[0])) ws = ws.slice(1);
  if (ws[0] === 'timeout') ws = ws.slice(/^\d/.test(ws[1] || '') ? 2 : 1);
  if (ws[0] === 'env') { let k = 1; while (k < ws.length && (/^[A-Za-z_]\w*=/.test(ws[k]) || ws[k].startsWith('-'))) k++; ws = ws.slice(k); if (!ws.length) return verdict('green', ''); }
  if (!ws.length) return verdict('green', '');
  const cmd = path.basename(ws[0]), args = ws.slice(1), P = ctx.P;

  if (cmd === 'cd') { const t = P.resolve(args[0] || HOME, ctx.cwd); if (t) ctx.cwd = t; return verdict('green', L(ctx, 'تغيير المجلد الحالي', 'changing the current folder')); }
  if (SYSTEM.has(cmd)) return verdict('red', L(ctx, cmd === 'sudo' || cmd === 'su' || cmd === 'doas' ? 'بيشغّل أمراً بصلاحيات المدير' : cmd === 'kill' || cmd === 'pkill' || cmd === 'killall' ? 'بيوقف برنامجاً شغّالاً' : cmd === 'eval' || cmd === 'source' || cmd === '.' ? 'بيشغّل نصاً ما بقدر أعرف شو فيه' : 'بيغيّر إعدادات النظام أو بيشغّل خدمة (' + cmd + ')',
    cmd === 'sudo' || cmd === 'su' || cmd === 'doas' ? 'runs a command with admin rights' : cmd === 'kill' || cmd === 'pkill' || cmd === 'killall' ? 'stops a running program' : cmd === 'eval' || cmd === 'source' || cmd === '.' ? 'runs text whose contents I cannot see' : 'changes system settings or runs a service (' + cmd + ')'));
  if (INSTALLERS.has(cmd)) return verdict('red', L(ctx, 'بينزّل ويثبّت برامج على الجهاز (' + cmd + ')', 'downloads and installs programs on this machine (' + cmd + ')'));
  if (NETWORK.has(cmd)) return verdict('red', L(ctx, 'بيتصل بجهاز آخر عبر الشبكة (' + cmd + ')', 'connects to another machine over the network (' + cmd + ')'));
  if (DELETERS.has(cmd)) return deleteVerdict(cmd, args, ctx);

  if (cmd === 'find') {
    if (args.includes('-delete')) return verdict('red', L(ctx, 'بيمسح كل ملف بيطابق شرط البحث', 'deletes every file that matches the search'));
    if (args.some((a) => a.startsWith('-fprint') || a === '-fls')) return verdict('red', L(ctx, 'بيكتب نتيجة البحث بملف', 'writes the search results to a file'));
    const ei = args.findIndex((a) => ['-exec', '-execdir', '-ok', '-okdir'].includes(a));
    if (ei >= 0) {
      const inner = []; let j = ei + 1;
      while (j < args.length && args[j] !== ';' && args[j] !== '+') inner.push(args[j++] === '{}' ? './__f__' : args[j - 1]);
      const iv = classifyOne(inner, ctx, '');
      return iv.tier === 'green' ? verdict('green', L(ctx, 'بحث وتنفيذ أمر قراءة على النتائج', 'searching and running a read-only command on the results')) : verdict('red', L(ctx, 'بيشغّل أمراً على كل ملف بيلاقيه: ', 'runs a command on every file it finds: ') + iv.effect);
    }
    return verdict('green', L(ctx, 'بحث عن ملفات', 'searching for files'));
  }
  if (cmd === 'sed') {
    const inplace = args.some((a) => a === '-i' || a.startsWith('-i') || a === '--in-place' || /^-[a-zA-Z]*i/.test(a));
    if (!inplace) return verdict('green', L(ctx, 'قراءة وتعديل نص على الشاشة فقط', 'reading and changing text on screen only'));
    const files = args.filter((a) => !a.startsWith('-')).slice(1);
    return pathsVerdict(L(ctx, 'بيعدّل ملفات مباشرة', 'edits files in place'), files, ctx);
  }
  if (cmd === 'awk' || cmd === 'gawk') return /system\(|>\s*["'\w$]|\|\s*["']?\w/.test(args.join(' ')) ? verdict('red', L(ctx, 'برنامج awk بيكتب أو بيشغّل أوامر', 'the awk program writes files or runs commands')) : verdict('green', L(ctx, 'معالجة نص', 'processing text'));
  if (cmd === 'xargs') {
    const inner = args.filter((a, k) => !(a.startsWith('-') && k === 0));
    let k = 0; while (k < args.length && args[k].startsWith('-')) { if (['-I', '-n', '-P', '-d', '-L', '-s'].includes(args[k])) k++; k++; }
    return worst(verdict('yellow', L(ctx, 'بيشغّل أمراً على قائمة', 'runs a command on a list')), classifyOne(args.slice(k), ctx, body));
  }
  if (cmd === 'bash' || cmd === 'sh' || cmd === 'zsh') {
    const ci = args.indexOf('-c');
    if (ci >= 0 && args[ci + 1] !== undefined) return classifyString(args[ci + 1], ctx);
    if (args.length && !args[0].startsWith('-')) return scriptVerdict(args[0], ctx);
    return verdict('red', L(ctx, 'بيفتح جلسة أوامر ما بقدر أتوقع شو رح يصير فيها', 'opens a command session, and I cannot predict what will happen in it'));
  }
  if (cmd === 'git') return gitVerdict(args, ctx);
  if (cmd === 'curl' || cmd === 'wget') return netVerdict(cmd, args, ctx);
  if (cmd === 'chmod') {
    if (args.some((a) => /^-[a-zA-Z]*R/.test(a) || a === '--recursive') || args.some((a) => /^[0-7]*777$/.test(a) || /^(a|ugo)?\+w/.test(a))) return verdict('red', L(ctx, 'بيغيّر صلاحيات مجموعة ملفات أو بيعطي الكل حق الكتابة', 'changes permissions on a group of files or lets everyone write to them'));
    return pathsVerdict(L(ctx, 'بيغيّر صلاحيات ملف', 'changes the permissions of a file'), args.filter((a) => !a.startsWith('-') && !/^[0-7+\-=ugoarwxXst,]+$/.test(a)), ctx);
  }
  if (cmd === 'dd') return verdict('red', L(ctx, 'dd بيكتب مباشرة على ملفات أو أجهزة', 'dd writes directly to files or devices'));
  if (cmd === 'tee') { const f = args.filter((a) => !a.startsWith('-')); return f.length ? pathsVerdict(L(ctx, 'بيكتب ملفاً', 'writes a file'), f, ctx) : verdict('green', L(ctx, 'نسخ الناتج على الشاشة', 'copying the output to the screen')); }
  if (WRITERS.has(cmd)) {
    const f = pathArgs(ws);
    const label = L(ctx, { mkdir: 'بيعمل مجلدات', touch: 'بيعمل ملفات فاضية أو بيحدّث وقتها', cp: 'بينسخ ملفات (ممكن يستبدل موجود)', mv: 'بينقل ملفات أو بيعيد تسميتها (ممكن يستبدل موجود)', ln: 'بيعمل اختصاراً لملف', install: 'بينسخ ملفات', truncate: 'بيقصّ محتوى ملف' }[cmd] || 'بيكتب ملفات',
      { mkdir: 'creates folders', touch: 'creates empty files or updates their timestamps', cp: 'copies files (may overwrite existing ones)', mv: 'moves or renames files (may overwrite existing ones)', ln: 'creates a link to a file', install: 'copies files', truncate: 'cuts a file down' }[cmd] || 'writes files');
    return pathsVerdict(label, f, ctx);
  }
  if (cmd === 'npm' || cmd === 'pnpm' || cmd === 'yarn' || cmd === 'bun') {
    const sub = args.find((a) => !a.startsWith('-')) || '';
    if (['install', 'i', 'add', 'ci', 'update', 'upgrade', 'publish', 'link', 'uninstall', 'remove', 'rm', 'exec', 'dlx', 'x', 'login', 'adduser', 'token', 'config'].includes(sub)) return verdict('red', L(ctx, sub === 'publish' ? 'بينشر حزمة على الإنترنت' : 'بينزّل أو بيغيّر حزماً (' + cmd + ' ' + sub + ') وممكن يشغّل كوداً من الإنترنت', sub === 'publish' ? 'publishes a package to the internet' : 'downloads or changes packages (' + cmd + ' ' + sub + ') and may run code from the internet'));
    if (['test', 't', 'run', 'start', 'build', 'lint', 'ls', 'list', 'view', 'root', 'prefix', 'bin', 'version', '-v', '--version', 'outdated', 'audit', 'pack'].includes(sub) || !sub) return ['ls', 'list', 'root', 'prefix', 'bin', 'version', '-v', '--version', 'view', 'outdated'].includes(sub) ? verdict('green', L(ctx, 'معلومات عن الحزم', 'information about packages')) : verdict('yellow', L(ctx, 'بيشغّل سكربتاً من مشروعك (' + cmd + ' ' + sub + ')', 'runs a script from your project (' + cmd + ' ' + sub + ')'));
    return verdict('red', L(ctx, 'أمر ' + cmd + ' ما بعرفه (' + sub + ')', 'an unfamiliar ' + cmd + ' command (' + sub + ')'));
  }
  if (cmd === 'npx') return verdict('red', L(ctx, 'npx بينزّل حزمة من الإنترنت وبيشغّلها', 'npx downloads a package from the internet and runs it'));
  if (cmd === 'pip' || cmd === 'pip3' || cmd === 'pipx' || cmd === 'uv' || cmd === 'poetry' || cmd === 'cargo' || cmd === 'go') {
    const sub = args.find((a) => !a.startsWith('-')) || '';
    if (['list', 'show', 'freeze', 'check', '--version', 'version', 'env', 'build', 'test', 'vet', 'fmt', 'clippy', 'help'].includes(sub)) return verdict(['list', 'show', 'freeze', 'check', '--version', 'version', 'env', 'help'].includes(sub) ? 'green' : 'yellow', L(ctx, 'معلومات أو بناء محلي (' + cmd + ' ' + sub + ')', 'information or a local build (' + cmd + ' ' + sub + ')'));
    return verdict('red', L(ctx, 'بينزّل ويثبّت حزماً (' + cmd + ' ' + (sub || '') + ')', 'downloads and installs packages (' + cmd + ' ' + (sub || '') + ')'));
  }
  if (cmd === 'node' || cmd === 'python' || cmd === 'python3' || cmd === 'ruby' || cmd === 'perl' || cmd === 'php' || cmd === 'deno') return interpreterVerdict(cmd, args, ctx, body);
  if (cmd === 'pytest' || cmd === 'jest' || cmd === 'mocha' || cmd === 'vitest' || cmd === 'make' || cmd === 'tsc' || cmd === 'eslint' || cmd === 'prettier') return verdict('yellow', L(ctx, 'بيشغّل أدوات المشروع (' + cmd + ')', 'runs project tools (' + cmd + ')'));
  if (cmd === 'claude') return args.some((a) => a === '--version' || a === '-v' || a === '--help') ? verdict('green', L(ctx, 'عرض نسخة Claude', 'showing the Claude version')) : verdict('red', L(ctx, 'بيشغّل Claude Code بجلسة جديدة', 'starts Claude Code in a new session'));
  if (cmd === 'gh') return verdict(/^(pr|issue|repo|release|gist|workflow|run|api|auth|secret)/.test(args[0] || '') && !/^(view|list|status|diff|checks)$/.test(args[1] || '') ? 'red' : 'yellow', L(ctx, 'بيتعامل مع GitHub (gh ' + (args[0] || '') + ' ' + (args[1] || '') + ')', 'works with GitHub (gh ' + (args[0] || '') + ' ' + (args[1] || '') + ')'));
  if (cmd === 'npm-check') return verdict('yellow', '');
  if (cmd === 'cat' || cmd === 'head' || cmd === 'tail' || cmd === 'less') return readVerdict(args, ctx);
  if (cmd === 'git-lfs') return verdict('red', L(ctx, 'بيتعامل مع ملفات كبيرة على الإنترنت', 'handles large files over the internet'));
  if (READ_ONLY.has(cmd)) return readVerdict(args, ctx, L(ctx, 'قراءة أو عرض معلومات (' + cmd + ')', 'reading or showing information (' + cmd + ')'));
  return verdict('red', L(ctx, 'أمر ما بعرفه (' + cmd + ') فما بقدر أتوقع شو رح يعمل', 'a command I do not know (' + cmd + '), so I cannot predict what it will do'));
}

function readVerdict(args, ctx, label) {
  for (const a of args.filter((x) => !x.startsWith('-'))) {
    const p = ctx.P.resolve(a, ctx.cwd);
    if (p && isSecret(p)) return verdict('red', L(ctx, 'بيقرأ ملفاً ممكن يحتوي أسراراً (' + p + ')', 'reads a file that may contain secrets (' + p + ')'));
  }
  return verdict('green', label || L(ctx, 'قراءة ملفات', 'reading files'));
}

function pathsVerdict(label, files, ctx) {
  if (!files.length) return verdict('yellow', label);
  let v = verdict('yellow', label + L(ctx, ' داخل المشروع', ' inside the project'));
  for (const f of files) {
    const p = ctx.P.resolve(f, ctx.cwd);
    if (p === null) return verdict('red', label + L(ctx, ' بمسار ما بقدر أحدده (' + f + ')', ' at a path I cannot work out (' + f + ')'));
    if (p === '/dev/null') continue;
    if (isSecret(p)) return verdict('red', label + ': ' + p + L(ctx, ' (ملف حساس)', ' (sensitive file)'));
    if (!ctx.P.inProject(p)) v = worst(v, verdict('red', label + L(ctx, ' برا مجلد المشروع: ', ' outside the project folder: ') + p));
  }
  return v;
}

function countFiles(p, cap = 5000) {
  let files = 0, bytes = 0;
  (function walk(d) {
    let st; try { st = fs.lstatSync(d); } catch (e) { return; }
    if (st.isDirectory()) { let ls = []; try { ls = fs.readdirSync(d); } catch (e) {} for (const x of ls) { if (files >= cap) return; walk(path.join(d, x)); } }
    else { files++; bytes += st.size; }
  })(p);
  return { files, bytes };
}
function human(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b > 1024 ? Math.round(b / 1024) + ' KB' : b + ' B'; }

function deleteVerdict(cmd, args, ctx) {
  const targets = args.filter((a) => !a.startsWith('-'));
  if (!targets.length) return verdict('red', L(ctx, 'بيمسح ملفات', 'deletes files'));
  let total = 0, bytes = 0, parts = [], outside = false, unknown = false;
  for (const t of targets) {
    const p = ctx.P.resolve(t, ctx.cwd);
    if (p === null) { unknown = true; continue; }
    if (!ctx.P.inProject(p)) outside = true;
    if (/[*?[]/.test(t)) {
      let ms = []; try { ms = fs.globSync ? fs.globSync(t, { cwd: ctx.cwd }) : []; } catch (e) {}
      if (!ms.length) { unknown = true; continue; }
      for (const m of ms) { const c = countFiles(path.resolve(ctx.cwd, m)); total += c.files; bytes += c.bytes; }
      parts.push(t);
    } else { const c = countFiles(p); total += c.files; bytes += c.bytes; parts.push(path.relative(ctx.cwd, p) || '.'); }
  }
  let s = L(ctx, 'رح يمسح ' + (total ? total + ' ملف (' + human(bytes) + ')' : 'ملفات') + ' من ' + (parts.join('، ') || 'مسار ما قدرت أحدده') + '. ما في تراجع',
    'Will delete ' + (total ? total + (total === 1 ? ' file' : ' files') + ' (' + human(bytes) + ')' : 'files') + ' from ' + (parts.join(', ') || 'a path I could not work out') + '. There is no undo');
  if (outside) s += L(ctx, '، وجزء منها برا مجلد المشروع', ', and some of them are outside the project folder');
  if (unknown) s += L(ctx, '، وما قدرت أحسب كل المسارات', ', and I could not count all the paths');
  return verdict('red', s);
}

function gitVerdict(args, ctx) {
  let k = 0; while (k < args.length && args[k].startsWith('-')) { if (['-C', '-c', '--git-dir', '--work-tree'].includes(args[k])) k++; k++; }
  const sub = args[k] || '', rest = args.slice(k + 1);
  if (GIT_READ.has(sub)) return verdict('green', L(ctx, 'قراءة سجل git', 'reading the git history'));
  if (sub === 'branch') return rest.some((a) => /^-[a-zA-Z]*[dD]/.test(a) || a === '--delete' || a === '-m' || a === '-M') ? verdict('red', L(ctx, 'بيمسح أو بيغيّر اسم فرع', 'deletes or renames a branch')) : verdict('green', L(ctx, 'عرض الفروع', 'listing branches'));
  if (sub === 'config') return rest.some((a) => a === '--get' || a === '--list' || a === '-l' || a === '--get-all') ? verdict('green', L(ctx, 'قراءة إعدادات git', 'reading git settings')) : verdict('red', L(ctx, 'بيغيّر إعدادات git', 'changes git settings'));
  if (sub === 'remote') return rest.length === 0 || rest[0] === '-v' || rest[0] === 'get-url' || rest[0] === 'show' ? verdict('green', L(ctx, 'عرض المستودعات البعيدة', 'listing remotes')) : verdict('red', L(ctx, 'بيغيّر المستودعات البعيدة', 'changes the remotes'));
  if (sub === 'push') return verdict('red', rest.some((a) => a === '--force' || a === '-f' || a.startsWith('--force-with')) ? L(ctx, 'رح يرفع تعديلاتك للإنترنت ويستبدل التاريخ الموجود هناك بالقوة', 'Will upload your changes to the internet and force-overwrite the history that is there') : L(ctx, 'رح يرفع تعديلاتك لمستودع على الإنترنت', 'Will upload your changes to a repository on the internet'));
  if (sub === 'reset') return rest.includes('--hard') ? verdict('red', L(ctx, 'بيرجّع الملفات لآخر حفظ وبيمسح كل تعديلاتك الحالية', 'resets the files to the last commit and wipes all your current changes')) : verdict('yellow', L(ctx, 'بيتراجع عن حفظ تعديلات (بدون مسح الملفات)', 'undoes a commit (without deleting the files)'));
  if (sub === 'checkout' || sub === 'restore') return rest.some((a) => a === '--' || a === '.' || a === '-f' || a === '--force' || a === '--hard') || sub === 'restore' ? verdict('red', L(ctx, 'بيرجّع ملفات لآخر حفظ وبيمسح تعديلاتك الحالية عليها', 'resets files to the last commit and wipes your current changes to them')) : verdict('yellow', L(ctx, 'بيبدّل الفرع الحالي', 'switches the current branch'));
  if (sub === 'clean') return verdict('red', L(ctx, 'بيمسح الملفات الغير متتبّعة بـgit', 'deletes the files git is not tracking'));
  if (sub === 'rebase') return verdict('red', L(ctx, 'بيعيد كتابة تاريخ الحفظ', 'rewrites the commit history'));
  if (sub === 'pull' || sub === 'fetch' || sub === 'clone') return verdict(sub === 'clone' ? 'yellow' : 'red', L(ctx, sub === 'clone' ? 'بينزّل مستودعاً من الإنترنت' : 'بيجيب تعديلات من الإنترنت وممكن يغيّر ملفاتك', sub === 'clone' ? 'downloads a repository from the internet' : 'fetches changes from the internet and may change your files'));
  if (GIT_LOCAL_WRITE.has(sub)) return verdict('yellow', L(ctx, 'بيحفظ أو بيرتّب تعديلات محلياً (git ' + sub + ')', 'saves or arranges changes locally (git ' + sub + ')'));
  if (GIT_DANGER.has(sub)) return verdict('red', L(ctx, 'أمر git ' + sub + ' خطر', 'the git ' + sub + ' command is dangerous'));
  return verdict('red', L(ctx, 'أمر git ما بعرفه (' + sub + ')', 'a git command I do not know (' + sub + ')'));
}

function netVerdict(cmd, args, ctx) {
  const joined = args.join(' ');
  const sends = /(^|\s)(-d|--data\S*|-F|--form\S*|-T|--upload-file|--json)(\s|=|$)|(-X|--request)\s*(POST|PUT|DELETE|PATCH)/i.test(joined) || (cmd === 'wget' && /--post-/.test(joined));
  if (sends) return verdict('red', L(ctx, 'رح يرسل بيانات لعنوان على الإنترنت', 'Will send data to an address on the internet'));
  const out = []; for (let i = 0; i < args.length; i++) if (['-o', '-O', '--output', '--output-document'].includes(args[i]) && args[i + 1]) out.push(args[i + 1]);
  if (cmd === 'wget' && !out.length) { /* wget saves into the current folder */ }
  const url = args.find((a) => /^https?:\/\//.test(a)) || '';
  let v = verdict('yellow', L(ctx, 'بيجيب صفحة أو ملف من الإنترنت', 'fetches a page or file from the internet') + (url ? ' (' + url.slice(0, 60) + ')' : ''));
  if (out.length) v = worst(v, pathsVerdict(L(ctx, 'بيحفظ ما بيجيبه', 'saves what it fetches'), out, ctx));
  return v;
}

function scriptVerdict(file, ctx) {
  const p = ctx.P.resolve(file, ctx.cwd);
  if (!p || !ctx.P.inProject(p)) return verdict('red', L(ctx, 'بيشغّل سكربتاً من خارج المشروع أو ما قدرت أحدده (' + file + ')', 'runs a script from outside the project, or one I could not locate (' + file + ')'));
  let txt = ''; try { txt = fs.readFileSync(p, 'utf8'); } catch (e) { return verdict('yellow', L(ctx, 'بيشغّل سكربتاً من مشروعك (' + file + ')', 'runs a script from your project (' + file + ')')); }
  if (RISKY_CODE.test(txt)) return verdict('red', L(ctx, 'السكربت ' + file + ' فيه كود حذف أو إرسال عبر الشبكة', 'the script ' + file + ' contains code that deletes or sends over the network'));
  const ow = outsideWrite(txt, ctx); if (ow) return verdict('red', L(ctx, 'السكربت ' + file + ' بيكتب خارج المشروع (' + ow + ')', 'the script ' + file + ' writes outside the project (' + ow + ')'));
  return verdict('yellow', L(ctx, 'بيشغّل سكربتاً من مشروعك (' + file + ')، ما لقيت فيه حذفاً ولا إرسالاً', 'runs a script from your project (' + file + '); I found no deleting or sending in it'));
}

function interpreterVerdict(cmd, args, ctx, body) {
  if (args.some((a) => a === '--version' || a === '-v' || a === '-V' || a === '--help')) return verdict('green', L(ctx, 'عرض نسخة أو مساعدة', 'showing the version or help'));
  if (cmd === 'node' && (args.includes('--check') || args.includes('-c'))) return verdict('green', L(ctx, 'فحص صياغة بدون تشغيل', 'checking syntax without running'));
  if (args.includes('--test')) return verdict('yellow', L(ctx, 'بيشغّل اختبارات مشروعك (' + cmd + ' --test)', 'runs your project tests (' + cmd + ' --test)'));
  const ci = args.findIndex((a) => a === '-e' || a === '-c' || a === '-p' || a === '--eval' || a === '--print');
  const script = args.find((a) => !a.startsWith('-'));
  const inline = ci >= 0 || args.includes('-') || (!script && body);
  if (inline) {
    const code = (ci >= 0 ? (args[ci + 1] || '') : '') + '\n' + (body || '');
    if (RISKY_CODE.test(code)) return verdict('red', L(ctx, 'كود ' + cmd + ' مكتوب بالأمر وفيه حذف أو إرسال عبر الشبكة', cmd + ' code written in the command deletes or sends over the network'));
    const ow = outsideWrite(code, ctx); if (ow) return verdict('red', L(ctx, 'كود ' + cmd + ' مكتوب بالأمر وبيكتب خارج المشروع (' + ow + ')', cmd + ' code written in the command writes outside the project (' + ow + ')'));
    return verdict('yellow', L(ctx, 'بيشغّل كود ' + cmd + ' مكتوب بالأمر' + (WRITE_CODE.test(code) ? ' (بيكتب ملفات)' : ' (قراءة وحساب)'), 'runs ' + cmd + ' code written in the command' + (WRITE_CODE.test(code) ? ' (writes files)' : ' (reading and calculating)')));
  }
  if (!script) return args.length ? verdict('yellow', L(ctx, 'بيشغّل ' + cmd + ' بخيارات', 'runs ' + cmd + ' with options')) : verdict('red', L(ctx, 'بيفتح جلسة ' + cmd + ' تفاعلية', 'opens an interactive ' + cmd + ' session'));
  if (cmd === 'python' || cmd === 'python3') { const mi = args.indexOf('-m'); if (mi >= 0) return verdict('yellow', L(ctx, 'بيشغّل وحدة ' + (args[mi + 1] || '') + ' من python', 'runs the python module ' + (args[mi + 1] || ''))); }
  return scriptVerdict(script, ctx);
}

function extractSubst(cmd) {
  let out = '', inners = [], q = null, ok = true;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q === "'") { out += c; if (c === "'") q = null; continue; }
    if (c === '\\' && i + 1 < cmd.length) { out += c + cmd[i + 1]; i++; continue; }
    if (c === '$' && cmd[i + 1] === '(' && cmd[i + 2] !== '(') {
      let d = 1, j = i + 2;
      while (j < cmd.length && d > 0) { if (cmd[j] === '(') d++; else if (cmd[j] === ')') d--; j++; }
      if (d !== 0) { ok = false; out += c; continue; }
      inners.push(cmd.slice(i + 2, j - 1)); out += '$__S__'; i = j - 1; continue;
    }
    if (c === '`') { const j = cmd.indexOf('`', i + 1); if (j < 0) { ok = false; out += c; continue; } inners.push(cmd.slice(i + 1, j)); out += '$__S__'; i = j; continue; }
    if (c === '"') q = q === '"' ? null : '"';
    else if (c === "'" && q === null) q = "'";
    out += c;
  }
  return { cmd: out, inners, ok };
}

const NOOP = /^(for\b.*|done|fi|esac|in|then|do|else|\{|\}|\(|\)|case\b.*|select\b.*)$/;
function cleanSegment(text) {
  let t = text.trim();
  for (let k = 0; k < 6; k++) {
    const before = t;
    t = t.replace(/^(do|then|else|elif|if|while|until|!)\s+/, '').trim();
    t = t.replace(/^[({]\s*/, '').trim();
    if (t.endsWith(')') && (t.match(/\(/g) || []).length < (t.match(/\)/g) || []).length) t = t.slice(0, -1).trim();
    if (t.endsWith('}') && !t.includes('{')) t = t.slice(0, -1).trim();
    if (t === before) break;
  }
  return NOOP.test(t) ? '' : t;
}

// classifyString(cmd, ctx, lang): lang is 'ar' (default) or 'en'; it only changes the wording, never the tier.
function classifyString(cmd, ctx, lang) {
  if (lang) ctx.lang = lang;
  const ex = extractSubst(cmd);
  if (!ex.ok) return verdict('red', L(ctx, 'الأمر فيه استبدال بأمر ثاني ما قدرت أقرأه بالكامل', 'the command has a command substitution I could not read in full'));
  let inner = verdict('green', '');
  for (const s of ex.inners) { const iv = classifyString(s, { ...ctx }); if (iv.tier !== 'green') { inner = worst(inner, verdict(iv.tier, L(ctx, 'داخل ‎$(…)‎: ', 'inside $(…): ') + iv.effect)); } }
  if (inner.tier === 'red') return inner;
  cmd = ex.cmd;
  const { segs, subst } = splitShell(cmd);
  let v = inner;
  const notes = inner.effect ? [inner.effect] : [];
  if (subst) v = worst(v, verdict('red', L(ctx, 'الأمر فيه استبدال بأمر ثاني (‎$(…)‎ أو علامات ‎`‎) وما بقدر أعرف شو رح ينتج', 'the command has a command substitution ($(…) or backticks) and I cannot tell what it will produce')));
  for (const s of segs) {
    const txt = cleanSegment(s.text); if (!txt) continue;
    const { rest, targets } = takeRedirects(words(txt));
    let sv = rest.length ? classifyOne(rest, ctx, s.body) : verdict('green', '');
    if (!rest.length && targets.length) {
      sv = verdict('yellow', L(ctx, 'بيعمل ملفاً فاضياً', 'creates an empty file'));
      for (const t of targets) { const p = ctx.P.resolve(t, ctx.cwd); try { if (p && p !== '/dev/null' && fs.existsSync(p) && fs.statSync(p).size > 0) sv = worst(sv, verdict('red', L(ctx, 'رح يفرّغ محتوى ملف موجود (' + t + ') من غير ما يكتب شي مكانه', 'Will empty an existing file (' + t + ') without writing anything in its place'))); } catch (e) {} }
    }
    for (const t of targets) {
      const p = ctx.P.resolve(t, ctx.cwd);
      if (p === '/dev/null') continue;
      if (p === null) sv = worst(sv, verdict('red', L(ctx, 'بيكتب على ملف بمسار ما قدرت أحدده (' + t + ')', 'writes to a file at a path I could not work out (' + t + ')')));
      else if (isSecret(p)) sv = worst(sv, verdict('red', L(ctx, 'بيكتب على ملف حساس (' + p + ')', 'writes to a sensitive file (' + p + ')')));
      else if (!ctx.P.inProject(p)) sv = worst(sv, verdict('red', L(ctx, 'بيكتب ملفاً برا مجلد المشروع: ', 'writes a file outside the project folder: ') + p));
      else sv = worst(sv, verdict('yellow', L(ctx, 'بيكتب ملفاً داخل المشروع: ', 'writes a file inside the project: ') + path.relative(ctx.root, p)));
    }
    if (sv.effect) notes.push(sv.effect);
    if (RANK[sv.tier] > RANK[v.tier] || (RANK[sv.tier] === RANK[v.tier] && !v.effect)) v = { tier: RANK[sv.tier] >= RANK[v.tier] ? sv.tier : v.tier, effect: sv.effect };
    // pipe into a shell is always red
    if (/\|\s*(ba|z)?sh\b/.test(cmd)) v = worst(v, verdict('red', L(ctx, 'بيمرّر نصاً مباشرة لـ shell ليشغّله', 'pipes text straight into a shell to run it')));
  }
  if (v.tier !== 'red') v.effect = [...new Set(notes)].filter(Boolean).join(' · ');
  return v;
}

// ---------------------------------------------------------------- impact on the function map
function impactOfEdit(root, abs, oldStr, lang) {
  try {
    const fnmap = path.join(__dirname, '..', 'analyzer', 'fnmap.js');
    const g = JSON.parse(execFileSync('node', [fnmap, root], { timeout: 8000, maxBuffer: 20e6, stdio: ['ignore', 'pipe', 'ignore'] }).toString());
    const rel = path.relative(root, abs);
    const text = fs.readFileSync(abs, 'utf8');
    const idx = oldStr ? text.indexOf(oldStr) : -1;
    if (idx < 0) return null;
    const line = text.slice(0, idx).split('\n').length;
    let best = null;
    for (const n of g.nodes) if (n.file === rel && n.kind === 'function' && n.start <= line && line <= (n.end || n.start) && (!best || n.end - n.start < best.end - best.start)) best = n;
    if (!best) return null;
    const rev = {};
    for (const e of g.edges) (rev[e.to] = rev[e.to] || []).push(e.from);
    const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
    const direct = [...new Set(rev[best.id] || [])];
    const seen = new Set([best.id]), q = [best.id];
    while (q.length) for (const f of rev[q.shift()] || []) if (!seen.has(f)) { seen.add(f); q.push(f); }
    const name = (id) => (byId[id].kind === 'function' ? byId[id].name + '()' : byId[id].kind === 'top' ? (lang === 'en' ? 'page code' : 'كود الصفحة') : byId[id].name);
    return { name: best.name, where: rel + ':' + best.start, direct: direct.map(name), total: seen.size - 1 };
  } catch (e) { return null; }
}

// ---------------------------------------------------------------- decide
// decide(input, lang): lang is 'ar' (default) or 'en'.
function decide(input, lang) {
  const tool = input.tool_name || '', ti = input.tool_input || {};
  const root = path.resolve(input.cwd || process.cwd());
  const P = makePaths(root);
  const ctx = { root, cwd: root, P, lang: lang === 'en' ? 'en' : 'ar' };

  if (['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TaskList', 'TaskGet', 'TaskCreate', 'TaskUpdate', 'TodoWrite', 'AskUserQuestion', 'ToolSearch', 'Skill', 'ExitPlanMode', 'BashOutput', 'ListMcpResourcesTool'].includes(tool)) {
    const f = ti.file_path || ti.path || ti.notebook_path;
    if (f) { const p = P.resolve(f, root); if (p && isSecret(p)) return verdict('red', L(ctx, 'بيقرأ ملفاً ممكن يحتوي أسراراً (' + p + ')', 'reads a file that may contain secrets (' + p + ')')); }
    return verdict('green', L(ctx, 'قراءة أو إدارة مهام', 'reading or managing tasks'));
  }
  if (tool === 'Bash') return classifyString(String(ti.command || ''), ctx);
  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(tool)) {
    const f = ti.file_path || ti.notebook_path;
    const p = P.resolve(f, root);
    if (!p) return verdict('red', L(ctx, 'بيكتب بمسار ما قدرت أحدده', 'writes to a path I could not work out'));
    if (isSecret(p)) return verdict('red', L(ctx, 'بيكتب على ملف حساس: ', 'writes to a sensitive file: ') + p);
    if (!P.inProject(p)) return verdict('red', L(ctx, 'بيكتب ملفاً برا مجلد المشروع: ', 'writes a file outside the project folder: ') + p);
    const exists = fs.existsSync(p);
    let v = verdict('yellow', L(ctx, tool === 'Write' ? (exists ? 'بيستبدل محتوى ملف موجود: ' : 'بيعمل ملفاً جديداً: ') : 'بيعدّل الملف: ', tool === 'Write' ? (exists ? 'replaces the contents of an existing file: ' : 'creates a new file: ') : 'edits the file: ') + path.relative(root, p));
    if (tool !== 'Write' && exists && /\.(html|js|mjs|cjs)$/.test(p)) {
      const olds = tool === 'MultiEdit' ? (ti.edits || []).map((e) => e.old_string) : [ti.old_string];
      let worstImp = null;
      for (const o of olds) { const imp = impactOfEdit(root, p, o, ctx.lang); if (imp && (!worstImp || imp.total > worstImp.total)) worstImp = imp; }
      if (worstImp) {
        const big = worstImp.direct.length >= 6 || worstImp.total >= 12;
        const list = worstImp.direct.slice(0, 5).join(L(ctx, '، ', ', ')) + (worstImp.direct.length > 5 ? L(ctx, ' وغيرها', ' and others') : '');
        const s = L(ctx, 'بتعدّل ' + worstImp.name + '() (' + worstImp.where + '). ' + (worstImp.direct.length ? 'بتعتمد عليها ' + worstImp.direct.length + ' دوال مباشرة (' + list + ')، ويمتد الأثر لـ ' + worstImp.total + ' دالة.' : 'ما في دالة بتعتمد عليها.'),
          'You are editing ' + worstImp.name + '() (' + worstImp.where + '). ' + (worstImp.direct.length ? worstImp.direct.length + (worstImp.direct.length === 1 ? ' function depends' : ' functions depend') + ' on it directly (' + list + '), and the effect reaches ' + worstImp.total + (worstImp.total === 1 ? ' function.' : ' functions in all.') : 'No function depends on it.'));
        v = verdict(big ? 'red' : 'yellow', s);
      }
    }
    return v;
  }
  if (tool === 'WebFetch') return verdict('yellow', L(ctx, 'بيفتح صفحة من الإنترنت: ', 'opens a page from the internet: ') + String(ti.url || '').slice(0, 80));
  if (tool === 'WebSearch') return verdict('yellow', L(ctx, 'بيبحث على الإنترنت: ', 'searches the internet: ') + String(ti.query || '').slice(0, 60));
  if (tool === 'Agent' || tool === 'Task') return verdict('yellow', L(ctx, 'بيشغّل وكيلاً فرعياً', 'runs a sub-agent'));
  if (tool.startsWith('mcp__')) return /(read|get|list|search|query|fetch|whoami|status|describe)/i.test(tool.split('__').pop()) && !/(delete|remove|write|create|update|send|post|push|publish|execute|run)/i.test(tool) ? verdict('yellow', L(ctx, 'قراءة من تطبيق خارجي (' + tool.split('__').slice(1).join(' / ') + ')', 'reading from an external app (' + tool.split('__').slice(1).join(' / ') + ')')) : verdict('red', L(ctx, 'أداة من تطبيق خارجي ممكن تغيّر شي هناك (' + tool.split('__').slice(1).join(' / ') + ')', 'a tool from an external app that may change something there (' + tool.split('__').slice(1).join(' / ') + ')'));
  return verdict('red', L(ctx, 'أداة ما بعرفها (' + tool + ')', 'a tool I do not know (' + tool + ')'));
}

// respond(input, v, lang): builds the hook answer. The text of v is already in the right language; lang is accepted for symmetry.
function respond(input, v, lang) { // eslint-disable-line no-unused-vars
  const root = path.resolve(input.cwd || process.cwd());
  try {
    const dir = path.join(root, '.impact'); fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'activity.jsonl'), JSON.stringify({ t: new Date().toISOString(), tier: v.tier, tool: input.tool_name, effect: v.effect }) + '\n');
  } catch (e) { /* the log is optional */ }
  if (v.tier === 'red') return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: '🔴 ' + v.effect } };
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: (v.tier === 'green' ? '🟢 ' : '🟡 ') + v.effect } };
}

const makeCtx = (root) => { root = path.resolve(root); return { root, cwd: root, P: makePaths(root) }; };
module.exports = { decide, respond, classifyString, makeCtx };

if (require.main === module) {
  let buf = '';
  process.stdin.on('data', (d) => (buf += d));
  process.stdin.on('end', () => {
    const lang = process.env.IMPACT_LANG === 'en' ? 'en' : 'ar';
    let input = {};
    try { input = JSON.parse(buf || '{}'); } catch (e) { process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: '🔴 ' + L({ lang }, 'ما قدرت أقرأ الطلب', 'I could not read the request') } })); return; }
    let v;
    try { v = decide(input, lang); } catch (e) { v = verdict('red', L({ lang }, 'صار خطأ داخلي وما قدرت أحلل الطلب', 'an internal error happened and I could not analyse the request')); }
    process.stdout.write(JSON.stringify(respond(input, v, lang)));
  });
}
