import { colors } from "../theme";

/** Quiet top row: product · model · step · cost · status. */
export function Header(props: { model?: string; step: number; cost: number; status: string; spinner: string }) {
  const statusColor = props.status === "error" ? colors.err : props.status === "done" ? colors.ok : colors.dim;
  const statusText = props.status === "running" ? `${props.spinner} running` : `● ${props.status}`;
  return (
    <box flexDirection="row" gap={2} paddingX={1} paddingY={0}>
      <text fg={colors.text}>mini-tui</text>
      <text fg={colors.faint}>·</text>
      <text fg={colors.dim}>{props.model || "default model"}</text>
      <text fg={colors.faint}>·</text>
      <text fg={colors.dim}>step {props.step}</text>
      <text fg={colors.faint}>·</text>
      <text fg={colors.dim}>${props.cost.toFixed(4)}</text>
      <text fg={statusColor}>{statusText}</text>
    </box>
  );
}
