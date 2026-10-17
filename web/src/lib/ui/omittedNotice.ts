/**
 * The sentence that says what a generative surface left out.
 *
 * Measured against the DEPLOYED build (E23), the caps were the quiet version of the
 * defect E22 closed: `validateList` drew `raw.slice(0, 50)` and `validateTable`
 * `slice(0, 60)` without a word, so a 100-item checklist arrived on screen as a
 * 50-item list that looked complete, and a 100-row table as a 60-row one. The
 * malformed cases were already counted in `skipped`; the cap was not counted at all.
 *
 * A surface that presents itself as complete and is not is worse than one that says
 * so, so both causes get a number and both numbers get drawn. The wording lives here
 * rather than in each component so the table and the list cannot drift apart, and it
 * is here — not in the .svelte files — because that is where `bun test` can hold it
 * without a DOM.
 *
 * The strings for the table are byte-identical to the ones E22 shipped on screen.
 */

export interface OmittedCounts {
  /** Items the model shaped in a way this renderer could not draw. */
  skipped: number;
  /** Items left out because they fell past the draw cap. */
  truncated: number;
  /** The cap itself, so the sentence can say what the limit is instead of only that there is one. */
  cap: number;
  /** Noun in singular and plural: `fila`/`filas`, `elemento`/`elementos`. */
  singular: string;
  plural: string;
  /** What the surface would have been: "una tabla", "una lista". */
  shape: string;
}

/** `""` when nothing was left out, so the caller can guard on the string itself. */
export function omittedNotice({ skipped, truncated, cap, singular, plural, shape }: OmittedCounts): string {
  const parts: string[] = [];
  if (skipped > 0) {
    const one = skipped === 1;
    parts.push(
      `${skipped} ${one ? singular : plural} no ${one ? "tenía" : "tenían"} la forma de ${shape} y se ${one ? "ha" : "han"} omitido.`,
    );
  }
  if (truncated > 0) {
    const one = truncated === 1;
    parts.push(
      `Se ${one ? "ha omitido" : "han omitido"} ${truncated} ${one ? singular : plural} más: el máximo que se dibuja es ${cap}.`,
    );
  }
  return parts.join(" ");
}

/** The table's nouns, kept next to the table so the two never disagree. */
export const TABLE_NOUNS = { singular: "fila", plural: "filas", shape: "una tabla" } as const;
/** The list's nouns. */
export const LIST_NOUNS = { singular: "elemento", plural: "elementos", shape: "una lista" } as const;
