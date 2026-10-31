import { memo, useEffect, useState } from "react";

import { colors } from "../theme";

const FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];
const BAR_CELLS = 10;
const TICK_MS = 120;

/**
 * Animated load state. It owns its own tick: the 8 frames/s re-render only these three text
 * nodes, never the App (before, every frame re-rendered the whole transcript tree).
 */
function WorkingIndicator(props: { startedAt: number; label?: string }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => (t + 1) % 1000), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  const head = tick % BAR_CELLS;
  const bar = Array.from({ length: BAR_CELLS }, (_, i) => (i === head ? "▓" : "░")).join("");
  const elapsedS = props.startedAt ? Math.floor((Date.now() - props.startedAt) / 1000) : 0;
  return (
    <>
      <text fg={colors.accent}>{FRAMES[tick % FRAMES.length]}</text>
      <text fg={colors.faint}>{bar}</text>
      <text fg={colors.dim}>{props.label ?? "working"} · {elapsedS}s</text>
      <text fg={colors.faint}>·</text>
    </>
  );
}

/**
 * The single info line below the prompt: animated load state while the agent
 * works, plus model · path (git branch) · status.
 */
export const StatusLine = memo(function StatusLine(props: {
  model: string;
  path: string;
  branch: string | null;
  status: string;
  /** When the current turn started (ms epoch; 0 = unknown). */
  startedAt: number;
  /** A context compaction is running (the indicator reads "compacting"). */
  compacting?: boolean;
  /** The optional verifier phase is reviewing the finished turn's diff. */
  verifying?: boolean;
  /** The saved workspace the path belongs to (manual chat mode). */
  workspace?: string;
  /** What the transcript shows in dispatcher mode ("main chat", "task t3 · …"). */
  view?: string;
  /** The work queue strip ("3 running · 2 queued", or the connection state). */
  queue?: string;
}) {
  const statusColor =
    props.status === "error" ? colors.err : props.status === "done" ? colors.ok : props.status === "interrupted" ? colors.warn : colors.dim;
  return (
    <box flexDirection="row" gap={2} paddingX={1} height={1}>
      {props.status === "running" || props.compacting ? (
        <WorkingIndicator key={props.startedAt} startedAt={props.startedAt} label={props.compacting ? "compacting" : undefined} />
      ) : null}
      {props.verifying ? <text fg={colors.faint}>jev verifying…</text> : null}
      {props.view ? <text fg={colors.accent}>{props.view}</text> : null}
      {props.queue ? <text fg={colors.warn}>{props.queue}</text> : null}
      <text fg={colors.text}>{props.model}</text>
      <text fg={colors.faint}>·</text>
      {props.workspace ? <text fg={colors.accent}>◆ {props.workspace}</text> : null}
      <text fg={colors.dim}>{props.path}</text>
      {props.branch ? <text fg={colors.dim}>⎇ {props.branch}</text> : null}
      {props.status === "done" || props.status === "error" || props.status === "interrupted" ? (
        <text fg={statusColor}>● {props.status}</text>
      ) : null}
    </box>
  );
});
