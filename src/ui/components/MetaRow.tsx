import { colors } from "../theme";

/**
 * Quiet meta row under the prompt: selected model · cwd (git branch when applicable)
 * · run stats · status.
 */
export function MetaRow(props: {
  model: string;
  path: string;
  branch: string | null;
  step: number;
  cost: number;
  status: string;
}) {
  const statusColor = props.status === "error" ? colors.err : props.status === "done" ? colors.ok : colors.dim;
  return (
    <box flexDirection="row" gap={2} paddingX={1}>
      <text fg={colors.text}>{props.model}</text>
      <text fg={colors.faint}>·</text>
      <text fg={colors.dim}>{props.path}</text>
      {props.branch ? <text fg={colors.dim}>⎇ {props.branch}</text> : null}
      <text fg={colors.faint}>·</text>
      <text fg={colors.dim}>
        step {props.step} · ${props.cost.toFixed(4)}
      </text>
      {props.status !== "running" ? <text fg={statusColor}>● {props.status}</text> : null}
    </box>
  );
}
