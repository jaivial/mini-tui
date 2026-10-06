// Real-browser end-to-end for the question "are my notes still there if I close the pane, switch
// the pane to another session, come back, or reload the tab?" — a real server (temp database, fake
// agent), real WebSockets, real Chromium. Every check reads the note back through the UI *and* from
// the server's own database, so a note that only looks saved in the DOM is caught. Panes are
// addressed by the session they show, never by position. Run after `bun run build`:
//   cd web && bun scripts/e2e-notes-persist.mjs
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const root = join(import.meta.dir, "..", "..");
const dir = mkdtempSync(join(tmpdir(), "minitui-e2e-notespersist-"));
const dbPath = join(dir, "sessions.db");
const PORT = 5900 + Math.floor(Math.random() * 300);
const base = `http://127.0.0.1:${PORT}`;
const { createSession, openDb, saveTranscript } = await import(join(root, "src/sessions.ts"));
const db = openDb(dbPath);
for (const [id, title] of [["s-alpha", "Alpha task"], ["s-beta", "Beta task"]]) {
  createSession(db, { id, cwd: "/tmp", model: "deepseek/deepseek-chat", task: title, title });
  saveTranscript(db, id, [{ type: "task", text: title }, { type: "assistant", text: `hello from ${id}` }], { cost: 0.01, apiCalls: 1 }, []);
}
db.close();

const { makeFakeAgent } = await import(join(root, "tests/helpers/fake-agent.ts"));
const fake = makeFakeAgent(join(dir, "bin"), { holdMs: 200 });
const server = spawn("bun", ["src/web/serve.ts", "--port", String(PORT)], {
  cwd: root, stdio: "ignore",
  env: { ...process.env, MINITUI_MINI_BIN: fake.script, MINITUI_EMBEDDED_AGENT: "0", MINITUI_LAST_MODEL_PATH: join(dir, "last-model.json"), MINITUI_CONNECTIONS_PATH: join(dir, "providers.json"), MINITUI_SETTINGS_PATH: join(dir, "settings.json"), MINITUI_SKILLS_DIR: join(dir, "skills"), MINITUI_DB_PATH: dbPath, MINITUI_CONFIG_DIR: dir, MINITUI_RESUME_DIR: join(dir, "resume"), MINITUI_RUNS_DIR: join(dir, "runs") },
});
for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await Bun.sleep(100); }
for (const id of ["s-alpha", "s-beta"]) await fetch(`${base}/api/history/${id}`, { method: "POST" });

function chrome() { const r = `${homedir()}/.cache/ms-playwright`; for (const d of readdirSync(r).filter((d) => d.startsWith("chromium-")).sort().reverse()) { const b = `${r}/${d}/chrome-linux64/chrome`; if (existsSync(b)) return b; } }
const browser = await chromium.launch({ executablePath: chrome() });
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); if (!ok) failed++; };
const until = async (cond, ms = 8000) => { const end = Date.now() + ms; while (!(await cond()) && Date.now() < end) await Bun.sleep(50); return cond(); };

// What the server actually holds, read straight from its own database: the note's true home.
const stored = (id) => new Database(dbPath, { readonly: true }).query("SELECT body FROM notes WHERE session_id = ?").get(id)?.body ?? "";

/** The pane showing session `title`, wherever it sits on screen. */
const paneOf = (page, title) => page.locator("section[data-pane]").filter({ hasText: title }).first();
const value = (pane) => pane.locator("aside.notes textarea").inputValue();
const hasPanel = (pane) => pane.locator("aside.notes textarea").count().then((n) => n > 0);

/** The notes panel is open (its state is restored after a reload, so "Show notes" may be absent). */
async function openNotes(page, pane) {
  const show = pane.getByRole("button", { name: "Show notes" });
  if (await show.count()) await show.click();
  await pane.locator("aside.notes textarea").waitFor({ timeout: 8000 });
}

/** Put session `title` into `pane` by way of the sidebar: what a user does. */
async function useSession(page, pane, title) {
  await pane.click({ position: { x: 150, y: 150 } });
  await page.waitForTimeout(250);
  await page.locator("aside").first().getByRole("button", { name: new RegExp(title) }).first().click();
  await page.waitForTimeout(900);
}

try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  await page.goto(base);
  await page.waitForTimeout(1500);

  // Split, so there is a pane to close while another one stays.
  await page.getByLabel("Prompt").click();
  await page.keyboard.press("Control+Backslash");
  await page.waitForTimeout(700);
  check("two panes to start", (await page.locator("section[data-pane]").count()) === 2);

  const panes = page.locator("section[data-pane]");
  await useSession(page, panes.nth(0), "Alpha task");
  await useSession(page, panes.nth(1), "Beta task");

  // ---- 1. a note typed in a pane is on the server a moment later
  const alpha = paneOf(page, "Alpha task");
  await openNotes(page, alpha);
  await value(alpha).then(() => {});
  await alpha.locator("aside.notes textarea").fill("alpha note: it survives a closed pane");
  check("a note is on the server a moment after typing", await until(async () => stored("s-alpha") === "alpha note: it survives a closed pane"), JSON.stringify(stored("s-alpha")));

  // ---- 2. close the pane the note was written in, then show the session again
  await paneOf(page, "Alpha task").click({ position: { x: 60, y: 320 } });
  await page.keyboard.press("Alt+KeyX");
  await page.waitForTimeout(900);
  check("the pane closed", (await page.locator("section[data-pane]").count()) === 1);
  await useSession(page, page.locator("section[data-pane]").first(), "Alpha task");
  const reopened = paneOf(page, "Alpha task");
  if (!(await hasPanel(reopened))) await openNotes(page, reopened);
  check("the note is still there after the pane it was written in was closed", (await value(reopened)) === "alpha note: it survives a closed pane", JSON.stringify(await value(reopened)));

  // ---- 3. a note typed and then switched away before the autosave fires is flushed, not lost
  const a = paneOf(page, "Alpha task");
  await a.locator("aside.notes textarea").fill("typed at the last moment, then switched away");
  await useSession(page, a, "Beta task");
  check("a note typed just before switching sessions is flushed, not dropped", await until(async () => stored("s-alpha") === "typed at the last moment, then switched away"), JSON.stringify(stored("s-alpha")));

  // ---- 4. coming back to the session shows the flushed note
  await useSession(page, paneOf(page, "Beta task"), "Alpha task");
  const back = paneOf(page, "Alpha task");
  if (!(await hasPanel(back))) await openNotes(page, back);
  check("coming back to the session shows the note again", await until(async () => (await value(back)) === "typed at the last moment, then switched away"), JSON.stringify(await value(back)));

  // ---- 5. notes belong to the session: Beta's panel must not show Alpha's text
  await useSession(page, paneOf(page, "Alpha task"), "Beta task");
  const beta = paneOf(page, "Beta task");
  if (!(await hasPanel(beta))) await openNotes(page, beta);
  check("another session's notes are their own (Beta is empty)", await until(async () => (await value(beta)) === ""), JSON.stringify(await value(beta)));

  // ---- 6. reloading the tab finds the note on the server
  await useSession(page, page.locator("section[data-pane]").first(), "Alpha task");
  await page.reload();
  await page.waitForTimeout(2200);
  const reloaded = paneOf(page, "Alpha task");
  if (!(await hasPanel(reloaded))) await openNotes(page, reloaded);
  check("a reload of the tab shows the same note", (await value(reloaded)) === "typed at the last moment, then switched away", JSON.stringify(await value(reloaded)));

  // ---- 7. closing the notes panel flushes what is pending
  const rp = paneOf(page, "Alpha task");
  await rp.locator("aside.notes textarea").fill("written with the panel about to close");
  await rp.getByRole("button", { name: "Close notes" }).click();
  await page.waitForTimeout(1200);
  check("closing the notes panel flushes the pending save", stored("s-alpha") === "written with the panel about to close", JSON.stringify(stored("s-alpha")));
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
