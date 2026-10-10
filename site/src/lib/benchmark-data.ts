/**
 * The numbers behind the benchmark charts, taken from `docs/pi-vs-mini-benchmark.md` (sections 8.15,
 * 9 and 11.2) so the graphs and the honest copy cannot drift apart: the page says 0.98x and 40/40,
 * and these are the figures that say so.
 */

/** Per task, medians of the four complete runs (round 5 plus the three round-6 reps). */
export interface TaskBench {
  id: string;
  name: string;
  /** Median seconds over the four runs. */
  mini: number;
  pi: number;
  /** mini / pi, rounded to the two decimals the report prints. */
  ratio: number;
  /** Spread over the four runs, as printed in the report's min-max column. */
  miniRange: string;
  piRange: string;
}

export const TASKS: TaskBench[] = [
  { id: "t10", name: "t10_crash_report", mini: 49.2, pi: 30.0, ratio: 1.64, miniRange: "12.0 – 94.2", piRange: "22.7 – 67.4" },
  { id: "t1", name: "t1_wordfreq", mini: 12.0, pi: 18.4, ratio: 0.65, miniRange: "10.0 – 16.1", piRange: "9.9 – 28.1" },
  { id: "t2", name: "t2_grep_logs", mini: 15.0, pi: 14.5, ratio: 1.03, miniRange: "10.0 – 18.1", piRange: "13.1 – 28.5" },
  { id: "t3", name: "t3_pytest_fix", mini: 12.0, pi: 11.8, ratio: 1.02, miniRange: "10.0 – 20.1", piRange: "11.1 – 16.8" },
  { id: "t4", name: "t4_refactor", mini: 47.1, pi: 53.9, ratio: 0.87, miniRange: "36.1 – 66.2", piRange: "35.9 – 57.7" },
  { id: "t5", name: "t5_script_csv", mini: 9.0, pi: 12.8, ratio: 0.7, miniRange: "8.0 – 12.0", piRange: "10.7 – 17.3" },
  { id: "t6", name: "t6_readme_summary", mini: 18.1, pi: 25.0, ratio: 0.72, miniRange: "14.0 – 20.1", piRange: "18.6 – 36.7" },
  { id: "t7", name: "t7_regex_cli", mini: 23.1, pi: 15.4, ratio: 1.5, miniRange: "10.0 – 32.1", piRange: "11.5 – 28.9" },
  { id: "t8", name: "t8_js_bug", mini: 38.1, pi: 55.7, ratio: 0.68, miniRange: "22.1 – 60.2", piRange: "20.0 – 70.3" },
  { id: "t9", name: "t9_pkg_resize", mini: 19.1, pi: 12.1, ratio: 1.58, miniRange: "8.0 – 26.1", piRange: "9.7 – 17.3" },
];

/** How many of the ten tasks mini took less time on (the report's 5/10 on the median of four runs). */
export const TASKS_WON = TASKS.filter((t) => t.ratio < 1).length;

/**
 * The aggregate ratio each round. Below 1.00x mini is faster. R5 is the single run round 6
 * disproved, so it is flagged: it is plotted, never hidden, and labelled as variance.
 */
export interface RoundPoint {
  round: string;
  ratio: number;
  /** A plain, true caption for the point. */
  note: string;
  /** The single run inside the variance, drawn hollow with a dashed lead-in. */
  variance?: boolean;
  /** Tasks mini won that round. */
  won: string;
  /** True for the round the chart's caption is about. */
  current?: boolean;
}

export const ROUNDS: RoundPoint[] = [
  { round: "R1", ratio: 3.65, won: "2/10", note: "Slow start: harness overhead, write/edit through Python." },
  { round: "R2", ratio: 1.28, won: "3/10", note: "Native write/edit and a leaner prompt: 3.65x became 1.28x." },
  { round: "R3", ratio: 0.95, won: "7/10", note: "Fast path for trivial turns; the median flips to mini." },
  { round: "R4", ratio: 1.07, won: "4/10", note: "Turn duration cut, but the reasoning front appears." },
  { round: "R5", ratio: 0.69, won: "8/10", note: "One run. Round 6 repeated the whole corpus three times and it did not hold.", variance: true },
  { round: "R6", ratio: 0.98, won: "5/10", note: "Median of three fresh reps: 1.13x, 0.98x, 0.93x. A tie with pi.", current: true },
];

/** The tie line the reader looks for: equal wall time. */
export const TIE = 1;

/** The three fresh round-6 reps, so the range behind the median is visible. */
export const REPS: { label: string; ratio: number }[] = [
  { label: "rep 1", ratio: 1.13 },
  { label: "rep 2", ratio: 0.98 },
  { label: "rep 3", ratio: 0.93 },
];

/**
 * Round 7's back-to-back A/B on the system prompt: arm A is what shipped before the clause, arm C
 * is the clause. Median seconds per task, and the paired reps C won.
 */
export interface AbRow {
  id: string;
  name: string;
  a: number;
  c: number;
  ratio: number;
  /** "5/5" style: how many of the paired reps the clause won. */
  paired: string;
  reps: number;
}

export const AB: AbRow[] = [
  { id: "t10", name: "t10_crash_report", a: 53.8, c: 21.2, ratio: 0.39, paired: "5/5", reps: 5 },
  { id: "t7", name: "t7_regex_cli", a: 16.6, c: 10.1, ratio: 0.61, paired: "3/3", reps: 3 },
  { id: "t6", name: "t6_readme_summary", a: 30.5, c: 23.0, ratio: 0.75, paired: "2/2", reps: 2 },
  { id: "t1", name: "t1_wordfreq", a: 8.8, c: 7.8, ratio: 0.89, paired: "1/2", reps: 2 },
  { id: "t8", name: "t8_js_bug", a: 38.3, c: 36.8, ratio: 0.96, paired: "1/4", reps: 4 },
  { id: "t9", name: "t9_pkg_resize", a: 10.2, c: 10.9, ratio: 1.07, paired: "1/4", reps: 4 },
  { id: "t5", name: "t5_script_csv", a: 9.7, c: 11.4, ratio: 1.18, paired: "0/4", reps: 4 },
];

/** Sum of the per-task medians in the A/B table: 167.9 s against 121.3 s. */
export const AB_TOTAL = { a: 167.9, c: 121.3, ratio: 0.72, paired: "13/24", quality: "48/48" };