import { memo } from "react";

import { markdownSyntaxStyle, colors } from "../theme";
import { clipText } from "./StepCard";

/** The user's task in a rounded card — clipped like every text block (buffers are rows × cols). */
export const TaskCard = memo(function TaskCard(props: { text: string }) {
  return (
    <box borderStyle="rounded" borderColor={colors.border} paddingX={1} gap={0}>
      <text fg={colors.dim}>task</text>
      <markdown content={clipText(props.text, 24, 6).text} syntaxStyle={markdownSyntaxStyle} streaming />
    </box>
  );
});
