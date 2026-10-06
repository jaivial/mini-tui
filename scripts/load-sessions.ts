/**
 * Load probe for the web session manager (perf/sessions-async).
 *
 *   MINITUI_WEB_LOAD_N=200 bun scripts/load-sessions.ts
 *
 * Creates N idle sessions in the shared database, opens them all in one
 * SessionManager and times a burst of `syncExternal()` ticks (the work the
 * background timer does every second), plus the attach path (a live agent
 * announced by another UI) and the reload path (every row saved by another UI
 * since we opened it). Reports ms per tick and total blocking time.
 *
 * Baseline before the async/incremental change (N=500, 20 ticks):
 *   ticks total 42ms, mean 2.10ms, p50 2ms, max 3ms; every tick costs
 *   `N` `getLiveRun` queries + one bulk stamp query, and the stale tick
 *   reads and re-parses all 500 rows in one synchronous stretch.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const N = Number(process.env.MINITUI_WEB_LOAD_N ?? 200);
const TICKS = Number(process.env.MINITUI_WEB_LOAD_TICKS ?? 50);
const dir = mkdtempSync(join(tmpdir(), "minitui-load-"));
process.env.MINITUI_DB_PATH = join(dir, "sessions.db");
process.env.MINITUI_RESUME_DIR = join(dir, "resume");
process.env.MINITUI_CONFIG_DIR = dir;

const { openDb, createSession, saveTranscript } = await import("../src/sessions");
const { SessionManager } = await import("../src/web/sessions");

const db = openDb(process.env.MINITUI_DB_PATH!);
mkdirSync(join(dir, "run"), { recursive: true });
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const id = `s-load-${i}`;
  createSession(db, { id, cwd: dir, model: "m", task: `task ${i}`, title: `session ${i}` });
  saveTranscript(db, id, [{ type: "task", text: `task ${i}` }, { type: "assistant", text: `answer ${i}` }],
    { cost: 0.1, apiCalls: 1, exitStatus: "Submitted" },
    [{ role: "user", content: `task ${i}` }, { role: "assistant", content: `answer ${i}` }]);
}
const seedMs = Date.now() - t0;
db.close();

const manager = new SessionManager(() => {}, { syncMs: 0 });
const openStart = Date.now();
for (let i = 0; i < N; i++) manager.openHistory(`s-load-${i}`);
const openMs = Date.now() - openStart;

// One foreign agent alive, so the tick also walks the attach path (synchronous reads of
// /proc/<pid>/cmdline and the trajectory): `foreignRunAlive` recognises a pid by its `-o <traj>`.
const holder = join(dir, "hold.ts");
writeFileSync(holder, "await Bun.sleep(60000);\n");
const traj = join(dir, "run", "traj.json");
const hold = Bun.spawn({ cmd: [process.execPath, holder, "-o", traj], stdout: "ignore" });
await Bun.sleep(150);
const { registerLiveRun } = await import("../src/sessions");
const db2 = openDb(process.env.MINITUI_DB_PATH!);
createSession(db2, { id: "s-foreign", cwd: dir, model: "m", task: "foreign", title: "foreign" });
registerLiveRun(db2, { session_id: "s-foreign", traj_path: traj, control_path: join(dir, "run", "control"), pid: hold.pid, owner: "tui" });
db2.close();

const worst: number[] = [];
const tickStart = Date.now();
for (let t = 0; t < TICKS; t++) {
  const s = Date.now();
  manager.syncExternal();
  worst.push(Date.now() - s);
}
const tickTotal = Date.now() - tickStart;
worst.sort((a, b) => b - a);

console.log(`sessions=${N} seed=${seedMs}ms openAll=${openMs}ms (${(openMs / N).toFixed(2)}ms each)`);
console.log(`ticks=${TICKS} total=${tickTotal}ms mean=${(tickTotal / TICKS).toFixed(2)}ms p50=${worst[Math.floor(TICKS / 2)]}ms max=${worst[0]}ms`);

manager.dispose();
hold.kill();
rmSync(dir, { recursive: true, force: true });

// Worst case: every row was saved by another UI since we opened it, so one tick reloads them all
// (a full-row read plus a JSON parse of events/info/messages, synchronously, per session).
if (process.env.MINITUI_WEB_LOAD_STALE === "1") {
  const db3 = openDb(process.env.MINITUI_DB_PATH!);
  db3.query("UPDATE sessions SET updated_at = ?").run(Date.now() + 5_000);
  db3.close();
  const s = Date.now();
  manager.syncExternal();
  console.log(`stale reload tick: ${Date.now() - s}ms for ${N} sessions`);
}
