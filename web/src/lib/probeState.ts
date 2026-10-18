/**
 * State helpers for the hosts panel's "Test" button.
 *
 * They exist because of a defect that only showed up in the deployed build: the panel kept its
 * probe verdicts in a plain `Record`, and clearing one went through `new Map(record)`. That
 * throws `TypeError: object is not iterable`, and it threw BEFORE the `try`, so the `catch`
 * never saw it: the button switched to "Testing" and no request ever left the browser. Measured
 * with CDP: zero network requests for the click, `probing` stuck forever.
 *
 * The rules are here, without Svelte, so a test can hold them.
 */

export type ProbeVerdict = { ok: boolean; message: string };
export type ProbeResults = Record<string, ProbeVerdict>;

/** Drop one host's verdict, so a row that is being re-tested cannot show the old answer. */
export function withoutVerdict(results: ProbeResults, id: string): ProbeResults {
  const { [id]: _dropped, ...rest } = results;
  return rest;
}

/** Record one host's verdict. */
export function withVerdict(results: ProbeResults, id: string, verdict: ProbeVerdict): ProbeResults {
  return { ...results, [id]: verdict };
}

/**
 * Whether a cancel is worth telling the user about. An `AbortError` is us cancelling, not a host
 * that failed, and painting it red would report a working host as broken.
 */
export function isCancel(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
