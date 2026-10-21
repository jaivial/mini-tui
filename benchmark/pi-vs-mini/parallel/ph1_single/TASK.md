# Task: deep log analysis — one report from one log

From `logs/miss.log` write `report_miss.md`. The log's line format is:

    <iso-ts> <LEVEL> <service> <latency_ms>ms <message shape...>

Compute (from the log, not guessed) and write EXACTLY six lines at the end of
the file, one per item, in this labeled form:

    1: <total number of log lines>
    2: <ERROR line count> <ERROR percentage of all lines, one decimal>%
    3: <shape1> <count1>; <shape2> <count2>; <shape3> <count3>
    4: <p50 latency in whole ms> <p95 latency in whole ms>
    5: <UTC hour 00-23 with the most ERROR lines (tie: earliest), two digits>
    6: <service with the most lines overall>

Item 3 is the three most frequent ERROR message shapes (the text after the
latency field), most frequent first, semicolon-separated. Item 4 takes p50 and
p95 over all latency values (nearest-rank: sort, take ceil(p/100*n)-th).
You may add prose before those six lines. Work only in the current directory.
