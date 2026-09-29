// Real-browser end-to-end for finish toasts, prompt memory and model switches: a real server (temp database, fake agent)
// and real WebSockets. Run after `bun run build`:  bun scripts/e2e-finish.mjs
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const root = join(import.meta.dir, "..", "..");
const dir = mkdtempSync(join(tmpdir(), "minitui-e2e-finish-"));
const dbPath = join(dir, "sessions.db");
const PORT = 5600 + Math.floor(Math.random() * 300);
const { createSession, openDb, saveTranscript } = await import(join(root, "src/sessions.ts"));
const db = openDb(dbPath);
// Saved sessions nobody has opened in this server: what "Resume" is for.
{
  const sdb = openDb(dbPath);
  const day = 86_400_000;
  const seed = (id, title, cwd, task, ageMs, calls = 2) => {
    createSession(sdb, { id, cwd, model: "deepseek/deepseek-chat", task, title });
    // A session that never reached a model call saved nothing: no events, no messages, no cost.
    saveTranscript(sdb, id, calls ? [{ type: "task", text: task }, { type: "assistant", text: `answer for ${title}` }] : [], { cost: calls ? 0.02 : 0, apiCalls: calls, exitStatus: calls ? "Submitted" : "" },
      calls ? [{ role: "system", content: "system" }, { role: "user", content: task }, { role: "assistant", content: `answer for ${title}` }] : []);
    sdb.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(Date.now() - ageMs, id);
  };
  seed("s-old-a", "Migrate settings page", "/work/web/app", "migrate the settings page", 2 * 3600e3);
  seed("s-old-b", "Fix flaky reconnect test", "/work/api", "fix the flaky reconnect test", 30 * 3600e3);
  seed("s-old-c", "Write the upload retry", "/work/api", "add a retry to upload", 20 * day);
  seed("s-old-d", "Ancient scratch session", "/work/old", "scratch", 40 * day, 0);
  sdb.close();
}
for (const [id, title] of [["s-alpha", "Alpha task"], ["s-beta", "Beta task"]]) {
  createSession(db, { id, cwd: "/tmp", model: "deepseek/deepseek-chat", task: title, title });
  saveTranscript(db, id, [{ type: "task", text: title }, { type: "assistant", text: `hello from ${id}` }], { cost: 0.01, apiCalls: 1 }, []);
}
db.close();

import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync(join(dir, "skills", "pr-body"), { recursive: true });
writeFileSync(join(dir, "skills", "pr-body", "SKILL.md"), "---\nname: pr-body\ndescription: Write a PR body\n---\nBody.\n");
mkdirSync(join(dir, "skills", "better-ui"), { recursive: true });
writeFileSync(join(dir, "skills", "better-ui", "SKILL.md"), "---\nname: better-ui\ndescription: Polish the UI\n---\nPolish.\n");

// Steps send real messages: the agent must be a stub, never a real run. This one records what it was asked
// and journals a reply, so a resumed session can be seen continuing from its saved messages.
const { makeFakeAgent } = await import(join(root, "tests/helpers/fake-agent.ts"));
const fake = makeFakeAgent(join(dir, "bin"), { holdMs: 1500 });
const stub = fake.script;

const server = spawn("bun", ["src/web/serve.ts", "--port", String(PORT)], {
  cwd: root, stdio: "ignore",
  env: { ...process.env, MINITUI_MINI_BIN: stub, MINITUI_EMBEDDED_AGENT: "0", MINITUI_LAST_MODEL_PATH: join(dir, "last-model.json"), MINITUI_CONNECTIONS_PATH: join(dir, "providers.json"), MINITUI_SETTINGS_PATH: join(dir, "settings.json"), MINITUI_SKILLS_DIR: join(dir, "skills"), MINITUI_DB_PATH: dbPath, MINITUI_CONFIG_DIR: dir, MINITUI_RESUME_DIR: join(dir, "resume"), MINITUI_RUNS_DIR: join(dir, "runs") },
});
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await Bun.sleep(100); }
for (const id of ["s-alpha", "s-beta"]) await fetch(`${base}/api/history/${id}`, { method: "POST" });

function chrome() { const r = `${homedir()}/.cache/ms-playwright`; for (const d of readdirSync(r).filter((d) => d.startsWith("chromium-")).sort().reverse()) { const b = `${r}/${d}/chrome-linux64/chrome`; if (existsSync(b)) return b; } }

const browser = await chromium.launch({ executablePath: chrome() });
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); if (!ok) failed++; };
const paneBoxes = (page) => page.locator("section[data-pane]").evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { id: e.dataset.pane, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), label: e.getAttribute("aria-label"), current: e.getAttribute("aria-current") }; }));

try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(base);
  await page.waitForTimeout(1200);
  const toastEls = () => page.locator("[data-toast]");

  // ============================== prompt memory
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  const bar = page.getByLabel("Prompt");
  await bar.fill("first question");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(700);
  await bar.fill("second question");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  await bar.fill("half typed");
  await bar.press("ArrowUp");
  check("↑ recalls the last prompt sent in this chat", (await bar.inputValue()) === "second question");
  await bar.press("ArrowUp");
  check("↑ again goes further back", (await bar.inputValue()) === "first question");
  await bar.press("ArrowUp");
  check("...and stops at the oldest", (await bar.inputValue()) === "first question");
  await bar.press("ArrowDown");
  await bar.press("ArrowDown");
  check("↓ walks forward, then the half-typed draft comes back", (await bar.inputValue()) === "half typed");
  await bar.fill("line one\nline two");
  await bar.evaluate((el) => el.setSelectionRange(el.value.length, el.value.length));
  await bar.press("ArrowUp");
  check("inside a multi-line message ↑ moves the caret, it does not recall", (await bar.inputValue()) === "line one\nline two");
  await bar.fill("");
  // commands come back as chips
  await bar.fill("/mod");
  await page.keyboard.press("Tab");
  await bar.fill("deepseek/deepseek-chat");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  await bar.press("ArrowUp");
  check("a recalled /model comes back as a chip plus its text", (await page.getByRole("list", { name: "Added to this message" }).getByRole("group", { name: "Command model" }).count()) === 1 && (await bar.inputValue()) === "deepseek/deepseek-chat");
  check("...without reopening the command menu over it", (await page.getByRole("listbox", { name: "Commands" }).count()) === 0);
  await page.getByRole("list", { name: "Added to this message" }).getByRole("button").first().click().catch(() => {});
  await bar.fill("");

  // memory survives a reload (seeded from the transcript)
  await page.reload();
  await page.waitForTimeout(1500);
  await page.getByLabel("Prompt").press("ArrowUp");
  check("after a reload, ↑ still recalls this session's prompts", (await page.getByLabel("Prompt").inputValue()) === "second question", await page.getByLabel("Prompt").inputValue());
  await page.getByLabel("Prompt").fill("");

  // ============================== finish toast
  // Start a run in pane 1, then look at something else (a new chat in the same pane): the finish must be announced.
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await page.getByLabel("Prompt").fill("background job");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  const bgTitle = "background job";
  check("while you watch it, the session is running", /running/.test(await page.locator("section[data-pane]").first().innerText()));
  // Away from it: open another session in the pane.
  await page.locator("aside").getByRole("button", { name: /Alpha task/ }).first().click();
  const t0 = Date.now();
  await page.waitForFunction(() => document.querySelector("[data-toast]")?.textContent?.includes("Session finished"), null, { timeout: 8000 }).catch(() => {});
  const toast = toastEls().filter({ hasText: "Session finished" });
  check("when a session you are not looking at finishes, a toast says so", (await toast.count()) === 1 && (await toast.innerText()).includes(bgTitle), `${Date.now() - t0} ms`);
  check("...it names the session and has a View button", (await toast.getByRole("button", { name: "View" }).count()) === 1);
  // hover pauses it: wait past its normal lifetime while hovering
  await toast.hover();
  await page.waitForTimeout(8600);
  check("hovering a toast keeps it on screen past its timeout", (await toast.count()) === 1);
  await toast.getByRole("button", { name: "View" }).click();
  await page.waitForTimeout(600);
  const shown = await page.locator("section[data-pane]").first().getAttribute("aria-label");
  check("View opens that session in the pane", shown.includes(bgTitle), shown);
  check("...focuses its prompt bar", await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Prompt" && !!document.activeElement.closest("section[data-pane]")));
  check("...and closes the toast", (await toastEls().filter({ hasText: "Session finished" }).count()) === 0);
  // watching the session: no toast
  await page.getByLabel("Prompt").fill("watched follow-up");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(3500);
  check("a session that finishes while you watch it does not toast", (await toastEls().filter({ hasText: "Session finished" }).count()) === 0);
  // two panes: the other pane's finish is announced, and View focuses that pane
  await page.keyboard.press("Control+Backslash");
  await page.waitForTimeout(400);
  const panesNow = page.locator("section[data-pane]");
  await panesNow.nth(0).getByRole("button", { name: "New chat here" }).click(); // its own new session
  await panesNow.nth(0).getByLabel("Prompt").fill("left pane job");
  await panesNow.nth(0).getByRole("button", { name: "Send message" }).click();
  await panesNow.nth(1).getByLabel("Prompt").click(); // focus the right pane while the left one works
  await page.waitForFunction(() => [...document.querySelectorAll("[data-toast]")].some((t) => t.textContent.includes("left pane job")), null, { timeout: 8000 }).catch(() => {});
  const leftToast = toastEls().filter({ hasText: "left pane job" });
  check("a session finishing in another pane is announced", (await leftToast.count()) === 1);
  await leftToast.getByRole("button", { name: "View" }).click();
  await page.waitForTimeout(400);
  const boxes = await panesNow.evaluateAll((els) => els.map((e) => [e.getAttribute("aria-label"), e.getAttribute("aria-current")]));
  check("View focuses the pane that already shows it (no second copy)", boxes.length === 2 && boxes[0][1] === "true" && boxes[0][0].includes("left pane job") && !boxes[1][0].includes("left pane job"), JSON.stringify(boxes));
  // a stop you asked for is not announced
  await panesNow.nth(1).getByLabel("Prompt").fill("to be stopped");
  await panesNow.nth(1).getByRole("button", { name: "Send message" }).click();
  await page.waitForTimeout(300);
  await panesNow.nth(1).getByRole("button", { name: "Stop the run" }).click();
  await panesNow.nth(0).getByLabel("Prompt").click();
  await page.waitForTimeout(2500);
  check("interrupting a session yourself does not toast", (await toastEls().filter({ hasText: "to be stopped" }).count()) === 0);

  // ============================== model switch after interrupt / after finish
  const right = panesNow.nth(1);
  const rightId = (await (await fetch(`${base}/api/sessions`)).json()).find((x) => x.title === "to be stopped").id;
  const statusOf = async () => (await (await fetch(`${base}/api/sessions/${rightId}`)).json()).status;
  check("the stopped session reads interrupted", (await statusOf()) === "interrupted");
  await right.getByLabel("Prompt").click();
  await right.getByLabel("Prompt").press("ArrowUp");
  check("after an interrupt, ↑ recalls the prompt", (await right.getByLabel("Prompt").inputValue()) === "to be stopped");
  await right.getByLabel("Prompt").fill("");
  const callsBefore = fake.calls().length;
  await right.getByRole("button", { name: /^Model:/ }).click();
  await page.getByRole("option").filter({ hasNotText: "deepseek-chat" }).first().click();
  await page.waitForTimeout(2000);
  check("changing the model after an interrupt only changes the model: nothing starts", fake.calls().length === callsBefore && (await statusOf()) === "interrupted" && !/Working|Thinking|running/.test(await right.innerText()));
  check("...and says it applies to the next message", /from your next message/.test(await right.innerText()));
  const leftId = (await (await fetch(`${base}/api/sessions`)).json()).find((x) => x.title === "left pane job").id;
  const leftStatus = async () => (await (await fetch(`${base}/api/sessions/${leftId}`)).json()).status;
  check("the finished session reads done", (await leftStatus()) === "done");
  await panesNow.nth(0).getByRole("button", { name: /^Model:/ }).click();
  await page.getByRole("option").filter({ hasNotText: "deepseek-chat" }).first().click();
  await page.waitForTimeout(2000);
  check("changing the model after a finished message only changes the model", fake.calls().length === callsBefore && (await leftStatus()) === "done" && !/Working|Thinking/.test(await panesNow.nth(0).innerText()));
  // and the next message does run on it
  await panesNow.nth(0).getByLabel("Prompt").fill("now on the new model");
  await panesNow.nth(0).getByRole("button", { name: "Send message" }).click();
  await page.waitForTimeout(1500);
  const last = fake.calls().at(-1);
  check("the next message runs, on the new model", fake.calls().length === callsBefore + 1 && last.task === "now on the new model" && !!last.model && last.model !== "deepseek/deepseek-chat", last ? `${last.model}` : "none");
  await ctx.close();

  // ============================== phone: toast is usable
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const ph = await phone.newPage();
  await ph.goto(base);
  await ph.waitForTimeout(1200);
  await ph.getByLabel("Prompt").fill("");
  const sid = (await (await fetch(`${base}/api/sessions`)).json())[0].id;
  // start a turn on a session the phone is not showing
  const other = (await (await fetch(`${base}/api/sessions`)).json()).find((x) => x.id !== sid && x.status !== "running");
  await fetch(`${base}/api/sessions/${other.id}/prompt`, { method: "POST", body: JSON.stringify({ prompt: "phone background" }) });
  await ph.waitForFunction(() => document.querySelector("[data-toast]")?.textContent?.includes("Session finished"), null, { timeout: 9000 }).catch(() => {});
  const pt = ph.locator("[data-toast]").filter({ hasText: "Session finished" });
  const tb = await pt.boundingBox().catch(() => null);
  const vb = await pt.getByRole("button", { name: "View" }).boundingBox().catch(() => null);
  check("on a phone the toast is inside the screen and View is at least 44px", !!tb && tb.x >= 0 && tb.x + tb.width <= 390 && !!vb && vb.height >= 43.5 && vb.width >= 43.5, JSON.stringify([tb, vb]));
  await pt.getByRole("button", { name: "View" }).tap();
  await ph.waitForTimeout(600);
  check("tapping View on a phone opens that session", ((await ph.locator("section[data-pane]").first().getAttribute("aria-label")) ?? "").includes(other.title));
  await phone.close();
} finally {
  await browser.close();
  server.kill();
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `${failed} check(s) FAILED` : "all checks passed");
process.exit(failed ? 1 : 0);
