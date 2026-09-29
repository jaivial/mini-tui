/**
 * Commands and skills picked in the prompt bar live as chips, not as text.
 *
 * A textarea cannot render an inline element, and styling the text in an overlay breaks the caret the
 * moment padding changes a glyph's width. So a pick is lifted out of the text into a chip rail above
 * the field, and put back together as plain text only when the message is sent. The text field stays
 * a plain textarea: IME, autocorrect, copy and paste and screen readers all keep working.
 */

export interface Chip {
  kind: "command" | "skill";
  /** `model`, `pr-body`: no sigil. */
  name: string;
}

export const chipText = (chip: Chip): string => (chip.kind === "command" ? `/${chip.name}` : `$${chip.name}`);

/**
 * A command is the whole message (`/model x`), so there is at most one, and it excludes skills; a skill
 * is added once. Anything that would break those rules is a no-op, never a silent replacement.
 */
export function addChip(chips: Chip[], chip: Chip): Chip[] {
  if (chip.kind === "command") return chips.length ? chips : [chip];
  if (chips.some((c) => c.kind === "command")) return chips;
  return chips.some((c) => c.name === chip.name) ? chips : [...chips, chip];
}

export function removeChip(chips: Chip[], index: number): Chip[] {
  return chips.filter((_, i) => i !== index);
}

/** The message as it is sent: the command or the `$skills` first, then what was typed. */
export function composePrompt(chips: Chip[], text: string): string {
  return [...chips.map(chipText), text.trim()].filter(Boolean).join(" ");
}

/** Whether there is anything to send: text, or a command (which is a complete message on its own). */
export function hasMessage(chips: Chip[], text: string): boolean {
  return !!text.trim() || chips.some((c) => c.kind === "command");
}

/** "Skill pr-body added": what a screen reader hears when the rail changes. */
export function announce(action: "added" | "removed", chip: Chip): string {
  return `${chip.kind === "command" ? "Command" : "Skill"} ${chip.name} ${action}`;
}
