import type { TextareaRenderable } from "@opentui/core";

import { findSkillRefs } from "../skills";
import { promptSyntaxStyle } from "./theme";

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
      for (const ref of findSkillRefs(text, known)) {
        area.addHighlightByCharRange({ start: ref.start, end: ref.end, styleId, hlRef: SKILL_HL_REF });
      }
    } catch {
      // renderer torn down between the change and the paint
    }
  }
}
