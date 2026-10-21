#!/bin/bash
cd "$(dirname "$0")"
[ -f report.json ] || { echo "FAIL: report.json missing"; exit 1; }
python3 - <<'PY'
import json, re, collections
pat = {
  "NullPointerException": re.compile(r"NullPointerException at (\S+) \((\S+?):(\d+)\)"),
  "TimeoutException": re.compile(r"TimeoutException waiting for (\S+)"),
  "SQLException": re.compile(r"SQLException: (.*)"),
}
counts = collections.Counter(); examples = {}
for line in open("logs/service.log"):
    for name, rx in pat.items():
        m = rx.search(line)
        if m:
            counts[name] += 1
            examples.setdefault(name, m.groups())
            break
ans = json.load(open("report.json"))
def find_all(obj, needle):
    out = []
    def walk(o):
        if isinstance(o, dict):
            for k, v in o.items(): walk(k); walk(v)
        elif isinstance(o, list):
            for v in o: walk(v)
        elif isinstance(o, str):
            out.append(o)
    walk(obj); return out
text = json.dumps(ans)
ok = True
for name, cnt in counts.items():
    if name not in text: print("FAIL: report does not name", name); ok = False
    if str(cnt) not in text: print("FAIL: report does not give the count", cnt, "for", name); ok = False
print("PASS" if ok else "FAIL")
raise SystemExit(0 if ok else 1)
PY
