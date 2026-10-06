/**
 * Same values, read the same way?
 *
 * `Object.is` is not enough for the state this app keeps: a `Record<string, Session>` is a new
 * object every time a merge rebuilds one, and the fields inside it are what the UI actually
 * reads. One level of comparison answers that (the transcripts a session holds are replaced as
 * a whole, never edited field by field), and it is cheap enough to run on every metadata push.
 * Tests: `tests/web-equal.test.ts`.
 */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}
