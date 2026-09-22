import { colors } from "../theme";

/** Transient feedback only (no static key legend). */
export function StatusBar(props: { hint?: string }) {
  if (!props.hint) return null;
  return (
    <box paddingX={1}>
      <text fg={colors.faint}>{props.hint}</text>
    </box>
  );
}
