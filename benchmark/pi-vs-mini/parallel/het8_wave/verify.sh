#!/bin/bash
# Eight parts, one check each: reports against recomputed ground truth, the
# code fixes through their own tests, the aggregations against the CSVs.
cd "$(dirname "$0")"
node test_pricing.js || { echo "FAIL: node test_pricing.js"; exit 1; }
node test_pricing2.js || { echo "FAIL: node test_pricing2.js"; exit 1; }
python3 test_stats.py || { echo "FAIL: python3 test_stats.py"; exit 1; }
python3 test_stats2.py || { echo "FAIL: python3 test_stats2.py"; exit 1; }
python3 - <<'PY'
import collections, glob, json, math, os

def truth(log):
    lines = open(log).read().splitlines()
    levels = collections.Counter(); shapes = collections.Counter()
    svc = collections.Counter(); lats = []; err_hour = collections.Counter()
    for line in lines:
        p = line.split()
        if len(p) < 5: continue
        ts, level, service, lat, shape = p[0], p[1], p[2], p[3], " ".join(p[4:])
        svc[service] += 1; levels[level] += 1
        try: lats.append(int(lat.removesuffix("ms")))
        except ValueError: pass
        if level == "ERROR":
            shapes[shape] += 1
            err_hour[ts[11:13]] += 1
    n = len(lines); errors = levels["ERROR"]
    lats.sort()
    p = lambda q: lats[math.ceil(q / 100 * n) - 1]
    top3 = sorted(shapes.items(), key=lambda kv: (-kv[1], kv[0]))[:3]
    worst = min((h for h, _ in err_hour.items()), key=lambda h: (-err_hour[h], h)) if err_hour else "00"
    top = sorted(svc.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
    return {1: [str(n)], 2: [str(errors), f"{errors / n * 100:.1f}"],
            3: [t for pair in top3 for t in (pair[0], str(pair[1]))],
            4: [str(p(50)), str(p(95))], 5: [worst], 6: [top]}

def check_report(md, log):
    if not os.path.exists(md): return f"FAIL: {md} missing"
    text = open(md).read().lower()
    for num, tokens in truth(log).items():
        line = next((l for l in text.splitlines() if l.strip().startswith(f"{num}:")), "")
        if not line: return f"FAIL: {md} has no labeled line for item {num}"
        for tok in tokens:
            if str(tok).lower() not in line:
                return f"FAIL: {md} item {num} missing {tok!r}"
    return None

def check_totals(csv_path, json_path):
    if not os.path.exists(json_path): return f"FAIL: {json_path} missing"
    tot = collections.defaultdict(lambda: {"total": 0, "count": 0, "max": 0})
    with open(csv_path) as f:
        next(f)
        for line in f:
            _, cat, cents = line.strip().split(",")
            c = int(cents); t = tot[cat]
            t["total"] += c; t["count"] += 1; t["max"] = max(t["max"], c)
    want = dict(sorted(tot.items()))
    got = json.load(open(json_path))
    return None if got == want else f"FAIL: {json_path} = {got}, expected {want}"

bad = [r for r in [
    check_report("report_miss.md", "logs/miss.log"),
    check_report("report_orders.md", "logs/orders.log"),
    check_totals("sales.csv", "totals.json"),
    check_totals("sales2.csv", "totals2.json"),
] if r]
for b in bad: print(b)
print("FAIL" if bad else "PASS")
raise SystemExit(1 if bad else 0)
PY
