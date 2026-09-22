import { colors } from "../theme";

export function StatusBar(props: { hint?: string }) {
  return (
    <box paddingX={1} flexDirection="row" gap={2}>
      <text fg={colors.faint}>Enter send · Alt+Enter/Ctrl+J newline · Esc navigate · j/k · e expand · PgUp/PgDn · /model · /settings</text>
      {props.hint ? <text fg={colors.dim}>{props.hint}</text> : null}
    </box>
  );
}
