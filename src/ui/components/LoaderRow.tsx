import { colors } from "../theme";

const FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];
const BAR_CELLS = 10;

/** Shimmering load state shown right below the prompt while the agent works. */
export function LoaderRow(props: { tick: number; elapsedS: number }) {
  const spinner = FRAMES[props.tick % FRAMES.length];
  const head = props.tick % BAR_CELLS;
  const bar = Array.from({ length: BAR_CELLS }, (_, i) => (i === head ? "▓" : "░")).join("");
  return (
    <box flexDirection="row" gap={2} paddingX={1}>
      <text fg={colors.accent}>{spinner}</text>
      <text fg={colors.faint}>{bar}</text>
      <text fg={colors.dim}>working · {props.elapsedS}s</text>
    </box>
  );
}
