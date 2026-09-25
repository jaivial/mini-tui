/**
 * OpenTUI's textarea does not address text by JS string index:
 *   - `cursorOffset` counts display columns per grapheme (`中` = 2, a tab = the tab width,
 *     `é`/`e\u0301` = 1) and 1 per newline;
 *   - `addHighlightByCharRange` counts the same display columns but *skips* newlines.
 * The prompt logic (`$skill` tokens, completion) works on JS indices, so every range going in
 * or coming out of the textarea is converted here. Mixing the two was why a `$skill` after a
 * newline, a tab or a wide character painted the next word's letters instead.
 *
 * Known limit: ZWJ emoji sequences (`👨‍👩‍👧`) are laid out per member by OpenTUI's highlighter
 * but as one grapheme by its cursor; a `$skill` after one can still be off by a column or two.
 */

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemeWidth(grapheme: string, tabWidth: number): number {
  if (grapheme === "\t") return tabWidth;
  return Math.max(1, Bun.stringWidth(grapheme));
}

/** JS string index → textarea cursor offset (display columns per grapheme, newline = 1). */
export function toCursorOffset(text: string, index: number, tabWidth = 2): number {
  let offset = 0;
  for (const { segment, index: at } of segmenter.segment(text)) {
    if (at + segment.length > index) break;
    offset += segment === "\n" || segment === "\r\n" ? 1 : graphemeWidth(segment, tabWidth);
  }
  return offset;
}

/**
 * JS string index → `addHighlightByCharRange` offset. Measured against OpenTUI 0.5: each
 * grapheme takes its display width plus one per extra code point (`é` as e + U+0301 = 2,
 * `👍🏽` = 3, a tab = the tab width), newlines take none.
 */
export function toHighlightOffset(text: string, index: number, tabWidth = 2): number {
  let offset = 0;
  for (const { segment, index: at } of segmenter.segment(text)) {
    if (at + segment.length > index) break;
    if (segment === "\n" || segment === "\r\n") continue;
    offset += graphemeWidth(segment, tabWidth) + [...segment].length - 1;
  }
  return offset;
}

/** Textarea cursor offset → JS string index (an offset inside a wide grapheme rounds up). */
export function fromCursorOffset(text: string, offset: number, tabWidth = 2): number {
  let at = 0;
  for (const { segment, index } of segmenter.segment(text)) {
    if (at >= offset) return index;
    at += segment === "\n" || segment === "\r\n" ? 1 : graphemeWidth(segment, tabWidth);
  }
  return text.length;
}

/** Tab width of a textarea's edit buffer (OpenTUI's default, 2, when it can't be read). */
export function tabWidthOf(area: { editBuffer?: { getTabWidth(): number } } | null | undefined): number {
  try {
    const width = area?.editBuffer?.getTabWidth();
    return typeof width === "number" && width > 0 ? width : 2;
  } catch {
    return 2;
  }
}
