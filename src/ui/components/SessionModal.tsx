import { useMemo, type RefObject } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";

import { colors } from "../theme";
import type { SessionRecord } from "../../sessions";
import { parseSavedEvents, previewBlocks, type PreviewBlock } from "../preview";

function when(session: SessionRecord): string {
  return new Date(session.updated_at).toISOString().slice(0, 16).replace("T", " ");
}

/** Modal-ish central panel listing saved sessions (paged, searchable, cwd-scoped). */
export function SessionModal(props: {
  sessions: SessionRecord[];
  query: string;
  page: number;
  pages: number;
  selectedIndex: number;
  onPick: (session: SessionRecord) => void;
  /** The session shown read-only in the panel instead of the list (null = the list). */
  previewing?: SessionRecord | null;
  onPreview?: (session: SessionRecord) => void;
  /** Rows available to the modal (the preview scrolls inside what is left). */
  areaHeight?: number;
  previewScrollRef?: RefObject<ScrollBoxRenderable | null>;
}) {
  if (props.previewing) {
    return (
      <SessionPreview
        session={props.previewing}
        areaHeight={props.areaHeight ?? 24}
        scrollRef={props.previewScrollRef}
        onOpen={() => props.onPick(props.previewing as SessionRecord)}
      />
    );
  }
  return (
    <box borderStyle="rounded" borderColor={colors.border} backgroundColor={colors.panel} width="80%" marginLeft="auto" marginRight="auto" paddingX={1} gap={0}>
      <text fg={colors.dim}>resume · sessions in this folder · Esc close</text>
      <box flexDirection="row" gap={1}>
        <text fg={colors.faint}>search</text>
        <text fg={colors.text}>{props.query}▏</text>
      </box>
      {props.sessions.length === 0 ? <text fg={colors.faint}>no sessions match</text> : null}
      {props.sessions.map((session, i) => {
        const selected = i === props.selectedIndex;
        return (
          <box key={session.id} flexDirection="row" gap={2} onMouseDown={() => props.onPick(session)}>
            <text fg={colors.accent}>{selected ? "▸" : " "}</text>
            <text fg={selected ? colors.text : colors.dim}>{session.title}</text>
            <text fg={colors.faint}>
              {when(session)} · {session.model || "default"} · step {session.api_calls}
            </text>
            {selected && props.onPreview ? (
              <text
                fg={colors.accent}
                onMouseDown={(event: { stopPropagation?: () => void }) => {
                  event?.stopPropagation?.(); // preview, don't open
                  props.onPreview?.(session);
                }}
              >
                [→ preview]
              </text>
            ) : null}
          </box>
        );
      })}
      <text fg={colors.faint}>
        page {props.pages === 0 ? 0 : props.page + 1}/{props.pages} · ↑/↓ move · → preview · Enter open · PgUp/PgDn page
      </text>
    </box>
  );
}

function PreviewLine(props: { block: PreviewBlock }) {
  const block = props.block;
  switch (block.kind) {
    case "task":
      return (
        <box borderStyle="rounded" borderColor={colors.border} paddingX={1} gap={0}>
          <text fg={colors.dim}>task</text>
          <text fg={colors.text}>{block.text}</text>
        </box>
      );
    case "assistant":
      return (
        <box gap={0}>
          <text fg={colors.faint}>assistant</text>
          <text fg={colors.text}>{block.text}</text>
        </box>
      );
    case "thinking":
      return <text fg={colors.faint}>{block.text}</text>;
    case "tool":
      return (
        <box gap={0}>
          <box flexDirection="row" gap={1}>
            <text fg={colors.dim}>{block.name}</text>
            <text fg={block.ok === null ? colors.dim : block.ok ? colors.ok : colors.err}>{block.badge}</text>
          </box>
          {block.command ? <text fg={colors.text}>{block.command}</text> : null}
          {block.output ? <text fg={colors.dim}>{block.output}</text> : null}
        </box>
      );
    case "notice":
      return <text fg={colors.faint}>· {block.text}</text>;
    case "exit":
      return (
        <box gap={0}>
          <box flexDirection="row" gap={1}>
            <text fg={colors.dim}>exit</text>
            <text fg={block.ok ? colors.ok : colors.err}>{block.status}</text>
          </box>
          {block.text ? <text fg={colors.text}>{block.text}</text> : null}
        </box>
      );
    case "error":
      return (
        <box gap={0}>
          <text fg={colors.err}>error</text>
          <text fg={colors.dim}>{block.text}</text>
        </box>
      );
    case "more":
      return <text fg={colors.faint}>{block.text}</text>;
  }
}

/** Read-only transcript of one saved session, shown in the /resume panel itself. */
function SessionPreview(props: {
  session: SessionRecord;
  areaHeight: number;
  scrollRef?: RefObject<ScrollBoxRenderable | null>;
  onOpen: () => void;
}) {
  const { session } = props;
  const blocks = useMemo(() => previewBlocks(parseSavedEvents(session.events_json)), [session.id, session.events_json]);
  // border (2) + title + meta + footer = 5 rows around the scrolling transcript
  const bodyHeight = Math.max(3, props.areaHeight - 6);
  return (
    <box borderStyle="rounded" borderColor={colors.border} backgroundColor={colors.panel} width="80%" marginLeft="auto" marginRight="auto" paddingX={1} gap={0}>
      <box flexDirection="row" gap={1}>
        <text fg={colors.dim}>preview · read-only ·</text>
        <text fg={colors.text}>{session.title}</text>
      </box>
      <text fg={colors.faint}>
        {when(session)} · {session.model || "default"} · step {session.api_calls}
        {session.cost ? ` · $${session.cost.toFixed(4)}` : ""}
      </text>
      <scrollbox ref={props.scrollRef} height={bodyHeight} width="100%" verticalScrollbarOptions={{ visible: false }} contentOptions={{ gap: 1 }}>
        {blocks.length === 0 ? <text fg={colors.faint}>this session has no transcript yet</text> : null}
        {blocks.map((block, i) => (
          <PreviewLine key={i} block={block} />
        ))}
      </scrollbox>
      <box flexDirection="row" gap={1}>
        <text fg={colors.faint}>↑↓ PgUp/PgDn g/G scroll · ←/Esc back ·</text>
        <text fg={colors.accent} onMouseDown={props.onOpen}>
          Enter open
        </text>
      </box>
    </box>
  );
}
