import sys, os, re, json

SKIP = {"node_modules", ".git", "dist", "build", "__pycache__", ".venv"}
CODE = (".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py")
REQ = re.compile(r"""(?:require\(\s*|from\s+|import\s+|import\(\s*)['"]([^'"]+)['"]""")
REQ_DYN = re.compile(r"""require\(\s*(?!['"\s])([^)\n]{1,60})""")   # require(<anything that is not a plain string>)
READDIR = re.compile(r"""readdirSync\(([^;]*)\)""")
PY_IMP = re.compile(r"^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))", re.M)

def walk(root):
    for d, dirs, files in os.walk(root):
        dirs[:] = sorted(x for x in dirs if x not in SKIP)
        for f in sorted(files):
            yield os.path.relpath(os.path.join(d, f), root)

def resolve(root, src, spec):
    base = os.path.normpath(os.path.join(os.path.dirname(src), spec))
    if base.startswith(".."):
        return None   # points outside the project folder
    for cand in [base] + [base + e for e in CODE] + [os.path.join(base, "index" + e) for e in CODE]:
        if os.path.isfile(os.path.join(root, cand)):
            return cand
    return None

def main(root):
    files = list(walk(root))
    nodes, edges, dynamic, external = [], [], [], {}
    for f in files:
        kind = "code" if f.endswith(CODE) else "asset"
        nodes.append({"id": f, "kind": kind})
        if kind != "code":
            continue
        text = open(os.path.join(root, f), encoding="utf-8", errors="replace").read()
        if f.endswith(".py"):
            for m in PY_IMP.finditer(text):
                mod = (m.group(1) or m.group(2)).replace(".", "/")
                for cand in (mod + ".py", mod + "/__init__.py"):
                    if os.path.isfile(os.path.join(root, cand)):
                        edges.append({"from": f, "to": cand, "how": "import"}); break
            continue
        for m in REQ.finditer(text):
            spec = m.group(1)
            if spec.startswith("."):
                t = resolve(root, f, spec)
                if t: edges.append({"from": f, "to": t, "how": "static"})
                else: dynamic.append({"file": f, "note": "relative import not found inside project: " + spec})
            elif not spec.startswith("node:"):
                external.setdefault(f, []).append(spec)
        dyn_here = [m.group(1).strip() for m in REQ_DYN.finditer(text)]
        for expr in dyn_here:
            dynamic.append({"file": f, "note": "loads code by expression: require(%s)" % expr})
        if dyn_here:
            # heuristic: a folder listed with readdirSync(...'name') and then require()d => links to every file inside
            for m in READDIR.finditer(text):
                for lit in re.findall(r"""['"]([\w./-]+)['"]""", m.group(1)):
                    d = os.path.normpath(os.path.join(os.path.dirname(f), lit))
                    if os.path.isdir(os.path.join(root, d)) and not d.startswith(".."):
                        for g in files:
                            if g.startswith(d + os.sep) and g.endswith(CODE):
                                edges.append({"from": f, "to": g, "how": "inferred"})
    seen, uniq = set(), []
    for e in edges:
        k = (e["from"], e["to"], e["how"])
        if k not in seen:
            seen.add(k); uniq.append(e)
    edges = uniq
    print(json.dumps({"root": os.path.basename(os.path.abspath(root)),
                      "nodes": nodes, "edges": edges,
                      "dynamic_or_unknown": dynamic, "external": external},
                     ensure_ascii=False, indent=1))

if __name__ == "__main__":
    main(sys.argv[1])
