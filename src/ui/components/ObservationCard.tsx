import { colors } from "../theme";

const COLLAPSED_HEAD = 8;
const COLLAPSED_TAIL = 12;
const EXPANDED_HEAD = 200;
const EXPANDED_TAIL = 50;

/** Clip very long outputs: first/last lines plus a hidden-lines marker. */
export function clipOutput(output: string, expanded: boolean): { text: string; hidden: number } {
  const lines = output.replace(/\n+$/, "").split("\n");
  const head = expanded ? EXPANDED_HEAD : COLLAPSED_HEAD;
  const tail = expanded ? EXPANDED_TAIL : COLLAPSED_TAIL;
  if (lines.length <= head + tail + 1) return { text: lines.join("\n"), hidden: 0 };
  const hidden = lines.length - head - tail;
  const text = [...lines.slice(0, head), `... ${hidden} lines hidden ...`, ...lines.slice(-tail)].join("\n");
  return { text, hidden };
}

export function ObservationCard(props: {
  returncode: number | null;
  output: string;
  exceptionInfo: string;
  expanded: boolean;
  focused: boolean;
}) {
  const { returncode, exceptionInfo, expanded } = props;
  const badge = returncode === null ? "rc=?" : `rc=${returncode}`;
  const badgeColor = returncode === 0 ? colors.ok : returncode === null ? colors.dim : colors.err;
  const { text, hidden } = clipOutput(props.output, expanded);
  return (
    <box
      borderStyle="single"
      borderColor={props.focused ? colors.borderActive : colors.border}
      title="output"
      titleColor={colors.dim}
      titleAlignment="left"
      paddingX={1}
      paddingLeft={3}
    >
      <box flexDirection="row" gap={2}>
        <text fg={badgeColor}>{badge}</text>
        {exceptionInfo ? <text fg={colors.err}>✗ {exceptionInfo}</text> : null}
        {hidden > 0 || props.output.split("\n").length > 8 ? (
          <text fg={colors.dim}>
            {hidden > 0 ? `${hidden} lines hidden · ` : ""}[e] {expanded ? "collapse" : "expand"}
          </text>
        ) : null}
      </box>
      <text fg={colors.dim}>{text}</text>
    </box>
  );
}
