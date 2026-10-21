#!/usr/bin/env python3
import json, glob, os, statistics, sys
run = sys.argv[1] if len(sys.argv)>1 else sorted(glob.glob("runs/*"))[-1]
d = json.load(open(os.path.join(run,"summary.json")))
pi_model={}
for f in glob.glob(os.path.join(run,"*.pi.events.jsonl")):
    task=os.path.basename(f).split(".")[0]; s=0
    for line in open(f):
        r=json.loads(line)
        if r.get("type")=="message_end" and (r.get("message") or {}).get("role")=="assistant":
            s+=r["message"].get("durationMs") or 0
    pi_model[task]=s/1000
rows={}
for r in d: rows.setdefault(r["task"],{})[r["harness"]]=r
print(f"| task | mini time (s) | pi time (s) | mini vs pi | mini model calls | pi turns | mini ok | pi ok |")
print("|---|---|---|---|---|---|---|---|")
mw=[];pw=[]
for t in sorted(rows):
    m,p=rows[t]["mini"],rows[t]["pi"]
    mi=m.get("mini_info") or {}
    mw.append(m["wall"]); pw.append(p["wall"])
    print(f"| {t} | {m['wall']:.1f} | {p['wall']:.1f} | {m['wall']/p['wall']:.2f}x slower | {mi.get('apiCalls')} | {p.get('turns')} | {'yes' if m['verify']=='PASS' else 'NO'} | {'yes' if p['verify']=='PASS' else 'NO'} |")
mok=sum(1 for r in d if r["harness"]=="mini" and r["verify"]=="PASS")
pok=sum(1 for r in d if r["harness"]=="pi" and r["verify"]=="PASS")
print(f"\nmini: total {sum(mw):.0f}s mean {statistics.mean(mw):.1f}s median {statistics.median(mw):.1f}s pass {mok}/{len(mw)}")
print(f"pi:   total {sum(pw):.0f}s mean {statistics.mean(pw):.1f}s median {statistics.median(pw):.1f}s pass {pok}/{len(pw)}")
print(f"mini/pi total ratio: {sum(mw)/sum(pw):.2f}x")
tm=sum((r.get("mini_info") or {}).get("sum_model_ms",0) for r in d if r["harness"]=="mini")/1000
th=sum((r.get("mini_info") or {}).get("sum_harness_ms",0) for r in d if r["harness"]=="mini")/1000
tp=sum(pi_model.values())
print(f"\nmini: model {tm:.0f}s ({100*tm/sum(mw):.0f}%), harness-only {th:.1f}s, startup/web/other {sum(mw)-tm-th:.1f}s")
print(f"pi:   model {tp:.0f}s ({100*tp/sum(pw):.0f}%), non-model {sum(pw)-tp:.1f}s")
