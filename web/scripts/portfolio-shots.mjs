// Portfolio screenshots of the web app: a real server on a throwaway database with invented, public-safe
// data (made-up folders, sessions, notes) and a fake agent. No real path, host, key or session is shown.
// Usage: bun scripts/portfolio-shots.mjs <outDir>   (run `bun run build` first)
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const out = process.argv[2] ?? "/tmp/portfolio-shots";
mkdirSync(out, { recursive: true });
const root = join(import.meta.dir, "..", "..");
const dir = mkdtempSync(join(tmpdir(), "minitui-shots-"));
// Invented project tree at /home/dev (created for the run and removed after), so every path on screen
// reads like a normal developer machine and never shows a temp directory or a real one.
const fakeHome = "/home/dev";
if (readdirSync(fakeHome).length) throw new Error("/home/dev is not empty: refusing to touch it");
const proj = (p) => join(fakeHome, "projects", p);
for (const p of ["upload-client/.git", "upload-client/src", "upload-client/tests", "web-dashboard/.git", "web-dashboard/src", "billing-api/.git", "infra", "docs-site/.git", ".config"]) mkdirSync(p.startsWith(".") ? join(fakeHome, p) : proj(p), { recursive: true });
const dbPath = join(dir, "sessions.db");
const { createSession, openDb, saveTranscript, saveNote } = await import(join(root, "src/sessions.ts"));
const db = openDb(dbPath);
const H = 3600e3, D = 24 * H, now = Date.now();
const seed = (id, title, cwd, ageMs, answer, model = "cliproxy/claude-sonnet-5-5") => {
  createSession(db, { id, cwd, model, task: title, title });
  saveTranscript(db, id,
    [{ type: "task", text: title }, { type: "assistant", text: answer }],
    { cost: 0.02 + (id.length % 7) / 100, apiCalls: 3 + (id.length % 9), exitStatus: "Submitted" },
    [{ role: "system", content: "system" }, { role: "user", content: title }, { role: "assistant", content: answer }]);
  db.query("UPDATE sessions SET updated_at = ?, created_at = ? WHERE id = ?").run(now - ageMs, now - ageMs - H, id);
};
const S = [
  ["s-u1", "Add retry with backoff to the upload client", "upload-client", 0.2 * H],
  ["s-u2", "Cover the multipart edge cases with tests", "upload-client", 5 * H],
  ["s-u3", "Stream large files instead of buffering them", "upload-client", 2 * D],
  ["s-w1", "Migrate the settings page to the new form components", "web-dashboard", 1 * H],
  ["s-w2", "Fix the flaky date-picker test", "web-dashboard", 26 * H],
  ["s-w3", "Dark mode for the charts", "web-dashboard", 3 * D],
  ["s-w4", "Lazy-load the analytics route", "web-dashboard", 6 * D],
  ["s-b1", "Idempotency keys on the invoices endpoint", "billing-api", 3 * H],
  ["s-b2", "Explain the webhook retry schedule", "billing-api", 4 * D],
  ["s-i1", "Nginx: cache the static assets for a year", "infra", 30 * H],
  ["s-d1", "Write the getting-started guide", "docs-site", 9 * D],
  ["s-d2", "Fix broken links in the API reference", "docs-site", 12 * D],
];
for (const [id, t, p, age] of S) seed(id, t, proj(p), age, `Done: ${t.toLowerCase()}.`);
saveNote(db, "s-u1", "Plan\n- wrap fetch, keep the signature\n- inject the clock so tests are instant\n- max 3 attempts, 200 ms base, full jitter\n\nCheck before merging\n- [x] unit tests\n- [ ] try it against the staging bucket\n- [ ] update the README section on errors");
db.close();

const { makeFakeAgent } = await import(join(root, "tests/helpers/fake-agent.ts"));
const fake = makeFakeAgent(join(dir, "bin"), { holdMs: 2500 });
const PORT = 6900 + Math.floor(Math.random() * 90);
const server = spawn("bun", ["src/web/serve.ts", "--port", String(PORT)], {
  cwd: root, stdio: "ignore",
  env: { ...process.env, HOME: fakeHome, MINITUI_MINI_BIN: fake.script, MINITUI_EMBEDDED_AGENT: "0", MINITUI_DB_PATH: dbPath, MINITUI_CONFIG_DIR: dir,
    MINITUI_RESUME_DIR: join(dir, "resume"), MINITUI_RUNS_DIR: join(dir, "runs"), MINITUI_LAST_MODEL_PATH: join(dir, "last.json"),
    MINITUI_CONNECTIONS_PATH: join(dir, "providers.json"), MINITUI_SETTINGS_PATH: join(dir, "settings.json"), MINITUI_SKILLS_DIR: join(dir, "skills") },
});
writeFileSync(join(dir, "last.json"), JSON.stringify({ model: "cliproxy/claude-sonnet-5-5" }));
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await Bun.sleep(100); }

// The transcript shown in the main chat: a realistic run, as the agent's journal would produce it.
const events = [
  { type: "task", text: "Add retry with backoff to the upload client" },
  { type: "thinking", text: "The client calls fetch directly. Wrap it, keep the signature, inject the clock so the test is fast.", seconds: 6 },
  { type: "tool_call", id: "c1", name: "bash", command: "rg -n 'fetch\\(' src/upload.ts" },
  { type: "observation", toolCallId: "c1", returncode: 0, output: "src/upload.ts:41:  const res = await fetch(url, init);", exceptionInfo: "" },
  { type: "tool_call", id: "c2", name: "bash", command: "bun test tests/upload.test.ts" },
  { type: "observation", toolCallId: "c2", returncode: 0, output: " 6 pass\n 0 fail\nRan 6 tests across 1 file. [48ms]", exceptionInfo: "" },
  { type: "assistant", text: "Done. `upload()` now retries up to **3 times** with exponential backoff and full jitter.\n\n- the clock is injectable, so the test runs in milliseconds\n- a `Retry-After` header is honoured\n- non-idempotent requests are never retried" },
];
// Open the demo sessions so they have live transcripts (the server holds them), then give s-u1 its run.
for (const id of ["s-u1", "s-w1", "s-b1"]) await fetch(`${base}/api/history/${id}`, { method: "POST" });

function chrome() { const r = `${homedir()}/.cache/ms-playwright`; for (const d of readdirSync(r).filter((d) => d.startsWith("chromium-")).sort().reverse()) { const b = `${r}/${d}/chrome-linux64/chrome`; if (existsSync(b)) return b; } }
const browser = await chromium.launch({ executablePath: chrome() });
const written = [];

async function open(w, h, { scheme = "dark", mobile = false, prefs = {} } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, hasTouch: mobile, isMobile: mobile, colorScheme: scheme });
  await ctx.addInitScript(([t, p]) => {
    localStorage.setItem("minitui.theme", t);
    for (const [k, v] of Object.entries(p)) localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v));
  }, [scheme, prefs]);
  const page = await ctx.newPage();
  // The main demo session's socket carries the rich transcript; every other socket goes to the real server.
  await page.routeWebSocket(/\/api\/sessions\/s-u1\/socket/, (ws) => {
    const meta = { id: "s-u1", title: "Add retry with backoff to the upload client", cwd: proj("upload-client"), model: "cliproxy/claude-sonnet-5-5", task: "x", target: "local", status: "done", createdAt: now - 2 * H, updatedAt: now - 60e3, startedAt: now - 42e3, apiCalls: 9, cost: 0.142, exitStatus: "Submitted", info: { cost: 0.142, apiCalls: 9 } };
    ws.send(JSON.stringify({ t: "snapshot", id: "s-u1", session: { ...meta, events } }));
    ws.onMessage((m) => { try { if (JSON.parse(String(m)).t === "ping") ws.send(JSON.stringify({ t: "pong", id: "s-u1" })); } catch {} });
  });
  await page.routeWebSocket(/\/api\/(sessions\/(?!s-u1)[^/]+\/socket|hub)$/, (ws) => { const up = ws.connectToServer(); ws.onMessage((m) => up.send(m)); up.onMessage((m) => ws.send(m)); });
  await page.goto(base);
  await page.waitForTimeout(1400);
  return { ctx, page };
}
async function shot(page, name, expect = []) {
  // innerText leaves out what is typed in fields (a note's text): include their values too.
  const text = await page.evaluate(() => document.body.innerText + "\n" + [...document.querySelectorAll("textarea, input")].map((e) => e.value).join("\n"));
  for (const needle of expect) if (!text.toLowerCase().includes(needle.toLowerCase())) throw new Error(`${name}: expected "${needle}" on screen`);
  const bad = text.match(/Could not[^\n]*|Something went wrong|undefined|NaN|\/tmp\/|minitui-shots/);
  if (bad) throw new Error(`${name}: unwanted text on screen: ${bad[0]}`);
  await page.screenshot({ path: `${out}/${name}.png` });
  written.push(name);
  console.log("shot", name);
}
const layout = (tree, panes, focused) => JSON.stringify({ v: 1, tree, panes, focused });
const pane = (id) => ({ kind: "pane", id });
const split = (id, dir, a, b, ratio = 0.5) => ({ kind: "split", id, dir, ratio, a, b });

try {
  // 1. The main chat, desktop, dark
  let { ctx, page } = await open(1440, 900, { prefs: { "minitui.panes": layout(pane("p1"), { p1: { sessionId: "s-u1", notesOpen: false } }, "p1") } });
  await shot(page, "01-chat", ["Add retry with backoff", "retries up to", "Thought for 6s"]);
  // 2. Notes open beside it
  await page.getByRole("button", { name: "Show notes" }).click();
  await page.waitForTimeout(800);
  await page.getByRole("complementary", { name: "Notes" }).getByRole("textbox").evaluate((el) => el.blur());
  await shot(page, "02-notes", ["Notes", "inject the clock", "staging bucket"]);
  await ctx.close();

  // 3. Three panes, tmux style, by-folder sidebar
  ({ ctx, page } = await open(1680, 1000, { prefs: {
    "minitui.panes": layout(split("s1", "row", pane("p1"), split("s2", "col", pane("p2"), pane("p3")), 0.55), { p1: { sessionId: "s-u1", notesOpen: false }, p2: { sessionId: "s-w1", notesOpen: false }, p3: { sessionId: "s-b1", notesOpen: false } }, "p1"),
    "minitui.sidebar": { view: "folder", pinned: [proj("upload-client")], expanded: { [proj("web-dashboard")]: true } },
  } }));
  await page.waitForTimeout(800);
  await shot(page, "03-panes", ["Add retry with backoff", "Migrate the settings page", "Idempotency keys", "upload-client"]);
  await ctx.close();

  // 4. Sidebar organized by folder (close-up), 5. Folder picker, 6. Resume
  ({ ctx, page } = await open(1440, 900, { prefs: {
    "minitui.panes": layout(pane("p1"), { p1: { sessionId: null, notesOpen: false } }, "p1"),
    "minitui.sidebar": { view: "folder", pinned: [proj("upload-client")], expanded: { [proj("web-dashboard")]: true, [proj("billing-api")]: true } },
  } }));
  await page.waitForTimeout(900);
  await shot(page, "04-by-folder", ["By folder", "upload-client", "web-dashboard", "billing-api", "What should we work on?"]);
  const fp = page.getByRole("dialog", { name: /Choose a folder/ });
  for (let i = 0; i < 3 && !(await fp.count()); i++) {
    await page.getByRole("button", { name: /^Folder: / }).click();
    await page.waitForTimeout(500);
  }
  await fp.getByRole("combobox").waitFor();
  await fp.getByRole("combobox").fill("~/projects");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(700);
  await fp.getByRole("combobox").fill("");
  await page.waitForTimeout(200);
  await shot(page, "05-folder-picker", ["upload-client", "web-dashboard", "Use this folder"]);
  await page.keyboard.press("Escape");
  await page.getByLabel("Prompt").fill("/res");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await page.getByRole("dialog", { name: "Resume a session" }).getByRole("option").first().waitFor();
  await page.waitForTimeout(500);
  await shot(page, "06-resume", ["Resume a session", "Today", "Yesterday"]);
  await page.keyboard.press("Escape");
  // 7. Session finished toast (a real run, in the background)
  await page.getByLabel("Prompt").fill("Bump the dependencies and run the test suite");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(700);
  await page.locator("aside").getByRole("button", { name: /Migrate the settings page/ }).first().click();
  await page.waitForFunction(() => document.querySelector("[data-toast]")?.textContent?.includes("Session finished"), null, { timeout: 12000 });
  await page.locator("[data-toast]").first().hover();
  await page.waitForTimeout(300);
  await shot(page, "07-finished-toast", ["Session finished", "View"]);
  // 8. Settings: size
  await page.mouse.move(700, 500);
  await page.keyboard.press("Control+Comma");
  await page.waitForTimeout(700);
  await shot(page, "08-settings-size", ["Interface size", "Text size", "Preview"]);
  await ctx.close();

  // 9. Light theme, two panes with notes
  ({ ctx, page } = await open(1440, 900, { scheme: "light", prefs: {
    "minitui.panes": layout(split("s1", "row", pane("p1"), pane("p2"), 0.5), { p1: { sessionId: "s-u1", notesOpen: true }, p2: { sessionId: "s-w1", notesOpen: false } }, "p1"),
    "minitui.sidebar": { view: "recent", pinned: [], expanded: {} },
  } }));
  await page.waitForTimeout(1000);
  await page.getByRole("complementary", { name: "Notes" }).getByRole("textbox").evaluate((el) => el.blur());
  await shot(page, "09-light-panes-notes", ["retries up to", "Notes", "Migrate the settings page"]);
  await ctx.close();

  // 10-12. Phone: chat, sidebar by folder, panes as tabs
  ({ ctx, page } = await open(390, 844, { mobile: true, prefs: {
    "minitui.panes": layout(split("s1", "row", pane("p1"), pane("p2")), { p1: { sessionId: "s-u1", notesOpen: false }, p2: { sessionId: "s-w1", notesOpen: false } }, "p1"),
    "minitui.sidebar": { view: "folder", pinned: [proj("upload-client")], expanded: {} },
  } }));
  await page.waitForTimeout(900);
  await shot(page, "10-phone-chat-tabs", ["retries up to", "Migrate the settings"]);
  await page.getByRole("button", { name: "Toggle sidebar" }).first().tap();
  await page.waitForTimeout(600);
  await shot(page, "11-phone-by-folder", ["By folder", "upload-client"]);
  await ctx.close();
  // A fresh phone with the notes panel already open for the chat (it covers the pane on a phone).
  ({ ctx, page } = await open(390, 844, { mobile: true, prefs: {
    "minitui.panes": layout(pane("p1"), { p1: { sessionId: "s-u1", notesOpen: true } }, "p1"),
  } }));
  await page.waitForTimeout(900);
  await page.getByRole("complementary", { name: "Notes" }).getByRole("textbox").evaluate((el) => el.blur());
  await shot(page, "12-phone-notes", ["Notes", "inject the clock"]);
  await ctx.close();
} finally {
  await browser.close();
  server.kill();
  rmSync(dir, { recursive: true, force: true });
  Bun.spawnSync({ cmd: ["sudo", "-n", "rm", "-rf", fakeHome] });
}
console.log("wrote", written.length, "screenshots to", out);
