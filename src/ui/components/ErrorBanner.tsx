import { memo } from "react";

import { diagnoseCliproxy } from "../../cliproxyDiagnosis";
import { colors } from "../theme";

/**
 * A crashed run's `mini.log` tail - a transcript item, so it scrolls up with the thread.
 *
 * A `cliproxy/` run fails through a local gateway, where four different things (the process,
 * the key, the upstream login, the advertised id) produce near-identical warnings. When the
 * tail is one of those, say which and what to do before the raw log: the log stays for the
 * details, the first line is the answer.
 */
export const ErrorBanner = memo(function ErrorBanner(props: { text: string }) {
  const diagnosis = diagnoseCliproxy(props.text);
  return (
    <box paddingX={1} gap={0}>
      <text fg={colors.err}>mini.log tail</text>
      {diagnosis.fix ? (
        <text fg={colors.warn}>
          cli-proxy ({diagnosis.stage}): {diagnosis.fix}
        </text>
      ) : null}
      <text fg={colors.dim}>{props.text}</text>
    </box>
  );
});
