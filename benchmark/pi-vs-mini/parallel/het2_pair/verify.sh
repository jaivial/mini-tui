#!/bin/bash
# Checks both independent parts: the log report against ground truth recomputed
# from the log, and the JS fix through its own test.
cd "$(dirname "$0")"
node test_pricing.js || { echo "FAIL: node test_pricing.js (pricing.js against spec)"; exit 1; }
python3 - <<'PY'
import collections, glob, math, os

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

md = "report_miss.md"
if not os.path.exists(md):
    print(f"FAIL: {md} missing"); raise SystemExit(1)
text = open(md).read().lower()
want = truth("logs/miss.log")
bad = False
for num, tokens in want.items():
    line = next((l for l in text.splitlines() if l.strip().startswith(f"{num}:")), "")
    if not line:
        print(f"FAIL: {md} has no labeled line for item {num}"); bad = True; continue
    for tok in tokens:
        if str(tok).lower() not in line:
            print(f"FAIL: {md} item {num} missing {tok!r} in {line.strip()!r}"); bad = True
print("FAIL" if bad else "PASS")
raise SystemExit(1 if bad else 0)
PY
