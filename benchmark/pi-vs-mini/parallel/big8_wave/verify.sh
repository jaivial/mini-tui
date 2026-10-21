#!/bin/bash
# Eight BIG parts: two 12-item reports against recomputed ground truth, two code
# fixes with three planted bugs each (their own tests), two CSV triple-aggregates.
cd "$(dirname "$0")"
node test_pricing.js || { echo "FAIL: node test_pricing.js"; exit 1; }
node test_pricing2.js || { echo "FAIL: node test_pricing2.js"; exit 1; }
python3 test_stats.py || { echo "FAIL: python3 test_stats.py"; exit 1; }
python3 test_stats2.py || { echo "FAIL: python3 test_stats2.py"; exit 1; }
python3 - <<'PY'
import collections, json, math, os

def truth12(log):
    lines = open(log).read().splitlines()
    levels = collections.Counter(); shapes = collections.Counter()
    svc = collections.Counter(); svc_err = collections.Counter()
    lats = []; err_hour = collections.Counter(); all_hour = collections.Counter()
    total_lat = 0
    for line in lines:
        p = line.split()
        if len(p) < 5: continue
        ts, level, service, lat, shape = p[0], p[1], p[2], p[3], " ".join(p[4:])
        svc[service] += 1; levels[level] += 1
        try: lv = int(lat.removesuffix("ms"))
        except ValueError: lv = 0
        lats.append(lv); total_lat += lv
        all_hour[ts[11:13]] += 1
        if level == "ERROR":
            shapes[shape] += 1; err_hour[ts[11:13]] += 1; svc_err[service] += 1
    n = len(lines); errors = levels["ERROR"]
    lats.sort()
    q = lambda x: lats[math.ceil(x / 100 * n) - 1]
    top3 = sorted(shapes.items(), key=lambda kv: (-kv[1], kv[0]))[:3]
    top5 = sorted(shapes.items(), key=lambda kv: (-kv[1], kv[0]))[:5]
    worst = min(err_hour, key=lambda h: (-err_hour[h], h)) if err_hour else "00"
    top = sorted(svc.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
    busiest = [h for h, _ in sorted(all_hour.items(), key=lambda kv: (-kv[1], kv[0]))[:3]]
    rate_svc = min(svc_err, key=lambda s: (-(svc_err[s] / svc[s]), s)) if svc_err else top
    rate = f"{svc_err[rate_svc] / svc[rate_svc]:.4f}" if svc_err else "0.0000"
    return {1: [str(n)], 2: [str(errors), f"{errors / n * 100:.1f}"],
            3: [t for pair in top3 for t in (pair[0], str(pair[1]))],
            4: [str(q(50)), str(q(95))], 5: [worst], 6: [top],
            7: [str(q(10)), str(q(90))],
            8: [t for pair in top5 for t in (pair[0], str(pair[1]))],
            9: [str(len(shapes))], 10: [",".join(busiest)],
            11: [rate_svc, rate], 12: [str(total_lat)]}

def check_report(md, log):
    if not os.path.exists(md): return f"FAIL: {md} missing"
    text = open(md).read().lower()
    for num, tokens in truth12(log).items():
        line = next((l for l in text.splitlines() if l.strip().startswith(f"{num}:")), "")
        if not line: return f"FAIL: {md} has no labeled line for item {num}"
        for tok in tokens:
            if str(tok).lower() not in line:
                return f"FAIL: {md} item {num} missing {tok!r} in {line.strip()!r}"
    return None

def per_cat(rows):
    tot = collections.defaultdict(lambda: {"total": 0, "count": 0, "max": 0})
    for month, cat, c in rows:
        t = tot[cat]
        t["total"] += c; t["count"] += 1; t["max"] = max(t["max"], c)
    return dict(sorted(tot.items()))

def check_agg(csv, totals, monthly, top3):
    rows = []
    with open(csv) as f:
        next(f)
        for line in f:
            d, cat, cents = line.strip().split(",")
            rows.append((d[:7], cat, int(cents)))
    bad = []
    if not os.path.exists(totals): return f"FAIL: {totals} missing"
    got = json.load(open(totals))
    if got != per_cat(rows): bad.append(f"FAIL: {totals} wrong")
    if not os.path.exists(monthly): return f"FAIL: {monthly} missing"
    want_m = {}
    for month, _, _ in rows:
        if month not in want_m:
            want_m[month] = per_cat([r for r in rows if r[0] == month])
    if json.load(open(monthly)) != dict(sorted(want_m.items())): bad.append(f"FAIL: {monthly} wrong")
    if not os.path.exists(top3): return f"FAIL: {top3} missing"
    want_t = [{"category": c, "total": t} for c, t in
              sorted(((c, v["total"]) for c, v in per_cat(rows).items()), key=lambda kv: (-kv[1], kv[0]))[:3]]
    if json.load(open(top3)) != want_t: bad.append(f"FAIL: {top3} wrong")
    return bad[0] if bad else None

bad = [r for r in [
    check_report("report_miss.md", "logs/miss.log"),
    check_report("report_orders.md", "logs/orders.log"),
    check_agg("sales.csv", "totals.json", "monthly_sales.json", "top3_sales.json"),
    check_agg("sales2.csv", "totals2.json", "monthly_sales2.json", "top3_sales2.json"),
] if r]
for b in bad: print(b)
print("FAIL" if bad else "PASS")
raise SystemExit(1 if bad else 0)
PY
