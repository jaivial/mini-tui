# Benchmark corpus (10 tasks)

Self-contained, terminal-bench-style tasks. Each lives in `tasks/<id>/`, runs in a sandbox copy
`runs/<harness>/<task>/work` and is verified by `verify.sh` (objective, deterministic).

| id | type | asks for |
| --- | --- | --- |
| t1_wordfreq | scripting / log analysis | top-5 words of a 20k-line log, JSON out |
| t2_grep_logs | debugging (JS) | fix the discount tier bug in cart.js |
| t3_pytest_fix | debugging (Python tests) | make 4 pytest cases pass |
| t4_refactor | code editing | ESM refactor + parseDuration hardening |
| t5_script_csv | scripting / data | revenue report from a 500-row CSV |
| t6_readme_summary | log reading | failing-route analysis of an access log |
| t7_regex_cli | coding from scratch | wordcount CLI from a skeleton |
| t8_js_bug | debugging (async JS) | fix the concurrency limiter race |
| t9_pkg_resize | code editing (multi-file pkg) | make shop.prices match its documented contract |
| t10_crash_report | log reading / report | error breakdown of a service log as JSON |
