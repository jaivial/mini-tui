#!/bin/bash
cd "$(dirname "$0")"
[ -f report.json ] || { echo "FAIL: report.json missing"; exit 1; }
python3 - <<'PY'
import json, csv
exp = {}
with open("sales.csv") as fh:
    for r in csv.DictReader(fh):
        c = r["city"]
        returned = r["returned"].strip().lower() == "true"
        d = exp.setdefault(c, {"orders": 0, "units": 0, "revenue": 0.0, "returned_orders": 0})
        d["orders"] += 1
        if not returned:
            d["units"] += int(r["units"])
            d["revenue"] = round(d["revenue"] + int(r["units"]) * float(r["price"]), 2)
        else:
            d["returned_orders"] += 1
ans = json.load(open("report.json"))
got = ans.get("cities", ans) if isinstance(ans, dict) else ans
ok = True
for city, d in exp.items():
    g = got.get(city)
    if not isinstance(g, dict):
        print("FAIL missing city", city); ok = False; break
    for k, v in d.items():
        gv = g.get(k)
        if k == "revenue":
            if gv is None or abs(float(gv) - v) > 0.05: print("FAIL", city, k, gv, "!=", v); ok = False
        elif gv != v:
            print("FAIL", city, k, gv, "!=", v); ok = False
top = ans.get("top_city") if isinstance(ans, dict) else None
best = max(exp.items(), key=lambda kv: kv[1]["revenue"])[0]
if top and str(top).strip().lower() != best.lower():
    print("FAIL top_city", top, "!=", best); ok = False
print("PASS" if ok else "FAIL")
raise SystemExit(0 if ok else 1)
PY
