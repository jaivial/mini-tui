import { memo } from "react";

import { colors } from "../theme";

/** A crashed run's `mini.log` tail — a transcript item, so it scrolls up with the thread. */
export const ErrorBanner = memo(function ErrorBanner(props: { text: string }) {
  return (
    <box paddingX={1} gap={0}>
      <text fg={colors.err}>mini.log tail</text>
      <text fg={colors.dim}>{props.text}</text>
    </box>
  );
});
