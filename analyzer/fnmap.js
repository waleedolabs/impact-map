#!/usr/bin/env node
'use strict';
// fnmap.js <project-dir> [--json out.json]
// Function-level map of a JavaScript / TypeScript / React / HTML project:
//   functions, who calls whom (also across files through import / require), which request hits which server route,
//   and what each function can do (network, storage, files, secrets, AI, database, clipboard, sound, commands).
// Parsers are bundled in ../vendor. TypeScript files are read through the project's own `typescript` package when it is installed.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const acorn = require('../vendor/acorn/acorn.js');
const jsx = require('../vendor/acorn-jsx/index.js');
const Parser = acorn.Parser.extend(jsx());

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', 'coverage', '.cache', '.turbo', '.vercel', '__pycache__', '.venv', 'venv', 'target', '.idea', '.gradle', 'Pods', '.impact']);
const EXT = /\.(m?js|cjs|jsx|ts|tsx|html?)$/i;
const MAX_FILES = 1500, MAX_BYTES = 600 * 1024;

const CAPS = {
  NET: /\bfetch\s*\(|XMLHttpRequest|new WebSocket|\baxios\b|\bgot\s*\(|\bhttps?\.(request|get)\s*\(|\bsuperagent\b|\bky\s*\(/,
  STO: /localStorage|sessionStorage|indexedDB|document\.cookie|\bAsyncStorage\b/,
  FS: /\bfs(\.promises)?\.(writeFile|appendFile|createWriteStream|mkdir|rm|rmdir|unlink|rename|copyFile)\w*\s*\(|\b(writeFile|appendFile|unlink|rmSync|rmdirSync)\w*\s*\(/,
  KEY: /process\.env\.[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|PASS)\b|\benv\.[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD)\b|\bAuthorization\b|\bBearer\b|crypto\.subtle\.(importKey|sign)|\bjwt\.(sign|verify)\b/,
  AI: /api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis|chat\/completions|\bopenai\b|\banthropic\b/i,
  DB: /\benv\.DB\b|\.prepare\s*\(|\bprisma\b|\bsequelize\b|\bmongoose\b|\bknex\b|\bsupabase\b|\bfirebase\b|\bdb\.(query|run|get|all|exec)\s*\(|\bpg\b.*\.query\s*\(/i,
  CLIP: /navigator\.clipboard|navigator\.share|window\.open\s*\(|execCommand\(\s*['"]copy|window\.prompt/,
  SND: /AudioContext|webkitAudioContext|new Audio\s*\(|navigator\.vibrate/,
  EXEC: /child_process|\bexecSync\s*\(|\bspawnSync\s*\(|\bexecFile(Sync)?\s*\(|\bspawn\s*\(|\bos\.system\s*\(/,
};

// ---------------------------------------------------------------------------------------------------------------
function walk(dir, out, root, skipped) {
  let names; try { names = fs.readdirSync(dir).sort(); } catch (e) { return out; }
  for (const n of names) {
    if (out.length >= MAX_FILES) { skipped.push({ file: path.relative(root, dir), why: 'too many files, stopped at ' + MAX_FILES }); return out; }
    if (IGNORE_DIRS.has(n)) continue;
    const p = path.join(dir, n); let st; try { st = fs.statSync(p); } catch (e) { continue; }
    if (st.isDirectory()) walk(p, out, root, skipped);
    else if (EXT.test(n) && !/\.d\.ts$/.test(n) && !/\.min\.js$/.test(n)) {
      if (st.size > MAX_BYTES) skipped.push({ file: path.relative(root, p), why: 'bigger than 600 KB' }); else out.push(p);
    }
  }
  return out;
}

let TS = undefined;
function loadTypeScript(root) {
  if (TS !== undefined) return TS;
  const tries = [root, process.cwd(), __dirname];
  try { tries.push(path.join(cp.execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(), '..')); } catch (e) {}
  for (const base of tries) { try { TS = require(require.resolve('typescript', { paths: [base] })); return TS; } catch (e) { /* next */ } }
  return (TS = null);
}

function readPkg(root) {   // a library's entry file can be used by code outside the project
  try { const p = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); const main = p.main ? path.posix.normalize(String(p.main)).replace(/^\.\//, '') : (fs.existsSync(path.join(root, 'index.js')) ? 'index.js' : null); return { main: main && !/\.[a-z]+$/i.test(main) ? main + '.js' : main, private: !!p.private }; } catch (e) { return null; }
}
function kids(node) {
  const out = [];
  for (const k in node) {
    if (k === 'loc' || k === 'start' || k === 'end' || k === 'type' || k.startsWith('__')) continue;
    const v = node[k];
    if (v && typeof v.type === 'string') out.push([k, v]);
    else if (Array.isArray(v)) for (const x of v) if (x && typeof x.type === 'string') out.push([k, x]);
  }
  return out;
}
const isFn = (n) => n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression';
const FN_WRAPPERS = new Set(['memo', 'forwardRef', 'useCallback', 'observer', 'React.memo', 'React.forwardRef', 'React.useCallback', 'debounce', 'throttle']);
const calleeName = (c) => c.type === 'Identifier' ? c.name : (c.type === 'MemberExpression' && !c.computed && c.object.type === 'Identifier' ? c.object.name + '.' + c.property.name : '');
const CLIENT_OBJ = /^(axios|http|\$http|client|request|api|ky|got|superagent|fetcher)$/i;
const SERVER_OBJ = /^(app|router|server|routes?|route|r)$/i;
const VERBS = new Set(['get', 'post', 'put', 'delete', 'patch', 'all', 'use', 'head', 'options']);

// ---------------------------------------------------------------------------------------------------------------
function analyzeProject(rootArg) {
  const root = path.resolve(rootArg);
  const nodes = new Map(), edges = new Map(), problems = [], skipped = [], filesInfo = [];
  const facts = {}, dataRefs = [];   // signs that the map may not see everything (used for the confidence of a result)
  const addFact = (file, key, from) => { const f = (facts[file] = facts[file] || {}); f[key] = f[key] || []; if (!f[key].includes(from)) f[key].push(from); };
  const addEdge = (from, to, how) => { if (!from || !to || from === to) return; const k = from + '|' + to + '|' + how; const e = edges.get(k); if (e) e.n++; else edges.set(k, { from, to, how, n: 1 }); };

  // ---- 1. units: one per script (a .js/.ts file, or one inline <script> of an .html file)
  const units = [];
  for (const p of walk(root, [], root, skipped)) {
    const rel = path.relative(root, p).split(path.sep).join('/');
    let text; try { text = fs.readFileSync(p, 'utf8'); } catch (e) { continue; }
    if (/\.html?$/i.test(rel)) {
      const re = /<script(?![^>]*\bsrc=)(?![^>]*type=["'](?!module|text\/javascript)[^"']*["'])[^>]*>([\s\S]*?)<\/script>/gi; let m, any = false;
      while ((m = re.exec(text))) { any = true; const upto = text.slice(0, m.index + m[0].indexOf('>') + 1); units.push({ file: rel, code: m[1], orig: m[1], lineOffset: upto.split('\n').length - 1, module: false, inline: true }); }
      if (!any) filesInfo.push({ file: rel, status: 'no inline script' });
    } else if (/\.(ts|tsx)$/i.test(rel)) {
      const ts = loadTypeScript(root);
      if (!ts) { skipped.push({ file: rel, why: 'TypeScript file: the `typescript` package was not found, run npm install in the project first' }); continue; }
      let out; try { out = ts.transpileModule(text, { fileName: rel, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve, removeComments: false, isolatedModules: true, esModuleInterop: true } }).outputText; } catch (e) { skipped.push({ file: rel, why: 'could not read TypeScript: ' + e.message.slice(0, 80) }); continue; }
      units.push({ file: rel, code: out, orig: text, lineOffset: 0, module: true, ts: true });
    } else {
      units.push({ file: rel, code: text, orig: text, lineOffset: 0, module: !/\.cjs$/i.test(rel) && /^\s*(import|export)\s/m.test(text) });
    }
  }
  const byFile = new Map(); units.forEach((u) => { if (!byFile.has(u.file)) byFile.set(u.file, u); });
  const fileKey = (f) => f.replace(/\.(m?js|cjs|jsx|tsx?|html?)$/i, '');
  const allFiles = [...byFile.keys()];
  function noteDataRef(u, rel, fromDir) {
    const c = path.posix.normalize(fromDir ? path.posix.join(path.posix.dirname(u.file), rel) : rel).replace(/\/$/, '');
    if (!c || c === '.' || c.startsWith('..')) return;
    const isFile = byFile.has(c) || allFiles.some((f) => f.replace(/\.[^./]+$/, '') === c);
    const isDir = !isFile && allFiles.some((f) => f.startsWith(c + '/'));
    if ((isFile || isDir) && c !== u.file && !dataRefs.some((d) => d.from === u.file && d.target === c)) dataRefs.push({ from: u.file, target: c, folder: isDir });
  }
  const byKey = new Map(); [...byFile.keys()].forEach((f) => { if (!byKey.has(fileKey(f))) byKey.set(fileKey(f), f); });
  function resolveImport(fromFile, src) {
    let base;
    if (src.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), src));
    else if (src.startsWith('@/') || src.startsWith('~/')) base = 'src/' + src.slice(2);
    else return null;
    for (const c of [base, base + '/index']) { if (byKey.has(fileKey(c))) return byKey.get(fileKey(c)); if (byFile.has(c)) return c; }
    return null;
  }
  const origLine = (u, name, tline) => {
    if (!u.ts) return tline + u.lineOffset;
    const lines = u.orig.split('\n'), id = name.split('.').pop().replace(/[$]/g, '\\$');
    const re = new RegExp('(\\bfunction\\s+' + id + '\\b|\\b(const|let|var)\\s+' + id + '\\b|^\\s*(async\\s+)?' + id + '\\s*[(:=]|\\bclass\\s+' + id + '\\b)');
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i + 1;
    return tline;
  };

  // ---- 2. per unit: parse, define functions, collect imports and exports
  const live = [];
  for (const u of units) {
    let ast, err;
    for (const mod of [u.module, !u.module]) {
      try { ast = Parser.parse(u.code, { ecmaVersion: 'latest', sourceType: mod ? 'module' : 'script', locations: true, allowHashBang: true, allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true }); break; } catch (e) { err = e; }
    }
    if (!ast) { skipped.push({ file: u.file, why: 'could not parse: ' + String(err && err.message).slice(0, 80) }); continue; }
    u.ast = ast;
    const L = (n) => n.loc.start.line, LE = (n) => n.loc.end.line;
    const base = path.posix.basename(u.file).replace(/\.[^.]+$/, '');
    const top = { id: 'top:' + u.file, name: '(page code)', file: u.file, kind: 'top', start: 1, scriptStart: u.lineOffset + 1, end: LE(ast) + u.lineOffset, parent: null, _sp: null, declared: {}, params: [], objs: {} };
    if (!nodes.has(top.id)) nodes.set(top.id, top);
    u.top = top; u.imports = new Map(); u.exports = new Map(); u.defaultFn = null;

    function define(name, node, cur, kind, tl) {
      const line = origLine(u, name, tl || L(node));
      let q = cur; while (q && q.anon) q = q._sp;
      const f = { id: u.file + ':' + name + '@' + line, name, file: u.file, kind, start: line, end: u.ts ? line + (LE(node) - L(node)) : LE(node) + u.lineOffset, parent: q && q.kind !== 'top' ? q.id : null, _sp: cur, declared: {}, params: [], objs: {}, _tstart: L(node), _tend: LE(node), _unit: u };
      if (kind === 'function') f.params = (node.params || []).filter((p) => p.type === 'Identifier').map((p) => p.name);
      nodes.set(f.id, f); cur.declared[name] = f; return f;
    }
    function p1(node, cur, cls) {
      let next = cur;
      if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') cls = node.id ? node.id.name : base;
      if (node.type === 'FunctionDeclaration' && node.id) { node.__fn = define(node.id.name, node, cur, 'function'); next = node.__fn; }
      else if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) {
        const init = node.init, name = node.id.name;
        if (isFn(init)) init.__fn = define(name, init, cur, 'function');
        else if (init.type === 'CallExpression' && init.arguments[0] && isFn(init.arguments[0]) && FN_WRAPPERS.has(calleeName(init.callee))) init.arguments[0].__fn = define(name, init.arguments[0], cur, 'function');
        else if (init.type === 'ObjectExpression') {
          const props = init.properties.filter((pr) => pr.type === 'Property' && pr.key && (pr.key.type === 'Identifier' || pr.key.type === 'Literal') && pr.value && isFn(pr.value));
          if (props.length) { cur.objs[name] = {}; for (const pr of props) { const key = pr.key.name || String(pr.key.value); const f = define(name + '.' + key, pr.value, cur, 'function'); pr.value.__fn = f; cur.objs[name][key] = f; } }
        }
        if (init.type === 'ObjectExpression' && cur === top && L(init) !== undefined && LE(init) - L(init) >= 12 && !cur.objs[name]) define(name, node, cur, 'data');
        else if ((init.type === 'ArrayExpression') && cur === top && LE(init) - L(init) >= 12) define(name, node, cur, 'data');
      } else if (node.type === 'MethodDefinition' && cls && node.key && (node.key.type === 'Identifier' || node.key.type === 'PrivateIdentifier') && node.value && isFn(node.value)) {
        node.value.__fn = define(cls + '.' + node.key.name, node.value, cur, 'function');
      } else if (node.type === 'ExportDefaultDeclaration' && node.declaration) {
        const d = node.declaration;
        if (isFn(d) && !d.id && !d.__fn) d.__fn = define(base, d, cur, 'function');
      } else if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' && isFn(node.right) && !node.right.__fn && !node.right.id) {
        const l = node.left, lname = l.object.type === 'MemberExpression' ? (l.object.object.name + '.' + (l.object.property.name || '') + '.' + (l.property.name || '')) : (l.object.name + '.' + (l.property.name || ''));
        if (/^(module\.exports|exports)\b/.test(lname) || lname === 'exports.' + (l.property.name || '')) node.right.__fn = define(l.object.name === 'module' ? base : (l.property.name || base), node.right, cur, 'function');
      } else if (isFn(node) && !node.__fn) {
        node.__fn = { anon: true, _sp: cur, declared: {}, params: (node.params || []).filter((q) => q.type === 'Identifier').map((q) => q.name), objs: {} };
      }
      if (isFn(node) && node.__fn) next = node.__fn;
      for (const [, c] of kids(node)) p1(c, next, cls);
    }
    p1(ast, top, null);
    live.push(u);
  }

  // imports and exports (second sweep, needs the defined functions)
  for (const u of live) {
    const top = u.top, base = path.posix.basename(u.file).replace(/\.[^.]+$/, '');
    const fnNamed = (n) => (n && top.declared[n] && top.declared[n].kind === 'function') ? top.declared[n] : null;
    const addImp = (local, src, imported) => { const f = resolveImport(u.file, src); if (f) u.imports.set(local, { file: f, imported }); };
    const reqSrc = (n) => (n && n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'require' && n.arguments[0] && n.arguments[0].type === 'Literal' && typeof n.arguments[0].value === 'string') ? n.arguments[0].value : null;
    (function sweep(node) {
      if (node.type === 'ImportDeclaration') {
        for (const sp of node.specifiers) addImp(sp.local.name, node.source.value, sp.type === 'ImportDefaultSpecifier' ? 'default' : sp.type === 'ImportNamespaceSpecifier' ? '*' : (sp.imported.name || sp.imported.value));
      } else if (node.type === 'ExportNamedDeclaration' && !node.source) {
        if (node.declaration) {
          if (node.declaration.type === 'FunctionDeclaration' && node.declaration.id) u.exports.set(node.declaration.id.name, node.declaration.id.name);
          if (node.declaration.type === 'VariableDeclaration') node.declaration.declarations.forEach((d) => { if (d.id.type === 'Identifier') u.exports.set(d.id.name, d.id.name); });
          if (node.declaration.type === 'ClassDeclaration' && node.declaration.id) u.exports.set(node.declaration.id.name, node.declaration.id.name);
        }
        for (const sp of node.specifiers || []) u.exports.set(sp.exported.name || sp.exported.value, sp.local.name);
      } else if (node.type === 'ExportDefaultDeclaration') {
        const d = node.declaration;
        if (d.type === 'Identifier') u.exports.set('default', d.name);
        else if ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id) u.exports.set('default', d.id.name);
        else if (isFn(d) && d.__fn) u.exports.set('default', d.__fn.name);
        else if (d.type === 'CallExpression') { const a0 = d.arguments[0]; if (a0 && a0.__fn) u.exports.set('default', a0.__fn.name); else if (a0 && a0.type === 'Identifier') u.exports.set('default', a0.name); }
      } else if (node.type === 'VariableDeclarator' && node.init) {
        let src = reqSrc(node.init), prop = null;
        if (!src && node.init.type === 'MemberExpression' && !node.init.computed) { src = reqSrc(node.init.object); prop = node.init.property.name; }
        if (src) {
          if (node.id.type === 'Identifier') addImp(node.id.name, src, prop || '*');
          else if (node.id.type === 'ObjectPattern') node.id.properties.forEach((pr) => { if (pr.type === 'Property' && pr.key.type === 'Identifier' && pr.value.type === 'Identifier') addImp(pr.value.name, src, pr.key.name); });
        }
      } else if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression') {
        const l = node.left;
        if (l.object.type === 'Identifier' && l.object.name === 'module' && l.property.name === 'exports') {
          const r = node.right;
          if (r.type === 'ObjectExpression') r.properties.forEach((pr) => { if (pr.type === 'Property' && pr.key.type === 'Identifier') u.exports.set(pr.key.name, pr.value.type === 'Identifier' ? pr.value.name : (pr.value.__fn ? pr.value.__fn.name : pr.key.name)); });
          else if (r.type === 'Identifier') u.exports.set('default', r.name);
          else if (isFn(r) && r.__fn) u.exports.set('default', r.__fn.name);
        } else if (l.object.type === 'Identifier' && l.object.name === 'exports' && l.property.name) {
          u.exports.set(l.property.name, node.right.type === 'Identifier' ? node.right.name : (node.right.__fn ? node.right.__fn.name : l.property.name));
        }
      }
      for (const [, c] of kids(node)) sweep(c);
    })(u.ast);
    u._fnNamed = fnNamed;
    u._base = base;
  }
  const exportTarget = (file, name) => {            // the node a name imported from `file` stands for
    const t = byFile.get(file); if (!t || !t.top) return null;
    const local = t.exports.get(name);
    const f = local ? t._fnNamed(local) : t._fnNamed(name);
    if (f) return f.id;
    if (name === 'default') { const d = t.exports.get('default'); if (d && t.top.objs[d]) return t.top.id; }
    return t.top.id;
  };

  // ---- 3. edges, requests and server routes
  for (const u of live) {
    const top = u.top, L = (n) => n.loc.start.line;
    const resolve = (name, cur) => { for (let f = cur; f; f = f._sp) { if (f.params && f.params.includes(name)) return null; if (f.declared[name]) return f.declared[name]; } return null; };
    const objOf = (name, cur) => { for (let f = cur; f; f = f._sp) if (f.objs && f.objs[name]) return f.objs[name]; return null; };
    const owner = (f) => { while (f.anon) f = f._sp; return f; };
    const fnOf = (n, cur) => (isFn(n) && n.__fn) ? n.__fn : cur;
    const lits = (n, acc) => { if (n.type === 'Literal' && typeof n.value === 'string' && /^\/[a-z][\w/:.-]*$/i.test(n.value)) acc.push(n.value); if (n.type === 'TemplateLiteral' && n.quasis[0] && /^\/[a-z]/i.test(n.quasis[0].value.cooked || '')) acc.push((n.quasis[0].value.cooked || '').replace(/\/$/, '')); for (const [, c] of kids(n)) lits(c, acc); return acc; };
    const mentions = (n, names) => (n.type === 'Identifier' && names.includes(n.name)) || kids(n).some(([, c]) => mentions(c, names));
    const ensureRoute = (r, node, side) => {
      const id = 'route:' + r; let n = nodes.get(id);
      if (!n) { n = { id, name: r, file: u.file, kind: 'route', start: origLine(u, r, L(node)), end: origLine(u, r, node.loc.end.line), parent: null, declared: {}, side }; nodes.set(id, n); }
      else if (side === 'server' && n.side !== 'server') { n.file = u.file; n.start = origLine(u, r, L(node)); n.end = origLine(u, r, node.loc.end.line); n.side = 'server'; }
      return id;
    };
    function p2(node, cur) {
      cur = fnOf(node, cur);
      if (node.type === 'CallExpression') {
        const c = node.callee;
        if (c.type === 'Identifier' && c.name === 'fetch') {
          if (cur.params && cur.params.length && node.arguments.some((a) => mentions(a, cur.params))) owner(cur)._net = true;
          for (const a of node.arguments) for (const p of lits(a, [])) addEdge(owner(cur).id, ensureRoute(p, node, 'missing'), 'network');
        } else if (c.type === 'MemberExpression' && !c.computed && c.object.type === 'Identifier' && CLIENT_OBJ.test(c.object.name) && VERBS.has(c.property.name) && node.arguments[0]) {
          for (const p of lits(node.arguments[0], [])) addEdge(owner(cur).id, ensureRoute(p, node, 'missing'), 'network');
        }
      }
      for (const [, c] of kids(node)) p2(c, cur);
    }
    p2(u.ast, top);

    function routesOf(test) {
      const out = [];
      (function rec(n) {
        if (n.type === 'BinaryExpression' && (n.operator === '===' || n.operator === '==')) {
          const sides = [n.left, n.right];
          const lit = sides.find((s) => s.type === 'Literal' && typeof s.value === 'string' && s.value.startsWith('/'));
          const mem = sides.find((s) => s.type === 'MemberExpression' && !s.computed && s.property.name === 'pathname');
          if (lit && mem) out.push(lit.value);
        }
        for (const [, c] of kids(n)) rec(c);
      })(test);
      return out;
    }
    function target(name, cur) {                 // what does this identifier stand for: a local function, or something imported
      const f = resolve(name, cur); if (f) return f.id;
      const imp = u.imports.get(name);
      if (imp && imp.imported !== '*') return exportTarget(imp.file, imp.imported);
      if (imp) { const t = byFile.get(imp.file); return t && t.top ? t.top.id : null; }
      return null;
    }
    function p3(node, parent, cur, routes) {
      cur = fnOf(node, cur);
      if (node.type === 'IfStatement') {
        const rs = routesOf(node.test);
        if (rs.length) {
          const ids = rs.map((r) => ensureRoute(r, node, 'server'));
          p3(node.test, node, cur, routes); p3(node.consequent, node, cur, ids); if (node.alternate) p3(node.alternate, node, cur, routes);
          return;
        }
      }
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.object.type === 'Identifier' && SERVER_OBJ.test(node.callee.object.name) && VERBS.has(node.callee.property.name) && node.arguments[0] && node.arguments[0].type === 'Literal' && typeof node.arguments[0].value === 'string' && node.arguments[0].value.startsWith('/') && node.arguments.length > 1) {
        const id = ensureRoute(node.arguments[0].value, node, 'server');
        for (const a of node.arguments.slice(1)) {
          if (a.type === 'Identifier') { const t = target(a.name, cur); if (t) addEdge(id, t, 'calls'); }
          else p3(a, node, cur, [id]);
        }
        return;
      }
      if (node.type === 'MemberExpression' && !node.computed && node.object.type === 'Identifier') {
        const on = node.object.name, pn = node.property.name;
        let t = null;
        const lo = objOf(on, cur); if (lo && lo[pn]) t = lo[pn].id;
        const imp = u.imports.get(on);
        if (!t && imp) {
          if (imp.imported === '*') t = exportTarget(imp.file, pn);
          else { const tu = byFile.get(imp.file); const local = tu && tu.exports.get(imp.imported); const holder = tu && local && tu.top.objs[local]; if (holder && holder[pn]) t = holder[pn].id; }
        }
        if (t) { const how = parent.type === 'CallExpression' && parent.callee === node ? 'calls' : 'passes'; for (const from of (routes.length ? routes : [owner(cur).id])) addEdge(from, t, how); return; }
      }
      if (node.type === 'Identifier') {
        const skip = (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) ||
                     (parent.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand) ||
                     ((parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression') && parent.id === node) ||
                     (parent.type === 'VariableDeclarator' && parent.id === node) ||
                     (parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier' || parent.type === 'ImportNamespaceSpecifier' || parent.type === 'ExportSpecifier') ||
                     (parent.type === 'JSXAttribute') || (parent.type === 'MethodDefinition' && parent.key === node) || (parent.type === 'ClassDeclaration' && parent.id === node);
        if (!skip) {
          const t = target(node.name, cur);
          if (t) {
            const tn = nodes.get(t), how = tn && tn.kind === 'data' ? 'uses' : (tn && tn.kind === 'top' ? 'uses' : (parent.type === 'CallExpression' && parent.callee === node ? 'calls' : 'passes'));
            for (const from of (routes.length ? routes : [owner(cur).id])) addEdge(from, t, how);
          }
        }
      }
      if (node.type === 'JSXIdentifier' && /^[A-Z]/.test(node.name) && (parent.type === 'JSXOpeningElement') && parent.name === node) {   // <Component />
        const t = target(node.name, cur);
        if (t) for (const from of (routes.length ? routes : [owner(cur).id])) addEdge(from, t, 'calls');
      }
      if (node.type === 'MemberExpression' && node.computed && node.object.type === 'Identifier' && node.property.type !== 'Literal' &&
          !(node.property.type === 'Identifier' && /^(i|j|k|n|idx|index|pos|len)$/.test(node.property.name)) && !/^(Binary|Update|Unary)Expression$/.test(node.property.type)) {
        // obj[name]: functions reached by a name worked out while the program runs; the map cannot follow those
        const on = node.object.name, imp = u.imports.get(on), lo = objOf(on, cur);
        if (imp && byFile.has(imp.file)) addFact(imp.file, 'dynFrom', u.file);
        else if (lo && Object.keys(lo).length) addFact(u.file, 'dynFrom', u.file);
      }
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.object.type === 'Identifier' &&
          node.callee.object.name === 'path' && /^(join|resolve)$/.test(node.callee.property.name) && node.arguments.length) {
        // path.join(__dirname, 'fixtures', 'shop'): a file or folder of the project named in the code (read as data, run as a command...)
        const parts = node.arguments.map((x) => (x.type === 'Identifier' && x.name === '__dirname') ? '.' : (x.type === 'Literal' && typeof x.value === 'string' ? x.value : null));
        if (parts.every((x) => x !== null) && parts.some((x) => x !== '.')) noteDataRef(u, path.posix.join(...parts), parts[0] === '.');
      }
      if (node.type === 'Literal' && typeof node.value === 'string' && /^\.\.?\//.test(node.value) && parent.type !== 'ImportDeclaration' && parent.type !== 'ExportNamedDeclaration' &&
          parent.type !== 'ExportAllDeclaration' && parent.type !== 'ImportExpression' && !(parent.type === 'CallExpression' && parent.callee.type === 'Identifier' && parent.callee.name === 'require') &&
          !(parent.type === 'CallExpression' && parent.callee.type === 'MemberExpression' && parent.callee.object.type === 'Identifier' && parent.callee.object.name === 'path')) {
        noteDataRef(u, node.value, true);
      }
      if (node.type === 'CallExpression') {
        const cn = node.callee.type === 'Identifier' ? node.callee.name : (node.callee.type === 'MemberExpression' && !node.callee.computed ? node.callee.property.name : '');
        if (node.callee.type === 'Identifier' && node.callee.name === 'require' && node.arguments[0] && node.arguments[0].type !== 'Literal') u._dyn = true;
        if (cn === 'readdirSync' || cn === 'readdir') { (u._dirs = u._dirs || []); (function strs(n) { if (n.type === 'Literal' && typeof n.value === 'string') u._dirs.push(n.value); for (const [, c] of kids(n)) strs(c); })(node); }
      }
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
        const w = resolve(node.callee.name, cur), a0 = node.arguments[0];
        if (w && w._net && a0 && a0.type === 'Literal' && typeof a0.value === 'string' && a0.value.startsWith('/')) addEdge(owner(cur).id, ensureRoute(a0.value, node, 'missing'), 'network');
      }
      for (const [, c] of kids(node)) p3(c, node, cur, routes);
    }
    p3(u.ast, u.ast, top, []);
    if (u._dyn) {   // require(<something not written out>): link to every file in the folder it lists, when the folder is named in the code
      let linked = false;
      for (const lit of u._dirs || []) {
        const d = path.posix.normalize(path.posix.join(path.posix.dirname(u.file), lit));
        for (const f of byFile.keys()) if (f.startsWith(d + '/') && f !== u.file) { addEdge(top.id, 'top:' + f, 'inferred'); linked = true; }
      }
      if (!linked) problems.push({ file: u.file, note: 'loads code by a variable name, so the links from here are unknown' });
    }
  }

  // ---- 4. what each part can do, from its own lines of code (nested named functions are left out)
  const unitOf = new Map(live.map((u) => [u.file, u]));
  const arr = [...nodes.values()];
  for (const n of arr) {
    n.caps = [];
    if (n.kind === 'data' || n.kind === 'top') continue;
    const u = n._unit || unitOf.get(n.file); if (!u) continue;
    const lines = u.code.split('\n'), s = n._tstart || (n.start - (u.lineOffset || 0)), e = n._tend || (n.end - (u.lineOffset || 0));
    if (n.kind === 'route') { if (n.side === 'server') n.caps.push('SRV'); }
    const mask = new Set();
    arr.forEach((c) => { if (c.parent === n.id && c._tstart) for (let i = c._tstart; i <= c._tend; i++) mask.add(i); });
    let txt = ''; for (let i = s; i <= e; i++) if (!mask.has(i)) txt += (lines[i - 1] || '') + '\n';
    for (const [k, re] of Object.entries(CAPS)) if (re.test(txt)) n.caps.push(k);
    if (/\.listen\s*\(/.test(txt)) n.caps.push('SRV');
  }

  for (const e of edges.values()) if (e.to.startsWith('route:') && !nodes.has(e.to)) nodes.set(e.to, { id: e.to, name: e.to.slice(6), file: '(not found on the server)', kind: 'route', start: 0, end: 0, parent: null, side: 'missing', caps: [] });
  const skippedTS = skipped.filter((s) => /TypeScript file/.test(s.why)).length;
  return {
    root: path.basename(root),
    nodes: [...nodes.values()].map((n) => ({ id: n.id, name: n.name, file: n.file, kind: n.kind, start: n.start, end: n.end, scriptStart: n.scriptStart, parent: n.parent, side: n.side, caps: [...new Set(n.caps || [])] })),
    edges: [...edges.values()],
    stats: { files: live.length === 0 ? 0 : new Set(live.map((u) => u.file)).size, functions: [...nodes.values()].filter((n) => n.kind === 'function').length, edges: edges.size, skipped: skipped.length, skippedTypeScript: skippedTS, typescriptSupport: TS ? 'yes' : (skippedTS ? 'no' : 'not needed') },
    skipped, problems, facts, dataRefs, pkg: readPkg(root),
  };
}

module.exports = { analyzeProject };

if (require.main === module) {
  const a = process.argv.slice(2);
  if (!a[0]) { console.error('usage: node fnmap.js <project-folder> [--json out.json]'); process.exit(2); }
  const g = analyzeProject(a[0]);
  const oi = a.indexOf('--json');
  if (oi >= 0) fs.writeFileSync(a[oi + 1], JSON.stringify(g, null, 1)); else process.stdout.write(JSON.stringify(g, null, 1));
}
