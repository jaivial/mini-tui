// Real-browser end-to-end: the workspace (windows, panes, sidebar) is the same on every device, browser
// and tab, and a change on one shows on the others live.
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
const fake = makeFakeAgent(join(dir, "bin"), { holdMs: 300 });
const stub = fake.script;

const startServer = () => spawn("bun", ["src/web/serve.ts", "--port", String(PORT)], {
  cwd: root, stdio: "ignore",
  env: { ...process.env, MINITUI_MINI_BIN: stub, MINITUI_EMBEDDED_AGENT: "0", MINITUI_LAST_MODEL_PATH: join(dir, "last-model.json"), MINITUI_CONNECTIONS_PATH: join(dir, "providers.json"), MINITUI_SETTINGS_PATH: join(dir, "settings.json"), MINITUI_SKILLS_DIR: join(dir, "skills"), MINITUI_DB_PATH: dbPath, MINITUI_CONFIG_DIR: dir, MINITUI_RESUME_DIR: join(dir, "resume"), MINITUI_RUNS_DIR: join(dir, "runs") },
});

let server = startServer();
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await Bun.sleep(100); }
// Open the seeded sessions, retrying until the server holds all four (a busy box can be slow to start).
for (let attempt = 0; attempt < 20; attempt++) {
  for (const id of ["s-alpha", "s-beta", "s-gamma", "s-delta"]) await fetch(`${base}/api/history/${id}`, { method: "POST" }).catch(() => {});
  const held = await fetch(`${base}/api/sessions`).then((r) => r.json()).catch(() => []);
  if (["s-alpha", "s-beta", "s-gamma", "s-delta"].every((id) => held.some((s) => s.id === id))) break;
  await Bun.sleep(150);
}

function chrome() { const r = `${homedir()}/.cache/ms-playwright`; for (const d of readdirSync(r).filter((d) => d.startsWith("chromium-")).sort().reverse()) { const b = `${r}/${d}/chrome-linux64/chrome`; if (existsSync(b)) return b; } }
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); if (!ok) failed++; };
// Two browsers that share nothing: separate contexts are separate profiles (own localStorage).
const browser = await chromium.launch({ executablePath: chrome() });
const desk = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const winRows = (page) => page.locator('aside [role="radiogroup"][aria-label="Window to show"] [role="radio"]').evaluateAll((els) => els.map((e) => `${e.innerText.split("\n")[0]}${e.getAttribute("aria-checked") === "true" ? "*" : ""}`));
const paneLabels = (page) => page.locator("section[data-pane]").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label").replace(/^Pane \d: /, "")));
const tabsOf = (page) => page.locator('[role="tablist"][aria-label="Panes"] [role="tab"]').evaluateAll((els) => els.map((e) => e.innerText.replace(/^\d+\s*/, "").split("\n")[0]));
const until = async (fn, ok, ms = 4000) => { let v; for (let t = 0; t < ms / 100; t++) { v = await fn(); if (ok(v)) return v; await Bun.sleep(100); } return v; };
try {
  const a = await desk.newPage();
  await a.goto(base);
  await a.waitForTimeout(1200);
  const side = a.locator("aside");
  // Desktop: alpha | beta in window 1, then a second window with gamma.
  await side.getByRole("button", { name: /Alpha task/ }).first().click();
  await a.waitForTimeout(300);
  await a.getByLabel("Prompt").first().click();
  await a.keyboard.press("Control+Backslash");
  await a.waitForTimeout(300);
  await side.getByRole("button", { name: /Beta task/ }).first().click();
  await a.waitForTimeout(300);
  await side.getByRole("button", { name: "New window" }).click();
  await a.waitForTimeout(300);
  await side.getByRole("button", { name: /Gamma task/ }).first().click();
  await a.waitForTimeout(300);
  await side.getByRole("button", { name: "Rename Window 2" }).click();
  await side.locator('input[aria-label="Window name"]').fill("Phone work");
  await side.locator('input[aria-label="Window name"]').press("Enter");
  await side.getByRole("radio", { name: /By folder/ }).click();
  await a.waitForTimeout(600);
  const deskRows = await winRows(a);
  check("desktop: two windows, the second renamed and on screen", JSON.stringify(deskRows) === '["Window 1","Phone work*"]', JSON.stringify(deskRows));

  // A different browser (a phone) opens the app: it shows the same windows, on the same one.
  const p = await phoneCtx.newPage();
  await p.goto(base);
  await p.waitForTimeout(1500);
  check("a phone opening the app shows the same window on screen, with the same pane", JSON.stringify(await paneLabels(p)) === '["Gamma task"]', JSON.stringify(await paneLabels(p)));
  await p.locator('button[aria-label="Toggle sidebar"]').first().click();
  await p.waitForTimeout(500);
  check("...and the same windows, with the same names", JSON.stringify(await winRows(p)) === JSON.stringify(deskRows), JSON.stringify(await winRows(p)));
  check("...and the sidebar's view (By folder) followed too", (await p.locator("aside").getByRole("radio", { name: /By folder/ }).getAttribute("aria-checked")) === "true");
  // On the phone, switch to window 1: it holds alpha | beta, shown as tabs on a narrow screen.
  await p.locator("aside").getByRole("radio", { name: /Window 1/ }).click();
  await p.waitForTimeout(600);
  check("the phone sees window 1's two panes (as tabs on a narrow screen)", JSON.stringify(await tabsOf(p)) === '["Alpha task","Beta task"]', JSON.stringify(await tabsOf(p)));

  // That switch shows on the desktop, live, without a reload.
  const deskNow = await until(() => winRows(a), (r) => r[0] === "Window 1*");
  check("a change on the phone shows on the desktop live, no reload", deskNow[0] === "Window 1*", JSON.stringify(deskNow));
  check("...with window 1's panes on the desktop's screen", JSON.stringify(await until(() => paneLabels(a), (l) => l.length === 2)) === '["Alpha task","Beta task"]', JSON.stringify(await paneLabels(a)));

  // The desktop splits again and opens delta: the phone gets a third tab.
  await a.locator("section[data-pane]").nth(1).click({ position: { x: 40, y: 80 } });
  await a.getByLabel("Prompt").nth(1).click();
  await a.keyboard.press("Control+Shift+Backslash"); // split down: a 600px pane has no room to split right
  await a.waitForTimeout(300);
  await side.getByRole("button", { name: /Delta task/ }).first().click();
  const phoneTabs = await until(() => tabsOf(p), (t) => t.length === 3);
  check("a pane added on the desktop shows on the phone live", JSON.stringify(phoneTabs) === '["Alpha task","Beta task","Delta task"]', JSON.stringify(phoneTabs));

  // A half-typed prompt is not shared (it is yours, in that tab), and it survives the other device's changes.
  await a.getByLabel("Prompt").first().fill("half typed on the desktop");
  await p.locator("aside").getByRole("radio", { name: /Phone work/ }).click();
  await until(() => winRows(a), (r) => r[1] === "Phone work*");
  await p.locator("aside").getByRole("radio", { name: /Window 1/ }).click();
  await until(() => winRows(a), (r) => r[0] === "Window 1*");
  await a.waitForTimeout(400);
  check("a half-typed prompt stays in its tab through another device's switches", (await a.getByLabel("Prompt").first().inputValue()) === "half typed on the desktop");

  // Both devices make a change at the same moment: they end up showing one and the same layout.
  await Promise.all([
    side.getByRole("button", { name: "New window" }).click(),
    p.locator("aside").getByRole("button", { name: "New window" }).click(),
  ]);
  await a.waitForTimeout(1500);
  if (!(await p.locator("aside").count())) await p.locator('button[aria-label="Toggle sidebar"]').first().click();
  await p.waitForTimeout(400);
  const ra = await winRows(a), rp = await winRows(p);
  check("two devices changing at once converge on the same windows", JSON.stringify(ra) === JSON.stringify(rp) && ra.length >= 3, `${JSON.stringify(ra)} vs ${JSON.stringify(rp)}`);
  await side.getByRole("radio", { name: /Window 1/ }).click();
  await until(() => winRows(p), (r) => r[0] === "Window 1*");
  const expected = JSON.stringify(await winRows(a));

  // A third, fresh browser and a reload both see the same thing.
  const c = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await c.goto(base);
  await c.waitForTimeout(1500);
  check("a third browser shows the same layout", JSON.stringify(await paneLabels(c)) === '["Alpha task","Beta task","Delta task"]' && JSON.stringify(await winRows(c)) === expected, `${JSON.stringify(await paneLabels(c))} ${JSON.stringify(await winRows(c))}`);
  // The server keeps it: restart it, and a new browser still sees it.
  server.kill();
  await Bun.sleep(500);
  server = startServer();
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await Bun.sleep(100); }
  const d = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await d.goto(base);
  await d.waitForTimeout(2500);
  check("after a server restart the layout is still the same for a new browser", JSON.stringify(await winRows(d)) === expected && (await paneLabels(d)).length === 3, `${JSON.stringify(await winRows(d))} ${JSON.stringify(await paneLabels(d))}`);
  check("the workspace is one file on the server", existsSync(join(dir, "web-workspace.json")));
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
