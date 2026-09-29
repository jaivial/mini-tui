/** Pure helpers for the Resume list: grouping by recency, a short folder label, and the search debounce rule. */
import type { HistoryItem } from "./types";

export type Bucket = "Today" | "Yesterday" | "This week" | "Earlier";
const DAY = 86_400_000;

/** Calendar days, in the viewer's timezone: 00:30 is "Today" even if it is 26 hours after yesterday's session. */
export function bucketOf(updatedAt: number, now = Date.now()): Bucket {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const today = start.getTime();
  if (updatedAt >= today) return "Today";
  if (updatedAt >= today - DAY) return "Yesterday";
  if (updatedAt >= today - 6 * DAY) return "This week";
  return "Earlier";
}

/** Groups in reading order, each keeping the incoming (newest-first) order; empty groups are dropped. */
export function groupByRecency(items: HistoryItem[], now = Date.now()): { bucket: Bucket; items: HistoryItem[] }[] {
  const order: Bucket[] = ["Today", "Yesterday", "This week", "Earlier"];
  const map = new Map<Bucket, HistoryItem[]>(order.map((b) => [b, []]));
  for (const item of items) map.get(bucketOf(item.updatedAt, now))!.push(item);
  return order.filter((b) => map.get(b)!.length).map((bucket) => ({ bucket, items: map.get(bucket)! }));
}

/** `/home/me/work/api` -> `work/api`: the last two segments are what tells two projects apart. */
export function shortFolder(cwd: string): string {
  const parts = cwd.replace(/\/+$/, "").split("/").filter(Boolean);
  if (!parts.length) return cwd || "/";
  return parts.slice(-2).join("/");
}

/** A model id without its provider, for a row that has little room. */
export function shortModel(model: string): string {
  const i = model.indexOf("/");
  return model ? (i > 0 ? model.slice(i + 1) : model) : "default model";
}

/** Why a row cannot be opened for continuing, in words a person can act on; `""` when it can. */
export function unresumableReason(item: HistoryItem): string {
  return item.resumable ? "" : "Nothing was saved to continue from. You can read it, not continue it.";
}
