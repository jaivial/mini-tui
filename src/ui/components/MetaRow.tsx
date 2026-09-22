import { colors } from "../theme";

/**
 * Quiet meta row shown below the prompt: selected model · cwd (git branch when
 * applicable) · step · cost · status.
 */
export function MetaRow(props: {
  model: string;
  path: string;
  branch: string | null;
  step: number;
  cost: number;
  status: string;
  spinner: string;
}) {
  const statusColor = props.status === "error" ? colors.err : props.status === "done" ? colors.ok : colors.dim;
  const statusText = props.status === "running" ? `${props.spinner} running` : `● ${props.status}`;
  return (
    <box flexDirection="row" gap={2} paddingX={1}>
      <text fg={colors.text}>{props.model}</text>
      <text fg={colors.faint}>·</text>
      <text fg={colors.dim}>{props.path}</text>
      {props.branch ? <text fg={colors.dim}>⎇ {props.branch}</text> : null}
      <text fg={colors.faint}>·</text>
      <text fg={colors.dim}>step {props.step}</text>
      <text fg={colors.dim}>${props.cost.toFixed(4)}</text>
      <text fg={statusColor}>{statusText}</text>
    </box>
  );
}
