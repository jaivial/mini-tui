/**
 * Re-apply the tool-output bounds to sessions stored before the bounding fix
 * (see bbe51cf). Those rows kept whole tool outputs, so a single runaway command
 * could leave one session hundreds of MB and the database unreadably slow to
 * load. Nothing is deleted: oversized output is replaced by the same head+tail
 * the UI already shows, and the original database is left for a manual restore.
 */
import { DatabaseSync } from "node:sqlite";
import { boundEvent } from "../src/traj/slim";
import { DEFAULT_DB_PATH } from "../src/sessions";
import type { RunEvent } from "../src/traj/schema";

// The app's own default, so this script can never drift from where it writes.
const dbPath = DEFAULT_DB_PATH;
const dryRun = !process.argv.includes("--apply");

const db = new DatabaseSync(dbPath, { readOnly: dryRun });
const rows = db
  .prepare("SELECT id, events_json, messages_json FROM sessions")
  .all() as { id: string; events_json: string | null; messages_json: string | null }[];

let touched = 0;
const savings: { id: string; before: number; after: number }[] = [];

for (const row of rows) {
  let events: RunEvent[] | null = null;
  if (row.events_json) {
    try {
      events = JSON.parse(row.events_json) as RunEvent[];
    } catch {
      console.log(`  skip ${row.id}: events_json is not valid JSON`);
      continue;
    }
  }
  const before = (row.events_json?.length ?? 0) + (row.messages_json?.length ?? 0);
  const next = events?.map(boundEvent);
  const bounded = JSON.stringify(next);
  const after = bounded.length + (row.messages_json?.length ?? 0);
  if (after >= before) continue;
  touched++;
  savings.push({ id: row.id, before, after });
  if (!dryRun && next) {
    db.prepare("UPDATE sessions SET events_json = ? WHERE id = ?").run(bounded, row.id);
  }
}

db.close();
savings.sort((a, b) => b.before - b.after);
console.log(`${dryRun ? "DRY RUN" : "APPLIED"}: ${touched} session(s) would shrink\n`);
for (const s of savings.slice(0, 10)) {
  console.log(`  ${s.id}  ${(s.before / 1e6).toFixed(1)} MB -> ${(s.after / 1e6).toFixed(1)} MB`);
}
const total = savings.reduce((n, s) => n + (s.before - s.after), 0);
console.log(`\ntotal reclaimable: ${(total / 1e6).toFixed(1)} MB`);
if (dryRun) console.log("\nRe-run with --apply to write the changes.");
