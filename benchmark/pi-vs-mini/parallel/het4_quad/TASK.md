# Task: four independent work items (in parallel)

Four independent parts that touch only their own files, so the parts can run in
parallel.

1. **Log analysis** — from `logs/miss.log` write `report_miss.md`. The log line
   format is `<iso-ts> <LEVEL> <service> <latency_ms>ms <message shape...>`.
   You may add prose, but the file must end with EXACTLY six labeled lines
   computed from the log, not guessed:

       1: <total number of log lines>
       2: <ERROR line count> <ERROR percentage of all lines, one decimal>%
       3: <shape1> <count1>; <shape2> <count2>; <shape3> <count3>
       4: <p50 latency in whole ms> <p95 latency in whole ms>
       5: <UTC hour 00-23 with the most ERROR lines (tie: earliest), two digits>
       6: <service with the most lines overall>

   Item 3 is the three most frequent ERROR message shapes (the text after the
   latency field), most frequent first, semicolon-separated. Item 4 takes p50
   and p95 over all latency values (nearest-rank: sort, take ceil(p/100*n)-th).

2. **JS fix** — `pricing.js` exports `price(unit, qty)`. Spec: quantity `>= 10`
   gets 15% off, quantity `>= 5` gets 5% off, none otherwise; the result is
   rounded to whole cents. The implementation has exactly two wrong behaviors
   against that spec. Fix the code so `node test_pricing.js` passes. Do not
   change the test file.


3. **CSV aggregation** — `sales.csv` has columns `date,category,cents`. Write
   `totals.json`: a JSON object mapping each category to
   `{"total": <sum of cents>, "count": <number of rows>, "max": <largest cents>}`,
   computed from the file, with every category present and integer values.

4. **Python fix** — `stats.py` provides `median(xs)` and `sample_stdev(xs)`.
   Spec: the median is the statistical median (the mean of the two middle values
   for even lengths); `sample_stdev` is the sample standard deviation
   (denominator n-1). The implementation has exactly two wrong behaviors against
   that spec. Fix the code so `python3 test_stats.py` passes. Do not change the
   test file.

Work only in the current directory.
