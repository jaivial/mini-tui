import type { TextareaRenderable } from "@opentui/core";

import { findSkillRefs } from "../skills";
import { promptSyntaxStyle } from "./theme";
import { tabWidthOf, toHighlightOffset } from "./textOffsets";

/** Highlight ref shared by every skill span (cleared and redrawn on each change). */
const SKILL_HL_REF = 7301;

/** Paint the known `$skill` references of the prompt buffer in the skill color. */
export class SkillHighlighter {
  private last = "";

  apply(area: TextareaRenderable | null, text: string, known: Set<string>): void {
    if (!area) return;
    const key = `${text}\u0000${known.size}`;
    if (key === this.last && area.syntaxStyle === promptSyntaxStyle) return;
    this.last = key;
    try {
      if (area.syntaxStyle !== promptSyntaxStyle) area.syntaxStyle = promptSyntaxStyle;
      area.removeHighlightsByRef(SKILL_HL_REF);
      const styleId = promptSyntaxStyle.getStyleId("skill");
      if (styleId === null) return;
      // The textarea's highlight offsets are display columns without newlines, not string
      // indices: raw indices drifted onto the next word after a newline, tab or wide char.
      const tabWidth = tabWidthOf(area);
      for (const ref of findSkillRefs(text, known)) {
        const start = toHighlightOffset(text, ref.start, tabWidth);
        const end = toHighlightOffset(text, ref.end, tabWidth);
        area.addHighlightByCharRange({ start, end, styleId, hlRef: SKILL_HL_REF });
      }
    } catch {
      // renderer torn down between the change and the paint
    }
  }
}
