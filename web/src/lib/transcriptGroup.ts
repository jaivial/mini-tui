/**
 * Which transcript rows belong to the same visual run.
 *
 * The chat-app rule is that consecutive messages of the SAME AUTHOR tuck
 * together under one header, and the run breaks on anything else. For the
 * assistant and the local composer the author IS the row kind, so kind alone
 * was enough. A mirrored WhatsApp bubble is different: in a group thread the
 * kind is always "channel" while the author changes with every person who
 * talks, so grouping by kind attributed a message to whoever spoke before it
 * and dropped the sender line entirely.
 *
 * Lives here, not inline in the component, because this is the rule the
 * transcript's shape is made of: it has to be testable on its own, and the
 * component only has to call it.
 */

export type GroupableKind = "assistant" | "task" | "channel";

export interface GroupableRow {
  kind: GroupableKind;
  /** The WhatsApp sender jid. Only read for `channel` rows. */
  sender?: string;
}

/** True when `row` continues the run `prev` started. */
export function sameRun(prev: GroupableRow | undefined, row: GroupableRow): boolean {
  if (prev === undefined || prev.kind !== row.kind) return false;
  // One voice each: the model's replies and the local composer's prompts.
  if (row.kind === "assistant" || row.kind === "task") return true;
  // A group thread is many voices behind one kind. Same jid, same run.
  return row.sender !== undefined && prev.sender === row.sender;
}
