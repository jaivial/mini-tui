import { memo } from "react";

import { markdownSyntaxStyle, colors } from "../theme";
import { clipText } from "./StepCard";

/**
 * One assistant message: label + markdown body. Memoized (the transcript re-renders on
 * every tick) and clipped so the markdown text buffer stays bounded.
 */
export const AssistantCard = memo(function AssistantCard(props: { text: string }) {
  return (
    <box paddingX={1} gap={0}>
      <text fg={colors.faint}>assistant</text>
      <markdown content={clipText(props.text, 80, 16).text} syntaxStyle={markdownSyntaxStyle} streaming />
    </box>
  );
});
