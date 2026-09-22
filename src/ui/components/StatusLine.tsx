import { colors } from "../theme";

const FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];
const BAR_CELLS = 10;

/**
 * The single info line below the prompt: animated load state while the agent
 * works, plus model · path (git branch) · step · cost · status.
 */
export function StatusLine(props: {
  model: string;
  path: string;
  branch: string | null;
  step: number;
  cost: number;
  status: string;
  tick: number;
  elapsedS: number;
}) {
  const statusColor = props.status === "error" ? colors.err : props.status === "done" ? colors.ok : colors.dim;
  const running = props.status === "running";
  const head = props.tick % BAR_CELLS;
  const bar = Array.from({ length: BAR_CELLS }, (_, i) => (i === head ? "▓" : "░")).join("");
  return (
    <box flexDirection="row" gap={2} paddingX={1} height={1}>
      {running ? (
        <>
          <text fg={colors.accent}>{FRAMES[props.tick % FRAMES.length]}</text>
          <text fg={colors.faint}>{bar}</text>
          <text fg={colors.dim}>working · {props.elapsedS}s</text>
          <text fg={colors.faint}>·</text>
        </>
      ) : null}
      <text fg={colors.text}>{props.model}</text>
      <text fg={colors.faint}>·</text>
      <text fg={colors.dim}>{props.path}</text>
      {props.branch ? <text fg={colors.dim}>⎇ {props.branch}</text> : null}
      <text fg={colors.faint}>·</text>
      <text fg={colors.dim}>
        step {props.step} · ${props.cost.toFixed(4)}
      </text>
      {props.status === "done" || props.status === "error" ? (
        <text fg={statusColor}>● {props.status}</text>
      ) : null}
    </box>
  );
}
