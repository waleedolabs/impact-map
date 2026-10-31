import json, os, re, shutil, subprocess, sys, tempfile

SRC = sys.argv[1]
def sh(cmd, cwd):
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)

g = json.loads(subprocess.run([sys.executable, "-I", os.path.join(os.path.dirname(__file__), "analyze.py"), SRC],
                              capture_output=True, text=True).stdout)
code = [n["id"] for n in g["nodes"] if n["kind"] == "code" and not n["id"].startswith("test/")]

def dependents(target, allow):
    rev = {}
    for e in g["edges"]:
        if e["how"] in allow and not e["from"].startswith("test/"):
            rev.setdefault(e["to"], set()).add(e["from"])
    out, todo = set(), [target]
    while todo:
        for d in rev.get(todo.pop(), ()):
            if d not in out:
                out.add(d); todo.append(d)
    return out

PROBE = "const s=require('./server');console.log(JSON.stringify(Object.keys(s.routes).sort()))"
def routes_of(d):
    r = sh(["node", "-e", PROBE], d)
    return r.stdout.strip() if r.returncode == 0 else "FAIL"

base_routes = routes_of(SRC)
rows = []
for target in code:
    tmp = tempfile.mkdtemp()
    d = os.path.join(tmp, "p"); shutil.copytree(SRC, d)
    os.remove(os.path.join(d, target))
    broken = set()
    for f in code:
        if f == target: continue
        if sh(["node", "-e", "require('./%s')" % f], d).returncode != 0:
            broken.add(f)
    if target != "server.js" and "server.js" not in broken and routes_of(d) != base_routes:
        broken.add("server.js")
    t = sh(["node", "--test"], d)
    m = re.search(r"# fail (\d+)", t.stdout)
    failed_tests = int(m.group(1)) if m else -1
    shutil.rmtree(tmp)
    p_static = dependents(target, {"static", "import"})
    p_full = dependents(target, {"static", "import", "inferred"})
    rows.append((target, broken, p_static, p_full, failed_tests))

print("%-20s %6s %-26s %-26s" % ("deleted", "tests", "static-only (miss/false)", "with inferred (miss/false)"))
tot = [0, 0, 0, 0]
for target, actual, ps, pf, ft in rows:
    ms, fs_ = sorted(actual - ps), sorted(ps - actual)
    mf, ff = sorted(actual - pf), sorted(pf - actual)
    tot[0] += len(ms); tot[1] += len(fs_); tot[2] += len(mf); tot[3] += len(ff)
    print("%-20s %3s/5  miss=%s false=%s | miss=%s false=%s" % (target, ft, ms or "-", fs_ or "-", mf or "-", ff or "-"))
print("TOTAL static-only: missed %d, false alarms %d | with inferred: missed %d, false alarms %d" % tuple(tot))
