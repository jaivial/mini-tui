// Real-browser end-to-end for the window's task board: does the button open the panel, do the
// agents' cards (`mini-tui tasks set`, a real process writing straight to the database) land in it
// live, and does each session say which pane is showing it? A real server (temp database), real
// WebSockets, real Chromium. Every check reads the panel *and* the server's own database. Run
// after `bun run build`:
//   cd web && bun scripts/e2e-session-tasks.mjs
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const root = join(import.meta.dir, "..", "..");
const dir = mkdtempSync(join(tmpdir(), "minitui-e2e-tasks-"));
const dbPath = join(dir, "sessions.db");
const PORT = 6300 + Math.floor(Math.random() * 200); // quiet range: 4600–4899 is e2e.mjs, 5900+ is e2e-notes-persist
const base = `http://127.0.0.1:${PORT}`;
const { createSession, openDb, saveTranscript } = await import(join(root, "src/sessions.ts"));
const db = openDb(dbPath);
for (const [id, title] of [["s-alpha", "Alpha task"], ["s-beta", "Beta task"]]) {
  createSession(db, { id, cwd: "/tmp", model: "deepseek/deepseek-chat", task: title, title });
  saveTranscript(db, id, [{ type: "task", text: title }, { type: "assistant", text: `hello from ${id}` }], { cost: 0.01, apiCalls: 1 }, []);
}
db.close();

const env = { ...process.env, MINITUI_LAST_MODEL_PATH: join(dir, "last-model.json"), MINITUI_CONNECTIONS_PATH: join(dir, "providers.json"), MINITUI_SETTINGS_PATH: join(dir, "settings.json"), MINITUI_SKILLS_DIR: join(dir, "skills"), MINITUI_DB_PATH: dbPath, MINITUI_CONFIG_DIR: dir, MINITUI_RESUME_DIR: join(dir, "resume"), MINITUI_RUNS_DIR: join(dir, "runs"), MINITUI_WEB_SYNC_MS: "250" };
const server = spawn("bun", ["src/web/serve.ts", "--port", String(PORT)], { cwd: root, stdio: "ignore", env });
let up = false;
for (let i = 0; i < 80 && !up; i++) { try { up = (await fetch(`${base}/api/health`)).ok; } catch {} if (!up) await Bun.sleep(100); }
if (!up) { console.log(`FAIL  the test server never came up on ${base} (port ${PORT})`); server.kill(); rmSync(dir, { recursive: true, force: true }); process.exit(1); }
for (const id of ["s-alpha", "s-beta"]) await fetch(`${base}/api/history/${id}`, { method: "POST" });

function chrome() { const r = `${homedir()}/.cache/ms-playwright`; for (const d of readdirSync(r).filter((d) => d.startsWith("chromium-")).sort().reverse()) { const b = `${r}/${d}/chrome-linux64/chrome`; if (existsSync(b)) return b; } }
const browser = await chromium.launch({ executablePath: chrome() });
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); if (!ok) failed++; };
const until = async (cond, ms = 8000) => { const end = Date.now() + ms; while (!(await cond()) && Date.now() < end) await Bun.sleep(50); return cond(); };

/** What the server holds, straight from its own database: the cards' true home. */
const stored = (id) => {
  const row = new Database(dbPath, { readonly: true }).query("SELECT title, todos FROM session_tasks WHERE session_id = ?").get(id);
  return row ? row.title : "";
};

/** The agent's side of the feature: the real command, a process of its own. */
const agent = (...argv) => new Promise((res) => {
  const r = spawn("bun", ["src/index.ts", "tasks", ...argv], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  r.stdout.on("data", (d) => (out += d));
  r.on("exit", (code) => res({ code, out }));
});

try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  await page.goto(base);
  await page.waitForTimeout(1500);

  // One tasks icon per window, in the sidebar's window rows; the drawer is opened from its popover.
  const button = page.getByRole("button", { name: "Tasks of Window 1" });
  check("every window row has its tasks icon", (await button.count()) === 1);
  /** Open the window's task popover and click through to the full board (the drawer). */
  const openBoard = async () => {
    await button.click();
    await page.getByRole("dialog", { name: "Tasks of Window 1" }).waitFor({ timeout: 5000 });
    await page.getByRole("button", { name: "Open board" }).click();
  };

  // ---- 1. the icon opens the window's popover, and the board starts empty (no agent has written yet)
  await button.click();
  const popover = page.getByRole("dialog", { name: "Tasks of Window 1" });
  await popover.waitFor({ timeout: 5000 });
  check("a click opens the window's tasks popover", await popover.isVisible());
  check("the popover is in a portal, drawn over the app and not inside the sidebar rail", await page.evaluate(() => {
    const portal = document.querySelector("[data-popover]");
    const el = portal?.firstElementChild;
    // The card lives in its own container on the body, outside the rail that opened it.
    return !!el && !!portal && portal.parentElement === document.body && !el.closest("aside");
  }));
  check("the popover lists one row per pane", (await popover.getByRole("button", { name: /^Pane \d+:/ }).count()) >= 1);
  await button.click();
  await page.waitForTimeout(300);
  await openBoard();
  const panel = page.getByRole("dialog", { name: "Session tasks" });
  await panel.waitFor({ timeout: 5000 });
  check("a click opens the task panel", await panel.isVisible());
  check("an empty board says the agents fill it", await until(async () => (await panel.textContent()).includes("No task cards yet")));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // ---- 2. a card written the agents' way lands in the panel live (no reload)
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await openBoard();
  const wrote = await agent("set", "--session", "s-alpha", "--title", "Fix the login bug", "--description", "Reworked the auth flow end to end.", "--done", "parse tokens", "--left", "write tests");
  check("`mini-tui tasks set` writes the card (the agent's way)", wrote.code === 0 && stored("s-alpha") === "Fix the login bug", wrote.out.trim());
  check("the card appears in the panel while it is open", await until(async () => (await panel.textContent()).includes("Fix the login bug")));
  const first = await panel.textContent();
  check("the card carries its session's title and its to-dos' state", first.includes("Alpha task") && first.includes("1 done"), first.slice(0, 120));

  // ---- 3. the session sits in a pane now: the card says which one (the drawer stays out of the
  // way: a press outside it dismisses it, so the app can be driven while the board is watched)
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: /Alpha task/ }).first().click();
  await page.waitForTimeout(900);
  await openBoard();
  check("the card names the pane showing its session", await until(async () => /Pane \d+ · Window \d+/.test(await panel.textContent())));

  // ---- 4. the accordion opens on the description and the to-dos
  await panel.locator("summary", { hasText: "Fix the login bug" }).first().click();
  await page.waitForTimeout(300);
  const open = await panel.textContent();
  check("opening the accordion shows the description", open.includes("Reworked the auth flow end to end."));
  check("and the to-dos in their buckets", open.includes("parse tokens") && open.includes("write tests"));

  // ---- 5. the agent keeps writing: the panel keeps up
  const again = await agent("set", "--session", "s-alpha", "--title", "Fix the login bug (v2)", "--description", "Now with tests.", "--done", "parse tokens", "--done", "write tests");
  check("a second write replaces the card (the agent's way)", again.code === 0 && stored("s-alpha") === "Fix the login bug (v2)");
  check("the panel shows the new card without a reload", await until(async () => (await panel.textContent()).includes("Fix the login bug (v2)")));

  // ---- 6. the popover is titled with the window's general task and one row per pane; hovering a row
  // opens that pane's own card, and the drawer stays one click away inside it
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await button.click();
  const glance = page.getByRole("dialog", { name: "Tasks of Window 1" });
  await glance.waitFor({ timeout: 5000 });
  check("the popover is titled with the window's general task", (await glance.textContent()).includes("Fix the login bug (v2)"));
  check("the popover is a peek, not the panel", !(await panel.isVisible()));
  const paneRow = glance.getByRole("button", { name: /^Pane \d+:/ }).first();
  await paneRow.hover();
  const peek = page.getByRole("dialog", { name: /^Pane \d+ of Window 1/ });
  check("hovering a pane row opens that pane's own card", await until(async () => (await peek.count()) > 0));
  check("the pane's card carries its to-dos", await until(async () => (await peek.textContent()).includes("2 done")));
  check("the pane's card is a portal of its own", await page.evaluate(() => document.querySelectorAll("[data-popover]").length === 2));

  // ---- 7. a card for a session no pane shows says so
  await agent("set", "--session", "s-beta", "--title", "Beta's task", "--pending", "everything");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await openBoard();
  check("a session in no pane is labelled so", await until(async () => (await panel.textContent()).includes("Not open in a pane")));
} catch (e) {
  console.log("FAIL  the run threw:", (e?.message ?? String(e)).split("\n")[0]);
  failed++;
} finally {
  await browser.close().catch(() => {});
  server.kill();
  rmSync(dir, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
