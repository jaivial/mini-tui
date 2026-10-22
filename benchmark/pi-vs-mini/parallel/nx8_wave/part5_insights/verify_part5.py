import csv, json, collections

rows = lambda p: list(csv.DictReader(open(p)))
orders = rows("orders.csv")
cust = {r["customer_id"]: r["country"] for r in rows("customers.csv")}
items = {r["item_id"]: r["category"] for r in rows("items.csv")}
rev = collections.Counter(); units = collections.Counter(); per_cust = collections.Counter()
month_sum = collections.Counter(); month_n = collections.Counter(); months = set()
over = 0; total = 0
for o in orders:
    a = int(o["amount_cents"]); q = int(o["qty"])
    m = o["date"][:7]
    rev[cust[o["customer_id"]]] += a
    units[items[o["item_id"]]] += q
    per_cust[o["customer_id"]] += a
    month_sum[m] += a; month_n[m] += 1; months.add(m)
    total += a
    if a > 10000: over += 1
want = {
    "revenue_by_country": dict(sorted(rev.items())),
    "top_category": sorted(units.items(), key=lambda kv: (-kv[1], kv[0]))[0][0],
    "aov_by_month": {m: month_sum[m] // month_n[m] for m in sorted(month_sum)},
    "best_customer": sorted(per_cust.items(), key=lambda kv: (-kv[1], kv[0]))[0][0],
    "orders_over_10k": over,
    "units_by_category": dict(sorted(units.items())),
    "revenue_total": total,
    "months_active": len(months),
}
got = json.load(open("insights.json"))
bad = [k for k in want if got.get(k) != want[k]]
for k in bad:
    print(f"FAIL: insights[{k}] = {got.get(k)!r}, expected {want[k]!r}")
raise SystemExit(1 if bad else 0)
