import { memo } from "react";

import { colors, markdownSyntaxStyle } from "../theme";
import { clipText } from "./StepCard";

/** Error/exit banner with the final submission — clipped so the markdown buffer stays bounded. */
export const ExitBanner = memo(function ExitBanner(props: { exitStatus: string; submission: string }) {
  const ok =
    props.exitStatus === "Submitted" || props.exitStatus === "Complete" || props.exitStatus === "Finished";
  return (
    <box borderStyle="rounded" borderColor={colors.border} paddingX={1} gap={0}>
      <box flexDirection="row" gap={1}>
        <text fg={colors.dim}>exit</text>
        <text fg={ok ? colors.ok : colors.err}>{props.exitStatus || "finished"}</text>
      </box>
      {props.submission ? <markdown content={clipText(props.submission, 40).text} syntaxStyle={markdownSyntaxStyle} streaming /> : null}
    </box>
  );
});
