'use strict';
// fnmap.js <project-dir>
// Function-level map of a small web project: functions, who calls whom, which request hits which server route.
// Reads inline <script> blocks of .html files and .js/.mjs files. Prints JSON.
const fs = require('fs');
const path = require('path');
const acorn = require('/opt/node-tools/node_modules/acorn');

const root = path.resolve(process.argv[2]);
const SKIP = new Set(['node_modules', '.git', 'dist', 'build']);

function files(dir, out) {
  for (const n of fs.readdirSync(dir).sort()) {
    if (SKIP.has(n)) continue;
    const p = path.join(dir, n);
    if (fs.statSync(p).isDirectory()) files(p, out);
    else if (/\.(html|js|mjs|cjs)$/.test(n)) out.push(p);
  }
  return out;
}

// ---- 1. source units (a .js file, or one inline <script> of an .html file) ----------------
const units = [];
for (const p of files(root, [])) {
  const rel = path.relative(root, p);
  const text = fs.readFileSync(p, 'utf8');
  if (p.endsWith('.html')) {
    const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
    let m;
    while ((m = re.exec(text))) {
      const upto = text.slice(0, m.index + m[0].indexOf('>') + 1);
      units.push({ file: rel, code: m[1], lineOffset: upto.split('\n').length - 1, module: false });
    }
  } else {
    units.push({ file: rel, code: text, lineOffset: 0, module: /^\s*(export|import)\s/m.test(text) });
  }
}

const nodes = new Map();   // id -> node
const edges = new Map();   // "from|to|how" -> {from,to,how,n}
const problems = [];
function addEdge(from, to, how) {
  if (!from || !to || from === to) return;
  const k = from + '|' + to + '|' + how;
  const e = edges.get(k);
  if (e) e.n++; else edges.set(k, { from, to, how, n: 1 });
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

for (const u of units) {
  let ast;
  try {
    ast = acorn.parse(u.code, { ecmaVersion: 'latest', sourceType: u.module ? 'module' : 'script', locations: true });
  } catch (e) {
    try { ast = acorn.parse(u.code, { ecmaVersion: 'latest', sourceType: u.module ? 'script' : 'module', locations: true }); }
    catch (e2) { problems.push({ file: u.file, note: 'could not parse: ' + e2.message }); continue; }
  }
  const L = (n) => n.loc.start.line + u.lineOffset;
  const LE = (n) => n.loc.end.line + u.lineOffset;

  const top = { id: 'top:' + u.file, name: '(page code)', file: u.file, kind: 'top', start: 1 + u.lineOffset, end: LE(ast), parent: null, declared: {}, params: [], net: false };
  nodes.set(top.id, top);

  // ---- pass 1: define functions and big data tables ----
  function define(name, node, cur, kind) {
    const f = { id: u.file + ':' + name + '@' + L(node), name, file: u.file, kind, start: L(node), end: LE(node), parent: cur, declared: {}, params: [], net: false };
    if (kind === 'function') f.params = node.params.filter((p) => p.type === 'Identifier').map((p) => p.name);
    nodes.set(f.id, f);
    cur.declared[name] = f;
    return f;
  }
  function p1(node, cur) {
    let next = cur;
    if (node.type === 'FunctionDeclaration' && node.id) {
      node.__fn = define(node.id.name, node, cur, 'function'); next = node.__fn;
    } else if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) {
      if (isFn(node.init)) node.init.__fn = define(node.id.name, node.init, cur, 'function');
      else if ((node.init.type === 'ObjectExpression' || node.init.type === 'ArrayExpression') && cur === top && LE(node.init) - L(node.init) >= 12) {
        define(node.id.name, node, cur, 'data');
      }
    } else if (isFn(node) && !node.__fn) {
      node.__fn = { anon: true, parent: cur, declared: {}, params: node.params.filter((q) => q.type === 'Identifier').map((q) => q.name), net: false };
    }
    if (isFn(node) && node.__fn) next = node.__fn;
    for (const [, c] of kids(node)) p1(c, next);
  }
  p1(ast, top);

  function resolve(name, cur) {
    for (let f = cur; f; f = f.parent) {
      if (f.params && f.params.includes(name)) return null;   // a parameter with the same name hides the function
      if (f.declared[name]) return f.declared[name];
    }
    return null;
  }
  const fnOf = (n, cur) => (isFn(n) && n.__fn) ? n.__fn : cur;
  const owner = (f) => { while (f.anon) f = f.parent; return f; };
  const lits = (n, acc) => {   // string literals beginning with "/" inside n
    if (n.type === 'Literal' && typeof n.value === 'string' && /^\/[a-z][\w/-]*$/i.test(n.value)) acc.push(n.value);
    for (const [, c] of kids(n)) lits(c, acc);
    return acc;
  };
  const mentions = (n, names) => {
    if (n.type === 'Identifier' && names.includes(n.name)) return true;
    return kids(n).some(([, c]) => mentions(c, names));
  };

  // ---- pass 2: which functions send requests, and to which fixed paths ----
  function p2(node, cur) {
    cur = fnOf(node, cur);
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'fetch') {
      if (cur.params.length && node.arguments.some((a) => mentions(a, cur.params))) owner(cur).net = true;   // path comes from a parameter: a wrapper
      for (const a of node.arguments) for (const p of lits(a, [])) addEdge(owner(cur).id, 'route:' + p, 'network');
    }
    for (const [, c] of kids(node)) p2(c, cur);
  }
  p2(ast, top);

  // ---- pass 3: calls and references; calls to a request wrapper with a fixed path ----
  // server routes: if (... pathname === "/x" ...) { ... }
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
  function p3(node, parent, cur, routes) {
    cur = fnOf(node, cur);
    if (node.type === 'IfStatement') {
      const rs = routesOf(node.test);
      if (rs.length) {
        for (const r of rs) {
          const id = 'route:' + r;
          let n = nodes.get(id);
          if (!n) { n = { id, name: r, file: u.file, kind: 'route', start: L(node), end: LE(node), parent: null, declared: {}, side: 'server' }; nodes.set(id, n); }
          else if (n.file !== u.file) { n.file = u.file; n.start = L(node); n.end = LE(node); n.side = 'server'; }
        }
        p3(node.test, node, cur, routes);
        p3(node.consequent, node, cur, rs.map((r) => 'route:' + r));
        if (node.alternate) p3(node.alternate, node, cur, routes);
        return;
      }
    }
    if (node.type === 'Identifier') {
      const skip = (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) ||
                   (parent.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand) ||
                   ((parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression') && parent.id === node) ||
                   (parent.type === 'VariableDeclarator' && parent.id === node);
      if (!skip) {
        const target = resolve(node.name, cur);
        if (target) {
          const how = target.kind === 'data' ? 'uses' : (parent.type === 'CallExpression' && parent.callee === node ? 'calls' : 'passes');
          for (const from of (routes.length ? routes : [owner(cur).id])) addEdge(from, target.id, how);
        }
      }
    }
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
      const w = resolve(node.callee.name, cur);
      const a0 = node.arguments[0];
      if (w && w.net && a0 && a0.type === 'Literal' && typeof a0.value === 'string' && a0.value.startsWith('/')) addEdge(owner(cur).id, 'route:' + a0.value, 'network');
    }
    for (const [, c] of kids(node)) p3(c, node, cur, routes);
  }
  p3(ast, ast, top, []);
}

// client-side placeholders for routes that only the client mentions
for (const e of edges.values()) {
  if (e.to.startsWith('route:') && !nodes.has(e.to)) nodes.set(e.to, { id: e.to, name: e.to.slice(6), file: '(not found on the server)', kind: 'route', start: 0, end: 0, parent: null, side: 'missing' });
}

const out = {
  root: path.basename(root),
  nodes: [...nodes.values()].map((n) => ({ id: n.id, name: n.name, file: n.file, kind: n.kind, start: n.start, end: n.end, parent: n.parent ? n.parent.id : null, side: n.side })),
  edges: [...edges.values()],
  problems,
};
process.stdout.write(JSON.stringify(out, null, 1));
