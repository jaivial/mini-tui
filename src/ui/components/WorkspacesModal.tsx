import { colors } from "../theme";
import type { SavedWorkspace } from "../../workspaces";

export interface WorkspaceRow {
  workspace: SavedWorkspace;
  /** Display path (`~/…`). */
  path: string;
  sessions: number;
  /** Lives on a remote host: the terminal UI only runs local sessions. */
  remote: boolean;
}

export type WorkspaceStep =
  | { kind: "list"; index: number; note?: string }
  | { kind: "add"; field: "path" | "name"; path: string; name: string; error?: string; hint?: string }
  | { kind: "rename"; id: string; value: string; error?: string }
  | { kind: "remove"; id: string };

/** `/workspaces` (manual chat mode) — saved folders to create sessions in. */
export function WorkspacesModal(props: {
  rows: WorkspaceRow[];
  step: WorkspaceStep;
  /** The folder sessions start in right now (display path). */
  current: string;
  currentId?: string;
  areaHeight: number;
  onPick?: (row: WorkspaceRow) => void;
}) {
  const { step } = props;
  if (step.kind === "add") {
    return (
      <box borderStyle="rounded" borderColor={colors.border} backgroundColor={colors.panel} width="80%" paddingX={1} gap={0}>
        <text fg={colors.dim}>new workspace · Enter next/save · Tab completes folders · Esc back</text>
        <box flexDirection="row" gap={1}>
          <text fg={step.field === "path" ? colors.accent : colors.faint}>{step.field === "path" ? "▸" : " "}</text>
          <text fg={colors.dim}>folder</text>
          <text fg={colors.text}>{step.path}{step.field === "path" ? "▏" : ""}</text>
        </box>
        <box flexDirection="row" gap={1}>
          <text fg={step.field === "name" ? colors.accent : colors.faint}>{step.field === "name" ? "▸" : " "}</text>
          <text fg={colors.dim}>name</text>
          <text fg={colors.text}>{step.name}{step.field === "name" ? "▏" : ""}</text>
          {step.field === "name" && !step.name ? <text fg={colors.faint}>(empty = the folder's name)</text> : null}
        </box>
        {step.hint ? <text fg={colors.faint}>{step.hint}</text> : null}
        {step.error ? <text fg={colors.err}>{step.error}</text> : null}
      </box>
    );
  }
  const selected = step.kind === "list" ? Math.min(step.index, Math.max(props.rows.length - 1, 0)) : -1;
  const target = step.kind === "rename" || step.kind === "remove" ? props.rows.find((r) => r.workspace.id === step.id) : undefined;
  const budget = Math.max(3, props.areaHeight - 8);
  const start = Math.max(0, Math.min(selected - Math.floor(budget / 2), Math.max(0, props.rows.length - budget)));
  return (
    <box borderStyle="rounded" borderColor={colors.border} backgroundColor={colors.panel} width="80%" paddingX={1} gap={0}>
      <text fg={colors.dim}>workspaces · new sessions start in the chosen folder · Esc close</text>
      <box flexDirection="row" gap={1}>
        <text fg={colors.faint}>now in</text>
        <text fg={colors.text}>{props.current}</text>
      </box>
      {props.rows.length === 0 ? <text fg={colors.faint}>no saved workspaces yet · n adds a folder · s saves the current one</text> : null}
      {props.rows.slice(start, start + budget).map((row, k) => {
        const i = start + k;
        const isSelected = i === selected || row === target;
        const active = row.workspace.id === props.currentId;
        return (
          <box key={row.workspace.id} flexDirection="row" gap={1} onMouseDown={() => props.onPick?.(row)}>
            <text fg={colors.accent}>{isSelected ? "▸" : " "}</text>
            <text fg={row.remote ? colors.faint : isSelected ? colors.text : colors.dim}>{row.workspace.name}</text>
            <text fg={colors.faint}>{row.path}</text>
            <text fg={colors.faint}>{row.remote ? "remote host · open it in the web app" : `${row.sessions} session${row.sessions === 1 ? "" : "s"}`}</text>
            {active ? <text fg={colors.ok}>● current</text> : null}
          </box>
        );
      })}
      {step.kind === "rename" ? (
        <box flexDirection="row" gap={1}>
          <text fg={colors.dim}>rename {target?.workspace.name ?? ""} →</text>
          <text fg={colors.text}>{step.value}▏</text>
          {step.error ? <text fg={colors.err}>{step.error}</text> : null}
        </box>
      ) : step.kind === "remove" ? (
        <text fg={colors.warn}>remove {target?.workspace.name ?? "this workspace"}? (its sessions stay) y / Enter = yes · n / Esc = no</text>
      ) : step.note ? (
        <text fg={colors.dim}>{step.note}</text>
      ) : null}
      <text fg={colors.faint}>↑/↓ move · Enter switch · n new · s save current folder · r rename · d remove</text>
    </box>
  );
}
