import { memo } from "react";

import { colors } from "../theme";
import type { OutputMode } from "../../settings";
import { clipText } from "./StepCard";

/**
 * One model call's chain-of-thought, in the same three states as tool outputs: `expanded`
 * shows it in full, `trim` at most 2 lines, `collapsed` just the status line. While the
 * model is still thinking the card reads "Thinking..."; afterwards "Thought for {n} seconds".
 * Dim and label-free: meta about the reply that follows, not the reply itself.
 */
export const ThinkingCard = memo(function ThinkingCard(props: { text: string; seconds: number; mode: OutputMode; live?: boolean }) {
  if (props.live) return <text fg={colors.faint}>Thinking...</text>;
  const seconds = Math.max(1, Math.round(props.seconds));
  const summary = `Thought for ${seconds} second${seconds === 1 ? "" : "s"}`;
  if (props.mode === "collapsed" || !props.text.trim()) return <text fg={colors.faint}>{summary}</text>;
  // trim shows at most 2 lines of the thinking (no marker line — the cap is the point);
  // expanded is "full" up to the house clip cap, like every expanded block.
  const body = props.mode === "trim" ? props.text.split("\n").slice(0, 2).join("\n") : clipText(props.text, 500).text;
  return (
    <box paddingX={1} gap={0}>
      <text fg={colors.dim}>{body}</text>
    </box>
  );
});
