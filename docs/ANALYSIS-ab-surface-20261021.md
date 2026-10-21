# Surface A/B: Xiaomi token-plan `/v1` vs `/anthropic` — mini-direct, MiMo V2.6 Flash

Date: 2026-10-21. Corpus: `benchmark/pi-vs-mini` 10 tasks (fixtures restored — see below).
Harness: mini-tui-web `MINI_AGENT_DEPTH=1` (mini-direct), identical code and prompts in both
mini arms; the ONLY variable between them is `XIAOMI_API_BASE` in the saved xiaomi connection.
pi runs through its `xiaomi-anthropic` custom provider (models.json). One repetition per arm;
load 0.4-2.5 during the run; runs `20261021-183538` (/v1), `20261021-185846` (/anthropic),
`20261021-190923` (pi). Both mini arms carry the same-day P0 (oracle cap + gap sanitizer +
pre-existing-file protection) and P1/B2 (router + fan-out policy + Spanish work markers) —
the endpoint A/B is clean; the comparison against YESTERDAY's numbers is not (code changed).

## Results

| task | mini /v1 | mini /anth | pi /anth | anth/v1 | pi/anth |
|---|---|---|---|---|---|
| t10_crash_report | 52.6 | 64.6 | 64.5 | 1.23x | 1.00x |
| t1_wordfreq | 72.1 | 56.1 | 36.3 | 0.78x | 0.65x |
| t2_grep_logs | 34.1 | 36.1 | 43.4 | 1.06x | 1.20x |
| t3_pytest_fix | 46.1 | 34.0 | 20.3 | 0.74x | 0.60x |
| t4_refactor | 162.2 | 122.1 | 112.3 | 0.75x | 0.92x |
| t5_script_csv | 56.1 | 52.1 | 52.9 | 0.93x | 1.02x |
| t6_readme_summary | 68.1 | 66.1 | 71.9 | 0.97x | 1.09x |
| t7_regex_cli | 786.9 | 122.2 | 69.9 | **0.16x** | 0.57x |
| t8_js_bug | 56.1 | 48.1 | 48.0 | 0.86x | 1.00x |
| t9_pkg_resize | 50.1 | 34.1 | 31.4 | 0.68x | 0.92x |
| **TOTAL** | **1384.4** | **635.5** | **550.9** | **0.46x** | **0.87x** |
| median | 56.1 | 54.1 | 50.5 | | |
| model calls | 76 | 68 | — | | |
| model time | 885.9 s | 434.6 s | — | | |
| s per call | 11.7 | 6.4 | — | | |
| PASS | 10/10 | 10/10 | 10/10 | | |

## Findings

1. **The `/anthropic` surface with rolling cache_control is 2.18x faster wall-clock at the same
   10/10 quality** (635.5 s vs 1384.4 s). Model time halved (885.9 → 434.6 s) and calls fell
   (76 → 68). Measured cache coverage on t7-anth: 86.3 % of input tokens served from cache
   (25,152 cached vs 3,985 uncached).
2. **Per-call model time: 11.7 → 6.4 s** — below pi's 7.4 s/turn measured the day before. The
   prefill-dominated turn cost that made mini lose the per-turn multiplicand is gone.
3. **t7_regex_cli — yesterday's disaster (1192.8 s direct) — is now 122.2 s on /anthropic**
   (0.16x of today's /v1 arm at 786.9 s; 20 → 7 calls, 22.8 → 5.2 s/call). Without t7 the A/B
   gain is 0.86x — the long-context tasks are where caching pays.
4. **pi's lead over mini-direct collapsed from 4.3x to 0.87x** (pi 550.9 s vs mini 635.5 s;
   medians 50.5 vs 54.1), with a three-way 10/10 tie. mini-direct now wins or ties 6 of 10
   tasks. The remaining gap is ~85 s over the corpus, concentrated in t1/t3/t7.
5. **Corpus repair (required for these numbers):** t1/t6/t10 referenced log fixtures that were
   never committed; the first A/B run burned hundreds of seconds per arm on agents hunting
   files that did not exist (t6: 45+ turns). `tasks/gen_fixtures.py` regenerates the three
   seeded logs and `run_bench.py` restores them automatically; `NODE`/`PI` launcher paths now
   resolve from env/PATH (the hardcoded nvm paths made the whole pi arm fail in 0.1 s).

## Caveats

One repetition per arm (prior rounds measured up to 8x per-task variance across reps with a
constant-quality model); totals and pass rates are the signal, per-task winners are noise-prone.
t7-v1 (786.9 s) inflates the headline ratio: excluding it the gain is 0.86x. The pi arm is a
first measurement of pi over the /anthropic surface on this corpus (yesterday it ran /v1).

## Where this leaves the two goals

- **Goal A (direct faster than pi, same pass rate):** from 4.3x behind to 0.87x — parity within
  noise on medians. To overtake: P2 short-task prompt (steps/task still 6.8 vs pi's 5.6),
  P3 lean context, and multi-rep confirmation.
- **Goal B (delegation ≈Nx):** untested here — needs the orchestrator arm plus a decomposable
  corpus. The fan-out machinery + policy are in place (`agent_delegate tasks:[...]`, one-wave
  launch); Amdahl's s should now be smaller thanks to the same cache lever (every worker reads
  the inherited prefix from cache).
