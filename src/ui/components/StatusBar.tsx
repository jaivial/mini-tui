import { colors } from "../theme";

export function StatusBar(props: { hint?: string }) {
  return (
    <box borderStyle="single" borderColor={colors.border} paddingX={1} flexDirection="row" gap={2}>
      <text fg={colors.dim}>Enter send · Esc navigate · j/k blocks · e expand · PgUp/PgDn scroll · g/G top/end · /model</text>
      {props.hint ? <text fg={colors.accent}>{props.hint}</text> : null}
    </box>
  );
}
