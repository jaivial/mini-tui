import { colors } from "../theme";

export function Header(props: { model?: string; step: number; cost: number; status: string; spinner: string }) {
  const statusColor = props.status === "error" ? colors.err : props.status === "done" ? colors.ok : colors.text;
  const statusText = props.status === "running" ? `${props.spinner} running` : props.status;
  return (
    <box
      borderStyle="single"
      borderColor={colors.border}
      title="mini-tui"
      titleColor={colors.accent}
      paddingX={1}
      flexDirection="row"
      gap={3}
    >
      <text fg={colors.accent}>mini-tui</text>
      <text fg={colors.dim}>{props.model ?? "default model"}</text>
      <text fg={colors.dim}>step {props.step}</text>
      <text fg={colors.dim}>${props.cost.toFixed(4)}</text>
      <text fg={statusColor}>{statusText}</text>
    </box>
  );
}
