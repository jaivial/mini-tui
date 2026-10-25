/** Benchmark data for v0.45.0, generated from the final raw run rows, not historical release copy. */

export interface TaskBench {
  id: string;
  name: string;
  /** Seconds in the final strict run (queue-20261024-222316). */
  mini: number;
  pi: number;
  /** pi / mini worker time, rounded to two decimals. */
  ratio: number;
  miniRange: string;
  piRange: string;
}

export const TASKS: TaskBench[] = [
  { id: "t10", name: "t10_crash_report", mini: 20.5, pi: 54.0, ratio: 2.63, miniRange: "final strict run", piRange: "final strict run" },
  { id: "t1", name: "t1_wordfreq", mini: 6.1, pi: 16.3, ratio: 2.67, miniRange: "final strict run", piRange: "final strict run" },
  { id: "t2", name: "t2_grep_logs", mini: 6.4, pi: 17.8, ratio: 2.78, miniRange: "final strict run", piRange: "final strict run" },
  { id: "t3", name: "t3_pytest_fix", mini: 6.6, pi: 18.8, ratio: 2.85, miniRange: "final strict run", piRange: "final strict run" },
  { id: "t4", name: "t4_refactor", mini: 16.6, pi: 60.4, ratio: 3.64, miniRange: "final strict run", piRange: "final strict run" },
  { id: "t5", name: "t5_script_csv", mini: 14.0, pi: 30.6, ratio: 2.19, miniRange: "final strict run", piRange: "final strict run" },
  { id: "t6", name: "t6_readme_summary", mini: 47.1, pi: 69.5, ratio: 1.48, miniRange: "final strict run", piRange: "final strict run" },
  { id: "t7", name: "t7_regex_cli", mini: 22.8, pi: 49.9, ratio: 2.19, miniRange: "final strict run", piRange: "final strict run" },
  { id: "t8", name: "t8_js_bug", mini: 13.3, pi: 44.2, ratio: 3.32, miniRange: "final strict run", piRange: "final strict run" },
  { id: "t9", name: "t9_pkg_resize", mini: 9.9, pi: 36.1, ratio: 3.65, miniRange: "final strict run", piRange: "final strict run" },
];

export const TASKS_WON = TASKS.filter((t) => t.ratio > 1).length;

export interface RoundPoint {
  round: string;
  ratio: number;
  note: string;
  won: string;
  current?: boolean;
}

/** The optimization path; each run keeps its own pass count and artifact directory. */
export const ROUNDS: RoundPoint[] = [
  { round: "baseline", ratio: 1.52, won: "30/30", note: "Before fast close: 309.8 s mini worker vs 471.8 s pi, 30/30 PASS on both." },
  { round: "fast close", ratio: 1.89, won: "30/30", note: "Verifier-backed fast close: 189.4 s mini worker vs 358.5 s pi, 30/30 PASS on both." },
  { round: "eager", ratio: 2.85, won: "30/30", note: "Eager closure: 111.1 s mini worker vs 316.4 s pi, 30/30 PASS on both." },
  { round: "strict", ratio: 2.43, won: "10/10", note: "Strict verdicts: 163.3 s mini worker vs 397.6 s pi, 10/10 PASS on both.", current: true },
];

/** Three eager repetitions, shown as the observed range rather than hidden variance. */
export const REPS: { label: string; ratio: number }[] = [
  { label: "rep 1", ratio: 2.98 },
  { label: "rep 2", ratio: 2.30 },
  { label: "rep 3", ratio: 4.67 },
];

export const TIE = 1;

export interface AbRow {
  id: string;
  name: string;
  a: number;
  c: number;
  ratio: number;
  paired: string;
  reps: number;
}

/** Worker-only A/B: fast close only against eager, two interleaved repetitions per arm. */
export const AB: AbRow[] = [
  { id: "t10", name: "t10_crash_report", a: 20.9, c: 10.4, ratio: 2.00, paired: "2/2", reps: 2 },
  { id: "t1", name: "t1_wordfreq", a: 10.3, c: 12.4, ratio: 0.83, paired: "0/2", reps: 2 },
  { id: "t2", name: "t2_grep_logs", a: 13.8, c: 5.7, ratio: 2.43, paired: "2/2", reps: 2 },
  { id: "t3", name: "t3_pytest_fix", a: 15.5, c: 4.8, ratio: 3.26, paired: "2/2", reps: 2 },
  { id: "t4", name: "t4_refactor", a: 80.7, c: 16.3, ratio: 4.95, paired: "2/2", reps: 2 },
  { id: "t5", name: "t5_script_csv", a: 17.0, c: 7.0, ratio: 2.41, paired: "2/2", reps: 2 },
  { id: "t6", name: "t6_readme_summary", a: 34.7, c: 17.4, ratio: 1.99, paired: "2/2", reps: 2 },
  { id: "t7", name: "t7_regex_cli", a: 15.4, c: 14.2, ratio: 1.09, paired: "1/2", reps: 2 },
  { id: "t8", name: "t8_js_bug", a: 10.9, c: 9.2, ratio: 1.19, paired: "2/2", reps: 2 },
  { id: "t9", name: "t9_pkg_resize", a: 12.4, c: 9.1, ratio: 1.38, paired: "2/2", reps: 2 },
];

export const AB_TOTAL = { a: 231.7, c: 106.5, ratio: 2.18, paired: "17/20", quality: "40/40" };
