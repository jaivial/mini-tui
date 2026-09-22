import { memo } from "react";

import { colors } from "../theme";

/** A one-line notice — it bounds itself to 220 chars, so no separate clipping is needed. */
export const NoticeLine = memo(function NoticeLine(props: { text: string; interruptType?: string }) {
  const oneLine = props.text.replace(/\s+/g, " ").trim().slice(0, 220);
  const label = props.interruptType ? `${props.interruptType.toLowerCase()} · ` : "";
  return (
    <text fg={colors.dim}>
      → {label}
      {oneLine}
    </text>
  );
});
