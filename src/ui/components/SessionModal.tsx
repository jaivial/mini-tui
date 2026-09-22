import { colors } from "../theme";
import type { SessionRecord } from "../../sessions";

/** Modal-ish central panel listing saved sessions (paged, searchable, cwd-scoped). */
export function SessionModal(props: {
  sessions: SessionRecord[];
  query: string;
  page: number;
  pages: number;
  selectedIndex: number;
  onPick: (session: SessionRecord) => void;
}) {
  return (
    <box borderStyle="rounded" borderColor={colors.border} width="80%" marginLeft="auto" marginRight="auto" paddingX={1} gap={0}>
      <text fg={colors.dim}>resume · sessions in this folder · Esc close</text>
      <box flexDirection="row" gap={1}>
        <text fg={colors.faint}>search</text>
        <text fg={colors.text}>{props.query}▏</text>
      </box>
      {props.sessions.length === 0 ? <text fg={colors.faint}>no sessions match</text> : null}
      {props.sessions.map((session, i) => {
        const selected = i === props.selectedIndex;
        const when = new Date(session.updated_at).toISOString().slice(0, 16).replace("T", " ");
        return (
          <box
            key={session.id}
            flexDirection="row"
            gap={2}
            onMouseDown={() => props.onPick(session)}
          >
            <text fg={colors.accent}>{selected ? "▸" : " "}</text>
            <text fg={selected ? colors.text : colors.dim}>{session.title}</text>
            <text fg={colors.faint}>
              {when} · {session.model || "default"} · step {session.api_calls}
            </text>
          </box>
        );
      })}
      <text fg={colors.faint}>
        page {props.pages === 0 ? 0 : props.page + 1}/{props.pages} · ↑/↓ move · Enter open · PgUp/PgDn page
      </text>
    </box>
  );
}
