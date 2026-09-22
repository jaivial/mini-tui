import { memo } from "react";

import { colors } from "../theme";
import { clipText } from "./StepCard";

/**
 * The user's task in a rounded card — the prompt verbatim, so it renders as plain text
 * (3.6x cheaper than a markdown block; see docs/PLAN-ram-reduction.md), clipped like every
 * text block (buffers are rows × cols).
 */
export const TaskCard = memo(function TaskCard(props: { text: string }) {
  return (
    <box borderStyle="rounded" borderColor={colors.border} paddingX={1} gap={0}>
      <text fg={colors.dim}>task</text>
      <text fg={colors.text}>{clipText(props.text, 24, 6).text}</text>
    </box>
  );
});
