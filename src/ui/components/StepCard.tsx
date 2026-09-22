import { bashSyntaxStyle, colors } from "../theme";
import type { OutputMode } from "../../settings";

const COLLAPSED_HEAD = 8;
const COLLAPSED_TAIL = 12;
const TRIM_HEAD = 2;
// Every rendered line costs a full terminal-width row of native text buffer, so the
// expanded cap must stay bounded: 5000 lines × a wide terminal ≈ tens of MB per card.
const EXPANDED_CAP = 500;
/** Hard clamp for pathological single-line outputs (wrap makes one line many rows). */
const CHAR_CAP = 40_000;

/**
 * Keep at most `head + tail` lines (and `maxChars` characters) of a text block, marking
 * what was dropped. Shared by tool outputs and the free-text blocks (assistant markdown,
 * task, notices) so every text renderable stays memory-bounded.
 */
export function clipText(text: string, head: number, tail = 0, maxChars = CHAR_CAP): { text: string; hidden: number } {
  const lines = text.replace(/\n+$/, "").split("\n");
  const hidden = lines.length > head + tail + 1 ? lines.length - head - tail : 0;
  let clipped = hidden
    ? [...lines.slice(0, head), `... ${hidden} lines hidden ...`, ...(tail ? lines.slice(-tail) : [])].join("\n")
    : lines.join("\n");
  if (clipped.length > maxChars) clipped = `${clipped.slice(0, maxChars)}\n... output truncated ...`;
  return { text: clipped, hidden };
}

/** Clip outputs according to the display mode (full reveal when flipped open). */
export function clipOutput(output: string, mode: OutputMode, forceExpand = false): { text: string; hidden: number } {
  const expanded = forceExpand || mode === "expanded";
  const head = expanded ? EXPANDED_CAP : mode === "trim" ? TRIM_HEAD : COLLAPSED_HEAD;
  const tail = expanded ? 0 : mode === "trim" ? 0 : COLLAPSED_TAIL;
  return clipText(output, head, tail);
}

/**
 * One borderless block per bash step. `flipped` inverts the block against its
 * display mode, so `e`/click always toggles: count line <-> full card, whatever
 * the mode is.
 */
export function StepCard(props: {
  index?: number;
  name?: string;
  command?: string;
  returncode: number | null;
  output: string;
  exceptionInfo: string;
  mode: OutputMode;
  flipped: boolean;
  focused: boolean;
  onToggle: () => void;
}) {
  const badge = props.returncode === null ? "rc=?" : `rc=${props.returncode}`;
  const badgeColor = props.returncode === 0 ? colors.ok : props.returncode === null ? colors.dim : colors.err;
  const marker = <text fg={colors.accent}>{props.focused ? "▍" : " "}</text>;
  const count = props.command !== undefined ? "1 tool call" : "output";

  const collapsedView = props.mode === "collapsed" !== props.flipped;
  if (collapsedView) {
    return (
      <box paddingX={1} gap={1} flexDirection="row" onMouseDown={props.onToggle}>
        {marker}
        <text fg={colors.dim}>{count}</text>
        <text fg={colors.faint}>[e] expand</text>
      </box>
    );
  }

  // full card: reveal everything when flipped open from the count line, otherwise
  // follow the mode's clipping
  const reveal = props.mode === "collapsed" && props.flipped;
  const { text, hidden } = clipOutput(props.output, props.mode, reveal);
  const totalLines = props.output.replace(/\n+$/, "").split("\n").length;
  const label = props.index !== undefined ? `${props.name ?? "bash"} #${props.index}` : "output";
  return (
    <box paddingX={1} gap={0}>
      <box flexDirection="row" gap={1} onMouseDown={props.onToggle}>
        {marker}
        <text fg={colors.dim}>{label}</text>
        <text fg={badgeColor}>{badge}</text>
        {props.exceptionInfo ? <text fg={colors.err}>· {props.exceptionInfo}</text> : null}
      </box>
      {props.command !== undefined ? <code content={props.command} filetype="bash" syntaxStyle={bashSyntaxStyle} /> : null}
      {text ? <text fg={colors.dim}>{text}</text> : null}
      {totalLines > 2 ? (
        <text fg={colors.faint}>
          {hidden > 0 ? `${hidden} lines hidden · ` : ""}[e] collapse
        </text>
      ) : null}
    </box>
  );
}
