import { colors } from "../theme";

/** `/help` — commands and keys at a glance. */
export function HelpPanel() {
  const rows: Array<[string, string]> = [
    ["/model [id]", "switch model — picker, or straight to <id>"],
    ["/resume", "browse sessions saved in this folder (search, pages)"],
    ["/settings", "output display: collapsed / trimmed (2 lines) / expanded"],
    ["/help", "this panel"],
    ["/quit  ·  /exit", "close mini-tui"],
    ["Enter", "send the prompt (Alt+Enter / Ctrl+J for a newline)"],
    ["↑ ↓  ·  click", "pick in the command palette (Enter/Tab fills, never sends)"],
    ["Esc", "leave the prompt · double Esc closes (interrupts the run)"],
    ["ctrl+c", "clear the prompt · twice (or on empty) closes"],
    ["j k  ·  e", "move between steps · expand/collapse the focused output"],
    ["PgUp PgDn  ·  g G", "scroll · top / bottom"],
  ];
  return (
    <box borderStyle="rounded" borderColor={colors.border} paddingX={1} gap={0}>
      <text fg={colors.dim}>help · Esc close</text>
      {rows.map(([key, detail]) => (
        <box key={key} flexDirection="row" gap={2}>
          <text fg={colors.text}>{key}</text>
          <text fg={colors.dim}>{detail}</text>
        </box>
      ))}
    </box>
  );
}
