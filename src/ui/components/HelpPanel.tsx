import { colors } from "../theme";

/** `/help` — commands and keys at a glance. */
export function HelpPanel() {
  const rows: Array<[string, string]> = [
    ["/model [id]", "switch model — picker, or straight to <id>"],
    ["/new", "start a new session without restarting mini-tui"],
    ["/resume", "browse sessions saved in this folder (search, pages)"],
    ["/connect", "connect a BYOK provider (key → model → connection test)"],
    ["/settings", "output display: collapsed / trimmed (2 lines) / expanded"],
    ["$skill [request]", "run the request with a skill from ~/.claude/skills"],
    ["/help", "this panel"],
    ["/quit  ·  /exit", "close mini-tui"],
    ["Enter", "send the prompt (Alt+Enter / Ctrl+J for a newline)"],
    ["↑ ↓ (prompt)", "recall prompts sent in this session"],
    ["↑ ↓  ·  click", "pick in the command palette (Enter/Tab fills, never sends)"],
    ["Esc", "leave the prompt · double Esc interrupts the run"],
    ["ctrl+c", "clear the prompt · press twice to close"],
    ["j k  ·  e", "move between steps · expand/collapse the focused output"],
    ["PgUp PgDn  ·  g G", "scroll · g loads older steps / G back to live bottom"],
  ];
  return (
    <box borderStyle="rounded" borderColor={colors.border} backgroundColor={colors.panel} width="80%" paddingX={1} gap={0}>
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
