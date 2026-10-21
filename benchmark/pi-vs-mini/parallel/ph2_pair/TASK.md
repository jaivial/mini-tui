# Task: deep log analyses — two reports from two logs (independent, in parallel)

Two parts that share nothing; each report depends only on its own log, so the
parts can run in parallel. The line format of every log is:

    <iso-ts> <LEVEL> <service> <latency_ms>ms <message shape...>

1. From `logs/miss.log` write `report_miss.md`.
2. From `logs/orders.log` write `report_orders.md`.

Each report: you may add prose, but it must end with EXACTLY six labeled lines
computed from ITS OWN log, not guessed:

    1: <total number of log lines>
    2: <ERROR line count> <ERROR percentage of all lines, one decimal>%
    3: <shape1> <count1>; <shape2> <count2>; <shape3> <count3>
    4: <p50 latency in whole ms> <p95 latency in whole ms>
    5: <UTC hour 00-23 with the most ERROR lines (tie: earliest), two digits>
    6: <service with the most lines overall>

Item 3 is the three most frequent ERROR message shapes (the text after the
latency field), most frequent first, semicolon-separated. Item 4 takes p50 and
p95 over all latency values (nearest-rank: sort, take ceil(p/100*n)-th).
Work only in the current directory.
