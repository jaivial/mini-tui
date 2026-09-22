import { memo } from "react";

import { markdownSyntaxStyle, colors } from "../theme";
import { needsMarkdown } from "../markdown";
import { clipText } from "./StepCard";

/**
 * One assistant message: label + body. Markdown only when the text has structure (the
 * markdown renderable is 3.6x more expensive in memory than plain text — see
 * docs/PLAN-ram-reduction.md). Memoized: the transcript re-renders on every spinner tick.
 */
export const AssistantCard = memo(function AssistantCard(props: { text: string }) {
  const body = clipText(props.text, 80, 16).text;
  return (
    <box paddingX={1} gap={0}>
      <text fg={colors.faint}>assistant</text>
      {needsMarkdown(body) ? (
        <markdown content={body} syntaxStyle={markdownSyntaxStyle} streaming />
      ) : (
        <text fg={colors.text}>{body}</text>
      )}
    </box>
  );
});
