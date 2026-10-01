// Real-browser regression test: panes keep sending after window switches and session swaps, a sidebar
// click on a session that a pane already shows goes to that pane, and live rows hold their order.
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const root = join(import.meta.dir, "..", "..");
const dir = mkdtempSync(join(tmpdir(), "minitui-e2e-panes-"));
const dbPath = join(dir, "sessions.db");
const PORT = 5200 + Math.floor(Math.random() * 400);
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
for (const [id, title] of [["s-alpha", "Alpha task"], ["s-beta", "Beta task"], ["s-gamma", "Gamma task"], ["s-delta", "Delta task"]]) {
  createSession(db, { id, cwd: "/tmp", model: "deepseek/deepseek-chat", task: title, title });
  saveTranscript(db, id, [{ type: "task", text: title }, { type: "assistant", text: `hello from ${id}` }], { cost: 0.01, apiCalls: 1 },
    [{ role: "system", content: "system" }, { role: "user", content: title }, { role: "assistant", content: `hello from ${id}` }]);
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
const fake = makeFakeAgent(join(dir, "bin"), { holdMs: 4000 }); // long enough to watch live rows
const stub = fake.script;

const startServer = () => spawn("bun", ["src/web/serve.ts", "--port", String(PORT)], {
  cwd: root, stdio: "ignore",
  env: { ...process.env, MINITUI_MINI_BIN: stub, MINITUI_EMBEDDED_AGENT: "0", MINITUI_LAST_MODEL_PATH: join(dir, "last-model.json"), MINITUI_CONNECTIONS_PATH: join(dir, "providers.json"), MINITUI_SETTINGS_PATH: join(dir, "settings.json"), MINITUI_SKILLS_DIR: join(dir, "skills"), MINITUI_DB_PATH: dbPath, MINITUI_CONFIG_DIR: dir, MINITUI_RESUME_DIR: join(dir, "resume"), MINITUI_RUNS_DIR: join(dir, "runs") },
});

let server = startServer();
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await Bun.sleep(100); }
for (const id of ["s-alpha", "s-beta", "s-gamma", "s-delta"]) await fetch(`${base}/api/history/${id}`, { method: "POST" });

function chrome() { const r = `${homedir()}/.cache/ms-playwright`; for (const d of readdirSync(r).filter((d) => d.startsWith("chromium-")).sort().reverse()) { const b = `${r}/${d}/chrome-linux64/chrome`; if (existsSync(b)) return b; } }

const browser = await chromium.launch({ executablePath: chrome() });
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); if (!ok) failed++; };
const calls = () => fake.calls().length;
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (/derived_inert/.test(m.text())) problems.push("derived_inert"); });
  await page.goto(base);
  await page.waitForTimeout(1200);
  const sidebar = page.locator("aside");
  const panes = () => page.locator("section[data-pane]");
  const focusedLabel = () => page.locator('section[data-pane][aria-current="true"]').getAttribute("aria-label");
  const openRow = (re) => sidebar.getByRole("button", { name: re }).first();

  const where = async () => {};
  // Window 1: alpha | beta. Window 2: gamma | delta.
  await where("start");
  // The app opens the newest session first, whichever that is: put alpha in pane 1 on purpose.
  await openRow(/Alpha task/).click();
  await page.waitForTimeout(400);
  await page.getByLabel("Prompt").first().click();
  await page.keyboard.press("Control+Backslash");
  await page.waitForTimeout(300);
  await where("split");
  await openRow(/Beta task/).click();
  await page.waitForTimeout(400);
  await where("beta");
  await sidebar.getByRole("button", { name: "New window" }).click();
  await page.waitForTimeout(400);
  await where("new window");
  await openRow(/Gamma task/).click();
  await page.waitForTimeout(400);
  await where("gamma");
  await page.getByLabel("Prompt").first().click();
  await page.keyboard.press("Control+Backslash");
  await page.waitForTimeout(300);
  await where("split 2");
  await openRow(/Delta task/).click();
  await page.waitForTimeout(400);
  await where("delta");

  // ---- 1. a session already on screen: the sidebar goes to its pane, and moves nothing else
  const labels = async () => (await panes().evaluateAll((els) => els.map((e) => e.getAttribute("aria-label"))));
  const before2 = await labels();
  await panes().nth(1).click({ position: { x: 40, y: 80 } }); // focus delta's pane
  await openRow(/Gamma task/).click(); // gamma is in pane 1 of this same window
  await page.waitForTimeout(400);
  check("a session open in this window: the sidebar focuses its pane", /Gamma task/.test((await focusedLabel()) ?? ""), String(await focusedLabel()));
  check("...and no pane changes what it shows", JSON.stringify(await labels()) === JSON.stringify(before2), JSON.stringify(await labels()));
  await openRow(/Beta task/).click(); // beta is in window 1
  await page.waitForTimeout(500);
  const rows = await sidebar.locator('[role="radiogroup"][aria-label="Window to show"] [role="radio"]').evaluateAll((els) => els.map((e) => e.getAttribute("aria-checked")));
  check("a session open in another window: that window comes on screen", rows[0] === "true", JSON.stringify(rows));
  check("...with focus on the pane that shows it", /Beta task/.test((await focusedLabel()) ?? ""), String(await focusedLabel()));
  check("...and window 1 still shows alpha and beta", JSON.stringify((await labels()).map((l) => l.replace(/^Pane \d: /, ""))) === JSON.stringify(["Alpha task", "Beta task"]), JSON.stringify(await labels()));
  await sidebar.getByRole("radio", { name: /Window 2/ }).click();
  await page.waitForTimeout(400);
  check("...and window 2 still shows gamma and delta, untouched", JSON.stringify((await labels()).map((l) => l.replace(/^Pane \d: /, ""))) === JSON.stringify(["Gamma task", "Delta task"]), JSON.stringify(await labels()));

  // ---- 2. send keeps working after windows and session swaps
  for (let round = 0; round < 4; round++) {
    await sidebar.getByRole("radio", { name: /Window 1/ }).click();
    await page.waitForTimeout(250);
    await sidebar.getByRole("radio", { name: /Window 2/ }).click();
    await page.waitForTimeout(250);
  }
  let sentOk = 0, tried = 0;
  for (const w of ["Window 1", "Window 2"]) {
    await sidebar.getByRole("radio", { name: new RegExp(w) }).click();
    await page.waitForTimeout(500);
    const n = await panes().count();
    for (let i = 0; i < n; i++) {
      const box = panes().nth(i).getByLabel("Prompt");
      const before = calls();
      await box.click();
      await box.fill(`hello from ${w} pane ${i + 1}`);
      await panes().nth(i).getByRole("button", { name: "Send message" }).click();
      await page.waitForTimeout(900);
      tried++;
      if (calls() === before + 1 && (await box.inputValue()) === "") sentOk++;
    }
  }
  check("after switching windows back and forth, every pane still sends", sentOk === tried && tried === 4, `${sentOk}/${tried}`);
  check("...with no page errors and no reads of a destroyed pane's state", problems.length === 0, JSON.stringify(problems.slice(0, 3)));

  // ---- 3. live sessions hold their place in the sidebar
  // The rows under the "Live" heading, while they run (the fake agent holds each run a few seconds).
  const liveRows = () => sidebar.locator('[role="list"]').evaluate((list) => {
    const out = []; let inLive = false;
    for (const el of list.children) {
      const head = el.querySelector?.("span.uppercase")?.textContent?.trim();
      if (head) { inLive = head === "Live"; continue; }
      if (inLive && el.getAttribute("role") === "listitem") out.push(el.querySelector(":scope > button[title]")?.getAttribute("title"));
    }
    return out;
  });
  // Start all four again, oldest first, so they are live together.
  const starts = [];
  for (const w of ["Window 1", "Window 2"]) {
    await sidebar.getByRole("radio", { name: new RegExp(w) }).click();
    await page.waitForTimeout(400);
    for (let i = 0; i < (await panes().count()); i++) {
      const box = panes().nth(i).getByLabel("Prompt");
      await box.fill(`again ${w} ${i + 1}`);
      await panes().nth(i).getByRole("button", { name: "Send message" }).click();
      await page.waitForTimeout(250);
      starts.push(await panes().nth(i).getAttribute("aria-label"));
    }
  }
  const samples = [];
  for (let t = 0; t < 6; t++) {
    samples.push(await liveRows());
    await page.waitForTimeout(300);
  }
  const full = samples.filter((r) => r.length >= 3);
  check("live rows are there while they run", full.length >= 2, JSON.stringify(samples.map((r) => r.length)));
  // Rows may leave as runs finish; the ones still live never change places.
  const kept = (r) => r.filter((t) => full.every((x) => x.includes(t)));
  check("...and they hold one order while they stream", full.every((r) => JSON.stringify(kept(r)) === JSON.stringify(kept(full[0]))), JSON.stringify(full.map((r) => r.join(","))));
  await ctx.close();

  // ---- 4. a layout saved before pane ids were unique (every window's first pane was "p1")
  const ctx3 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx3.addInitScript(() => {
    if (localStorage.getItem("minitui.seeded")) return;
    localStorage.setItem("minitui.seeded", "1");
    localStorage.setItem("minitui.windows", JSON.stringify({ v: 1, list: [{ id: "wa", name: null }, { id: "wb", name: null }], active: "wb" }));
    localStorage.setItem("minitui.panes", JSON.stringify({ v: 2, focused: "p1", byWindow: {
      wa: { tree: { kind: "split", id: "s1", dir: "row", ratio: 0.5, a: { kind: "pane", id: "p1" }, b: { kind: "pane", id: "p2" } }, panes: { p1: { sessionId: "s-alpha" }, p2: { sessionId: "s-beta" } }, focused: "p1" },
      wb: { tree: { kind: "split", id: "s1", dir: "row", ratio: 0.5, a: { kind: "pane", id: "p1" }, b: { kind: "pane", id: "p3" } }, panes: { p1: { sessionId: "s-gamma" }, p3: { sessionId: "s-delta" } }, focused: "p3" },
    } }));
  });
  const old = await ctx3.newPage();
  await old.goto(base);
  await old.waitForTimeout(1500);
  const lbl = () => old.locator("section[data-pane]").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label").replace(/^Pane \d: /, "")));
  const ids = () => old.locator("section[data-pane]").evaluateAll((els) => els.map((e) => e.dataset.pane));
  const onB = await lbl();
  const idsB = await ids();
  await old.locator("aside").getByRole("button", { name: /Alpha task/ }).first().click(); // alpha lives in window A
  await old.waitForTimeout(500);
  const onA = await lbl();
  const idsA = await ids();
  check("an old layout with \"p1\" in two windows comes back whole", JSON.stringify(onB) === JSON.stringify(["Gamma task", "Delta task"]) && JSON.stringify(onA) === JSON.stringify(["Alpha task", "Beta task"]), `${JSON.stringify(onB)} / ${JSON.stringify(onA)}`);
  check("...and its panes now have ids no other window uses", new Set([...idsA, ...idsB]).size === idsA.length + idsB.length, JSON.stringify([idsA, idsB]));
  await ctx3.close();
} catch (e) {
  console.log("THREW", e);
  failed++;
} finally {
  await browser.close();
  server.kill();
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `${failed} check(s) FAILED` : "all checks passed");
process.exit(failed ? 1 : 0);
