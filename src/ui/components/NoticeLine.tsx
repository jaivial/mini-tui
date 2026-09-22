import { colors } from "../theme";

export function NoticeLine(props: { text: string; interruptType?: string }) {
  const oneLine = props.text.replace(/\s+/g, " ").trim().slice(0, 220);
  const label = props.interruptType ? `[${props.interruptType}]` : "[notice]";
  return (
    <text fg={colors.warn}>
      ⚠ {label} {oneLine}
    </text>
  );
}
