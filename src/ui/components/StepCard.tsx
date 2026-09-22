import { bashSyntaxStyle, colors } from "../theme";
import type { OutputMode } from "../../settings";

const COLLAPSED_HEAD = 8;
const COLLAPSED_TAIL = 12;
const TRIM_HEAD = 2;
const EXPANDED_CAP = 5000;

/** Clip outputs according to the display mode (per-block expand overrides it). */
export function clipOutput(output: string, mode: OutputMode, forceExpand = false): { text: string; hidden: number } {
  const lines = output.replace(/\n+$/, "").split("\n");
  const expanded = forceExpand || mode === "expanded";
  const head = expanded ? EXPANDED_CAP : mode === "trim" ? TRIM_HEAD : COLLAPSED_HEAD;
  const tail = expanded ? 0 : mode === "trim" ? 0 : COLLAPSED_TAIL;
  if (lines.length <= head + tail + 1) return { text: lines.join("\n"), hidden: 0 };
  const hidden = lines.length - head - tail;
  const text = [...lines.slice(0, head), `... ${hidden} lines hidden ...`, ...(tail ? lines.slice(-tail) : [])].join(
    "\n",
  );
  return { text, hidden };
}

/**
 * One borderless block per bash step: command + its output. shadcn-quiet: labels in
 * muted zinc, semantic colors only on the return-code badge, a small focus marker.
 */
export function StepCard(props: {
  index?: number;
  name?: string;
  command?: string;
  returncode: number | null;
  output: string;
  exceptionInfo: string;
  mode: OutputMode;
  expanded: boolean;
  focused: boolean;
  onToggle: () => void;
}) {
  const badge = props.returncode === null ? "rc=?" : `rc=${props.returncode}`;
  const badgeColor = props.returncode === 0 ? colors.ok : props.returncode === null ? colors.dim : colors.err;
  const { text, hidden } = clipOutput(props.output, props.mode, props.expanded);
  const totalLines = props.output.replace(/\n+$/, "").split("\n").length;
  const label = props.index !== undefined ? `${props.name ?? "bash"} #${props.index}` : "output";
  return (
    <box paddingX={1} gap={0}>
      <box flexDirection="row" gap={1}>
        <text fg={colors.accent}>{props.focused ? "▍" : " "}</text>
        <text fg={colors.dim}>{label}</text>
        <text fg={badgeColor}>{badge}</text>
        {props.exceptionInfo ? <text fg={colors.err}>· {props.exceptionInfo}</text> : null}
      </box>
      {props.command !== undefined ? <code content={props.command} filetype="bash" syntaxStyle={bashSyntaxStyle} /> : null}
      {text ? <text fg={colors.dim}>{text}</text> : null}
      {totalLines > 2 ? (
        <text fg={colors.faint}>
          {hidden > 0 ? `${hidden} lines hidden · ` : ""}[e] {props.expanded || props.mode === "expanded" ? "collapse" : "expand"}
        </text>
      ) : null}
    </box>
  );
}
