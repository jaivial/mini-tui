// Real-browser end-to-end: **opening a SAVED session (Resume) must stick when another tab is open.**
// The workspace is shared by every tab and device, so a session one tab opens in a pane shows in all
// of them. E52 found that it did not: a second tab, which had never loaded that session (it lives in
// the saved history until someone resumes it), read "not in MY list" as "it is gone", cleared the
// pane and WROTE THAT BACK to the shared workspace ~20 ms later. The tab that clicked saw its own
// click undone: the pane stayed on "New chat".
//
// What this test drives: a real server (temp database, fake agent), two real tabs of one browser, and
// the app's own UI (the pane's menu -> "Resume a session" -> a row). The checks below name both the
// symptom (the pane keeps the session) and the writer (the idle tab must not save a "forget"). They
// FAIL on the build that reverts. Run after `bun run build` in web/:
//   cd web && bun scripts/e2e-resume-sticks.mjs                 # this checkout
//   MINITUI_E2E_ROOT=/home/jaime/mini-tui-wa bun scripts/...    # another checkout's build
//   CLIENTS=1 bun scripts/e2e-resume-sticks.mjs                 # the one-tab control
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const root = process.env.MINITUI_E2E_ROOT ?? join(import.meta.dir, "..", "..");
const outDir = process.env.EVIDENCE_DIR ?? join(import.meta.dir, "..", "..", "..", ".e2e-resume-sticks");
const CLIENTS = Number(process.env.CLIENTS ?? 2);
const dir = mkdtempSync(join(tmpdir(), "minitui-e2e-resume-"));
const dbPath = join(dir, "sessions.db");
/** A port nothing is listening on: the run must never drive a foreign mini-tui by accident. */
const freePort = async (start) => {
  for (let p = start; p < start + 250; p++) {
    try {
      const l = Bun.listen({ hostname: "127.0.0.1", port: p, socket: { data() {}, error() {} } });
      l.stop(true);
      return p;
    } catch {
      /* taken: try the next */
    }
  }
  throw new Error("no free port found");
};
const PORT = Number(process.env.PORT ?? (await freePort(6200 + Math.floor(Math.random() * 250))));
const base = `http://127.0.0.1:${PORT}`;
const TITLE = "Migrate settings page";
const { createSession, openDb, saveTranscript } = await import(join(root, "src/sessions.ts"));
{
  const sdb = openDb(dbPath);
  // Saved sessions NOBODY has opened in this server: history-only, exactly what "Resume" is for. No
  // /api/history POST here on purpose: the bug needs a session that a second tab has never loaded.
  const seed = (id, title, cwd, task) => {
    createSession(sdb, { id, cwd, model: "deepseek/deepseek-chat", task, title });
    saveTranscript(sdb, id, [{ type: "task", text: task }, { type: "assistant", text: `answer for ${title}` }],
      { cost: 0.02, apiCalls: 2, exitStatus: "Submitted" },
      [{ role: "system", content: "system" }, { role: "user", content: task }, { role: "assistant", content: `answer for ${title}` }]);
    sdb.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(Date.now() - 2 * 3600e3, id);
  };
  seed("s-hist-a", TITLE, "/work/web/app", "migrate the settings page");
  seed("s-hist-b", "Fix flaky reconnect test", "/work/api", "fix the flaky reconnect test");
  sdb.close();
}
const { makeFakeAgent } = await import(join(root, "tests/helpers/fake-agent.ts"));
const fake = makeFakeAgent(join(dir, "bin"), { holdMs: 200 });
const server = spawn(process.execPath, [join(root, "src/web/serve.ts"), "--port", String(PORT)], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, MINITUI_MINI_BIN: fake.script, MINITUI_EMBEDDED_AGENT: "0", MINITUI_LAST_MODEL_PATH: join(dir, "last-model.json"), MINITUI_CONNECTIONS_PATH: join(dir, "providers.json"), MINITUI_SETTINGS_PATH: join(dir, "settings.json"), MINITUI_SKILLS_DIR: join(dir, "skills"), MINITUI_DB_PATH: dbPath, MINITUI_CONFIG_DIR: dir, MINITUI_RESUME_DIR: join(dir, "resume"), MINITUI_RUNS_DIR: join(dir, "runs") },
});
server.stderr.on("data", (b) => process.env.E2E_VERBOSE && console.log("  [server]", String(b).trim()));
for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await Bun.sleep(100); }

mkdirSync(outDir, { recursive: true });
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`); if (!ok) failed++; };
const until = async (cond, ms = 6000) => { const end = Date.now() + ms; while (!(await cond()) && Date.now() < end) await Bun.sleep(100); return cond(); };

const browser = await chromium.launch({ executablePath: process.env.E2E_CHROME ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const pages = [];
const frames = []; // per page: what it SENT on the hub (the writer is named by what it saves)
for (let i = 0; i < CLIENTS; i++) {
  const p = await ctx.newPage();
  const cdp = await ctx.newCDPSession(p);
  await cdp.send("Network.enable");
  const sent = [];
  cdp.on("Network.webSocketFrameSent", (e) => { if (e.response?.payloadData?.includes("ws.save")) sent.push(e.response.payloadData); });
  frames.push(sent);
  pages.push(p);
}
const [a, b] = pages;
for (const p of pages) { await p.goto(base); await p.waitForTimeout(2500); }

const paneText = (p) => p.locator("section[data-pane]").first().innerText().then((s) => s.replace(/\s+/g, " "));
const paneLabel = (p) => p.locator("section[data-pane]").first().getAttribute("aria-label");
const sessionIdIn = (raw) => (raw.match(/"sessionId":"(s-[a-z0-9-]+)"/g) ?? []).map((m) => m.match(/s-[a-z0-9-]+/)[0]);

// Tab A: the pane's own menu -> "Resume a session" -> the first row (the seeded one).
await a.locator("section[data-pane]").first().getByRole("button", { name: "Bot menu" }).click();
await a.waitForTimeout(300);
await a.getByRole("menuitem", { name: /Resume/ }).first().click();
await a.waitForTimeout(800);
const opt = a.locator('[role="option"]').filter({ hasText: TITLE }).first();
check("the saved session is offered by Resume", (await opt.count()) === 1);
const n0 = frames.map((f) => f.length);
await opt.click();

const shown = await until(async () => (await paneText(a)).includes(TITLE), 4000);
check("the tab that clicked SHOWS the session in its pane", shown, (await paneLabel(a)) ?? "");
check("...and keeps it (no other tab undoes the click)", await until(async () => (await paneText(a)).includes(TITLE), 2500));
if (b) {
  const both = await until(async () => (await paneText(b)).includes(TITLE), 4000);
  check("the OTHER tab shows the same session (shared workspace)", both, await paneLabel(b) ?? "");
}
// The writer: any save AFTER the click must not clear the session the click just showed.
await Bun.sleep(1500);
for (let i = 0; i < CLIENTS; i++) {
  const after = frames[i].slice(n0[i]);
  const clears = after.filter((raw) => {
    const sids = new Set(sessionIdIn(raw));
    return !sids.has("s-hist-a");
  });
  check(`tab ${i + 1}: no save that forgets the resumed session`, clears.length === 0, `saves=${after.length} forgets=${clears.length}`);
  for (const raw of after) console.log(`    [tab ${i + 1} save] sessionIds=${JSON.stringify(sessionIdIn(raw))} panes-part=${(raw.match(/"panes":\{.{0,220}/) ?? ["(none)"])[0]}`);
}
// The other half of the rule (so the fix cannot over-correct): when the server REALLY does not hold
// the session any more (it is deleted), the pane must become a new chat in every tab. That is the
// only verdict that clears a pane, and it must still work.
const del = await fetch(`${base}/api/history/s-hist-a`, { method: "DELETE" });
check("the session is deleted on the server", del.status === 200, `status=${del.status}`);
for (let i = 0; i < CLIENTS; i++) {
  const cleared = await until(async () => !(await paneText(pages[i])).includes(TITLE), 6000);
  check(`tab ${i + 1}: a deleted session leaves its pane as a new chat`, cleared, await paneLabel(pages[i]) ?? "");
}

// The other half of the fix's trap (the adversarial review's finding 1): CLOSE keeps the saved row,
// so asking `openHistory` about a closed session RE-OPENS it. After a close, the session must stay
// closed and the panes must let go of it — the `session-gone` announcement is a verdict, not a
// question.
await fetch(`${base}/api/history/s-hist-b`, { method: "POST" }); // make it live (open it)
await a.locator("section[data-pane]").first().getByRole("button", { name: "Bot menu" }).click();
await a.waitForTimeout(300);
await a.getByRole("menuitem", { name: /Resume/ }).first().click();
await a.waitForTimeout(800);
const optB = a.locator('[role="option"]').filter({ hasText: "Fix flaky reconnect test" }).first();
await optB.click();
check("a second session opens in the pane", await until(async () => (await paneText(a)).includes("Fix flaky reconnect test"), 4000));
const closed = await fetch(`${base}/api/sessions/s-hist-b`, { method: "DELETE" });
check("the session is closed on the server", closed.status === 200, `status=${closed.status}`);
await Bun.sleep(2500);
const liveAfter = await (await fetch(`${base}/api/sessions`)).json();
check("a closed session STAYS closed (the question must not re-open it)", !liveAfter.some((x) => x.id === "s-hist-b"), `live=${liveAfter.map((x) => x.id).join(",")}`);
for (let i = 0; i < CLIENTS; i++) {
  const gone = await until(async () => !(await paneText(pages[i])).includes("Fix flaky reconnect test"), 6000);
  check(`tab ${i + 1}: a closed session leaves its pane as a new chat`, gone, await paneLabel(pages[i]) ?? "");
}

const shot = await a.locator("section[data-pane]").first().screenshot({ path: join(outDir, CLIENTS > 1 ? "pane-DESPUES.png" : "pane-control.png") }).catch(() => null);
console.log(`  captura: ${shot ? shot.length : 0} bytes`);

await browser.close().catch(() => {});
server.kill("SIGTERM");
try { rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(failed ? `${failed} check(s) FAILED` : "all checks passed");
process.exit(failed ? 1 : 0);
