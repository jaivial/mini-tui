import { colors } from "../theme";

export function NoticeLine(props: { text: string; interruptType?: string }) {
  const oneLine = props.text.replace(/\s+/g, " ").trim().slice(0, 220);
  const label = props.interruptType ? `${props.interruptType.toLowerCase()} · ` : "";
  return (
    <text fg={colors.dim}>
      → {label}
      {oneLine}
    </text>
  );
}
