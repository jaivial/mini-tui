import { colors } from "../theme";
import type { QueueTaskStatus, QueueTaskView } from "../../queueClient";

export const TASK_FILTERS = ["all", "running", "queued", "done", "error", "cancelled"] as const;
export type TaskFilter = (typeof TASK_FILTERS)[number];

const RANK: Record<QueueTaskStatus, number> = { running: 0, queued: 1, error: 2, done: 2, cancelled: 2 };

/** Tasks in the order the panel lists them: working first, then waiting, then the latest finished. */
export function visibleTasks(tasks: QueueTaskView[], filter: TaskFilter): QueueTaskView[] {
  return tasks
    .filter((task) => filter === "all" || task.status === filter)
    .sort((a, b) => RANK[a.status] - RANK[b.status] || (RANK[a.status] < 2 ? (a.seq ?? a.createdAt) - (b.seq ?? b.createdAt) : b.updatedAt - a.updatedAt));
}

export function ago(at: number, now = Date.now()): string {
  if (!at) return "";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

const GLYPH: Record<QueueTaskStatus, string> = { running: "●", queued: "○", done: "✓", error: "✗", cancelled: "–" };

function statusColor(status: QueueTaskStatus): string {
  if (status === "running") return colors.accent;
  if (status === "done") return colors.ok;
  if (status === "error") return colors.err;
  if (status === "cancelled") return colors.faint;
  return colors.dim;
}

function cut(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** `/tasks` — the work queue: filter by status, open a worker's session, cancel a task. */
export function TasksModal(props: {
  tasks: QueueTaskView[];
  filter: TaskFilter;
  selectedIndex: number;
  /** A task waiting for the cancel confirmation (its id), if any. */
  confirmCancel?: string | null;
  note?: string;
  /** Connection line ("connecting…", an error) when the queue is not reachable. */
  link?: string;
  areaHeight: number;
  now?: number;
  onPick?: (task: QueueTaskView) => void;
}) {
  const now = props.now ?? Date.now();
  const rows = visibleTasks(props.tasks, props.filter);
  const selected = Math.min(props.selectedIndex, Math.max(rows.length - 1, 0));
  // border (2) + header + filters + footer (+ note) around the list
  const budget = Math.max(3, props.areaHeight - 6 - (props.note || props.confirmCancel ? 1 : 0));
  const start = Math.max(0, Math.min(selected - Math.floor(budget / 2), Math.max(0, rows.length - budget)));
  const shown = rows.slice(start, start + budget);
  return (
    <box borderStyle="rounded" borderColor={colors.border} backgroundColor={colors.panel} width="90%" paddingX={1} gap={0}>
      <text fg={colors.dim}>tasks · the work queue{props.link ? ` · ${props.link}` : ""} · Esc close</text>
      <box flexDirection="row" gap={1}>
        {TASK_FILTERS.map((filter) => {
          const count = filter === "all" ? props.tasks.length : props.tasks.filter((t) => t.status === filter).length;
          return (
            <text key={filter} fg={filter === props.filter ? colors.text : colors.faint}>
              {filter === props.filter ? `[${filter} ${count}]` : `${filter} ${count}`}
            </text>
          );
        })}
      </box>
      {rows.length === 0 ? <text fg={colors.faint}>{props.tasks.length ? "no task with this status" : "no tasks yet: ask the main chat for something"}</text> : null}
      {shown.map((task, k) => {
        const i = start + k;
        const isSelected = i === selected;
        const when = task.status === "running" ? task.startedAt : task.status === "queued" ? task.createdAt : task.finishedAt || task.updatedAt;
        return (
          <box key={task.id} flexDirection="row" gap={1} onMouseDown={() => props.onPick?.(task)}>
            <text fg={colors.accent}>{isSelected ? "▸" : " "}</text>
            <text fg={statusColor(task.status)}>{GLYPH[task.status] ?? "?"}</text>
            <text fg={colors.faint}>{task.id.padEnd(4)}</text>
            <text fg={isSelected ? colors.text : colors.dim}>{cut(task.title || task.description || "(untitled)", 60)}</text>
            {task.workspace ? <text fg={colors.faint}>◆ {cut(task.workspace, 24)}</text> : null}
            <text fg={colors.faint}>
              {task.status}
              {when ? ` ${ago(when, now)}` : ""}
            </text>
          </box>
        );
      })}
      {props.confirmCancel ? (
        <text fg={colors.warn}>cancel {props.confirmCancel}? y / Enter = yes · n / Esc = no</text>
      ) : props.note ? (
        <text fg={colors.dim}>{props.note}</text>
      ) : null}
      <text fg={colors.faint}>
        {rows.length ? `${selected + 1}/${rows.length} · ` : ""}↑/↓ move · Tab/f filter · Enter open the session · c cancel
      </text>
    </box>
  );
}
