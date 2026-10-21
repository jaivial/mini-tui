#!/bin/bash
cd "$(dirname "$0")"
[ -f ANALYSIS.md ] || { echo "FAIL: ANALYSIS.md missing"; exit 1; }
python3 - <<'PY'
import re, collections
cnt = collections.Counter(); rt = collections.Counter(); n = collections.Counter()
for line in open("logs/access.log"):
    m = re.search(r'"GET (\S+) HTTP/1\.1" (\d+) \d+ ".*" rt=(\d+)', line)
    if not m: continue
    path, code, t = m.group(1), int(m.group(2)), int(m.group(3))
    cnt[(path, code)] += 1; rt[path] += t; n[path] += 1
failing = [(p, c) for (p, c) in cnt if c >= 500]
worst_rate = max((p, cnt[(p, 500)] + cnt[(p, 503)] if False else 0) for p in set()) if False else None
total_5xx = sum(v for (p, c), v in cnt.items() if c >= 500)
by_route = collections.Counter()
for (p, c), v in cnt.items():
    if c >= 500: by_route[p] += v
worst = by_route.most_common(1)[0]
slowest = max(rt, key=lambda p: rt[p] / n[p])
text = open("ANALYSIS.md").read().lower()
ok = True
for needle, why in [
    (worst[0].lower(), "the failing route"),
    (str(worst[1]), "the 5xx count of that route"),
    (str(total_5xx), "the total 5xx count"),
    (slowest.lower(), "the slowest route by mean rt"),
]:
    if needle not in text:
        print("FAIL: ANALYSIS.md does not mention", why, f"({needle!r})"); ok = False
print("PASS" if ok else "FAIL")
raise SystemExit(0 if ok else 1)
PY
