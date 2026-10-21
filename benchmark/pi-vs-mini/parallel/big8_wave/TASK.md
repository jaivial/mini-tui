# Task: eight independent work items — BIG parts (in parallel)

Eight independent parts; each touches only its own files, so the parts can run
in parallel. Logs use the line format
`<iso-ts> <LEVEL> <service> <latency_ms>ms <message shape...>`.

1. **Log analysis (miss)** — from `logs/miss.log` write `report_miss.md`.
2. **Log analysis (orders)** — from `logs/orders.log` write `report_orders.md`.

   Each report may add prose but must end with EXACTLY six labeled lines
   computed from its own log, not guessed:

       1: <total number of log lines>
       2: <ERROR line count> <ERROR percentage of all lines, one decimal>%
       3: <shape1> <count1>; <shape2> <count2>; <shape3> <count3>
       4: <p50 latency in whole ms> <p95 latency in whole ms>
       5: <UTC hour 00-23 with the most ERROR lines (tie: earliest), two digits>
       6: <service with the most lines overall>

   Item 3: the three most frequent ERROR message shapes (text after the latency
   field), most frequent first. Item 4: p50/p95 over all latency values
   (nearest-rank: sort, take ceil(p/100*n)-th). Each report must end with TWELVE
   labeled lines: those six, plus

       7: <p10 latency in whole ms> <p90 latency in whole ms>
       8: <top5 shape1> <count1>; <shape2> <count2>; <shape3> <count3>; <shape4> <count4>; <shape5> <count5>
       9: <number of distinct ERROR message shapes>
      10: <the three busiest hours by ALL lines, most first, each two digits, comma-separated>
      11: <the service with the highest ERROR rate (errors/lines), 4 decimals>
      12: <total latency in ms summed over all lines>

3. **JS fix (pricing)** — `pricing.js` exports `shipping(subtotalCents)` (750
   flat, 0 when the subtotal is >= 10000) and `handling(items)` (50 per item
   when items > 20, else 0). Exactly THREE wrong behaviors against that spec.
   Fix so `node test_pricing.js` passes; do not change the test.

4. **JS fix (pricing2)** — `pricing2.js` exports `tax(amountCents)` (8% of the
   amount rounded DOWN to whole cents) and `bulkDiscount(qty)` (0.9 when
   qty >= 6, else 1). Exactly THREE wrong behaviors. Fix so
   `node test_pricing2.js` passes; do not change the test.

5. **CSV aggregation (sales)** — `sales.csv` (columns `date,category,cents`).
   Write `totals.json` (part 5) / `totals2.json` (part 6): each category maps to
   `{"total": <sum of cents>, "count": <rows>, "max": <largest cents>}`,
   integer values, every category present. Also write `monthly_<name>.json`:
   each month (YYYY-MM) maps to the same per-category object shape for that
   month; and `top3_<name>.json`: the three categories by total cents as a list
   of `{"category": <name>, "total": <sum>}`, most first.

6. **CSV aggregation (sales2)** — the same spec over `sales2.csv`, written to `totals2.json`,
   `monthly_sales2.json` and `top3_sales2.json` (part 5 writes
   `monthly_sales.json` and `top3_sales.json`).

7. **Python fix (stats)** — `stats.py` provides `median(xs)` (statistical
   median: mean of the two middle values when the length is even) and
   `sample_stdev(xs)` (sample standard deviation, denominator n-1). Exactly THREE
   wrong behaviors. Fix so `python3 test_stats.py` passes; do not change the
   test.

8. **Python fix (stats2)** — `stats2.py` provides `mode(xs)` (most frequent
   value, ties broken by the smallest) and `percentile(xs, p)` (nearest-rank:
   the ceil(p/100*n)-th smallest). Exactly THREE wrong behaviors. Fix so
   `python3 test_stats2.py` passes; do not change the test.

Work only in the current directory.
