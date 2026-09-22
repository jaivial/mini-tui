import { memo } from "react";

import { colors, markdownSyntaxStyle } from "../theme";
import { needsMarkdown } from "../markdown";
import { clipText } from "./StepCard";

/** Error/exit banner with the final submission — markdown only when it has structure. */
export const ExitBanner = memo(function ExitBanner(props: { exitStatus: string; submission: string }) {
  const ok =
    props.exitStatus === "Submitted" || props.exitStatus === "Complete" || props.exitStatus === "Finished";
  const body = props.submission ? clipText(props.submission, 40).text : "";
  return (
    <box borderStyle="rounded" borderColor={colors.border} paddingX={1} gap={0}>
      <box flexDirection="row" gap={1}>
        <text fg={colors.dim}>exit</text>
        <text fg={ok ? colors.ok : colors.err}>{props.exitStatus || "finished"}</text>
      </box>
      {!body ? null : needsMarkdown(body) ? (
        <markdown content={body} syntaxStyle={markdownSyntaxStyle} streaming />
      ) : (
        <text fg={colors.text}>{body}</text>
      )}
    </box>
  );
});
