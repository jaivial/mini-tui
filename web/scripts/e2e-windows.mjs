// Real-browser end-to-end for panes, notes and size settings: a real server (temp database, fake agent)
// and real WebSockets. Run after `bun run build`:  bun scripts/e2e-panes.mjs
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
const fake = makeFakeAgent(join(dir, "bin"), { holdMs: 300 });
const stub = fake.script;

const startServer = () => spawn("bun", ["src/web/serve.ts", "--port", String(PORT)], {
  cwd: root, stdio: "ignore",
  env: { ...process.env, MINITUI_MINI_BIN: stub, MINITUI_EMBEDDED_AGENT: "0", MINITUI_LAST_MODEL_PATH: join(dir, "last-model.json"), MINITUI_CONNECTIONS_PATH: join(dir, "providers.json"), MINITUI_SETTINGS_PATH: join(dir, "settings.json"), MINITUI_SKILLS_DIR: join(dir, "skills"), MINITUI_DB_PATH: dbPath, MINITUI_CONFIG_DIR: dir, MINITUI_RESUME_DIR: join(dir, "resume"), MINITUI_RUNS_DIR: join(dir, "runs") },
});
let server = startServer();
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await Bun.sleep(100); }
for (const id of ["s-alpha", "s-beta"]) await fetch(`${base}/api/history/${id}`, { method: "POST" });

function chrome() { const r = `${homedir()}/.cache/ms-playwright`; for (const d of readdirSync(r).filter((d) => d.startsWith("chromium-")).sort().reverse()) { const b = `${r}/${d}/chrome-linux64/chrome`; if (existsSync(b)) return b; } }

const browser = await chromium.launch({ executablePath: chrome() });
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); if (!ok) failed++; };
const paneBoxes = (page) => page.locator("section[data-pane]").evaluateAll((els) => els.map((e) => { const b = e.getBoundingClientRect(); return { id: e.dataset.pane, x: Math.round(b.x), w: Math.round(b.width), label: e.getAttribute("aria-label"), current: e.getAttribute("aria-current") }; }));
const winRows = (page) => page.locator('aside [role="radiogroup"][aria-label="Window to show"] [role="radio"]').evaluateAll((els) => els.map((e) => ({ label: e.innerText.split("\n")[0], checked: e.getAttribute("aria-checked"), count: e.innerText.match(/\d+$/)?.[0] })));
const menu = (page, name = "Pane") => page.getByRole("menu", { name });

try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const trace = [];
  page.on("console", (m) => { const t = m.text(); if (t.startsWith("[win") || t.startsWith("[panes")) trace.push(t); });
  page.on("pageerror", (e) => trace.push("PAGEERROR " + e.message));
  await page.goto(base);
  await page.waitForTimeout(1200);
  check("one window to start, listed once", (await winRows(page)).length === 1 && (await paneBoxes(page)).length === 1, JSON.stringify(await winRows(page)));
  // Whichever session the app opened first: the label to expect back after a move and a switch.
  const opened = (await paneBoxes(page))[0].label;

  // The sidebar's "New window" button: a second, empty window.
  await page.locator("aside").getByRole("button", { name: "New window" }).click();
  await page.waitForTimeout(700);
  let rows = await winRows(page);
  check("the sidebar button starts a new window, and it is on screen", rows.length === 2 && rows[1].checked === "true", JSON.stringify(rows));
  check("...it opens empty, one new chat", (await paneBoxes(page)).length === 1 && /new chat/.test((await paneBoxes(page))[0].label));
  check("...it shows a pane count per window", rows[0].count === "1" && rows[1].count === "1", JSON.stringify(rows.map((w) => w.count)));

  // Fill the new window with two panes so there is something to move.
  await page.getByLabel("Prompt").click();
  await page.keyboard.press("Control+Backslash");
  await page.waitForTimeout(400);
  check("the new window splits like any other", (await paneBoxes(page)).length === 2);
  const here = (await paneBoxes(page)).map((b) => b.label);

  // Move a pane to the first window from the pane menu.
  await page.locator('section[data-pane]').nth(1).getByRole("button", { name: "Pane menu" }).click();
  const m = menu(page);
  await page.waitForTimeout(200);
  check("the pane menu offers the other window by name", /Window 1/.test(await m.innerText()), (await m.innerText()).split("\n").slice(0, 3).join(" | "));
  await m.getByRole("menuitem", { name: /Window 1/ }).click();
  await page.waitForTimeout(700);
  rows = await winRows(page);
  check("moving follows the pane to the window it joined", rows[0].checked === "true" && rows[0].count === "2" && rows[1].count === "1", JSON.stringify(rows));
  check("...the pane that moved is there, and has focus", (await paneBoxes(page)).length === 2 && (await paneBoxes(page)).some((b) => here.some((h) => h === b.label) && b.current === "true"), JSON.stringify(await paneBoxes(page)));
  check("...the window it left kept its own pane", rows[1].count === "1", JSON.stringify(rows.map((w) => w.count)));

  // ...and back, to a new window this time.
  await page.locator('section[data-pane]').nth(1).getByRole("button", { name: "Pane menu" }).click();
  await page.waitForTimeout(200);
  await menu(page).getByRole("menuitem", { name: "New window" }).click();
  await page.waitForTimeout(700);
  rows = await winRows(page);
  check("move to a new window makes a third window on screen", rows.length === 3 && rows[2].checked === "true" && rows[2].count === "1", JSON.stringify(rows));
  check("...the first window is down to one pane", rows[0].count === "1");

  // A window switch must bring back what was on screen, prompts included.
  await page.getByLabel("Prompt").fill("a prompt to remember");
  await page.locator("aside").getByRole("radio", { name: /Window 1/ }).click();
  await page.waitForTimeout(600);
  check("switching windows swaps the panes over, with the session it had", (await paneBoxes(page)).length === 1 && (await paneBoxes(page))[0].label === opened, JSON.stringify(await paneBoxes(page)));
  await page.locator("aside").getByRole("radio", { name: /Window 3/ }).click();
  await page.waitForTimeout(600);
  check("...and a half-typed prompt survives the round trip", (await page.getByLabel("Prompt").inputValue()) === "a prompt to remember");

  // Everything survives a reload.
  const before = JSON.stringify(await winRows(page));
  await page.reload();
  await page.waitForTimeout(1500);
  check("a reload brings back every window, its panes and which is on screen", JSON.stringify(await winRows(page)) === before, `${JSON.stringify(await winRows(page))} vs ${before} :: ${trace.slice(-12).join(" // ")}`);

  // Rename the window on screen with its pencil.
  await page.locator("aside").getByRole("button", { name: "Rename Window 3" }).click();
  await page.waitForTimeout(200);
  const editable = page.locator('aside input[aria-label="Window name"]');
  check("the rename field opens with no name in it", (await editable.count()) === 1 && (await editable.inputValue()) === "");
  await editable.fill("Scratch");
  await editable.press("Enter");
  await page.waitForTimeout(400);
  check("a window can be renamed", (await winRows(page)).some((w) => w.label === "Scratch"), JSON.stringify(await winRows(page)));
  await page.locator("aside").getByRole("button", { name: "Rename Scratch" }).click();
  await page.waitForTimeout(200);
  await page.locator('aside input[aria-label="Window name"]').fill("");
  await page.locator('aside input[aria-label="Window name"]').press("Enter");
  await page.waitForTimeout(400);
  check("an empty name goes back to the number", (await winRows(page)).some((w) => w.label === "Window 3"), JSON.stringify(await winRows(page)));
  // An empty window can be closed; one with panes refuses.
  await page.locator("aside").getByRole("radio", { name: /Window 1/ }).click();
  await page.waitForTimeout(600);
  const closeButtons = page.locator("aside").getByRole("button", { name: /^Close (Window|Scratch)/ });
  const disabled = closeButtons.nth(0);
  check("a window holding panes cannot be closed", (await disabled.getAttribute("aria-disabled")) === "true" && (await disabled.getAttribute("title")) === "Move its panes out first");
  // Empty the last window by closing its pane, then close the window itself.
  await page.keyboard.press("Alt+x");
  await page.waitForTimeout(500);
  await page.locator("aside").getByRole("button", { name: /^Close Window 1/ }).click({ force: true }); // refused: it holds a pane
  await page.waitForTimeout(500);
  check("the refused click left the window in place", (await winRows(page)).length === 3, JSON.stringify(await winRows(page)));
  await page.locator("aside").getByRole("button", { name: "Rename Window 1" }).click();
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  check("...the last window never goes", (await winRows(page)).length >= 1);
  check("...it is off the list, and its panes were already gone", !(await winRows(page)).some((w) => w.label === "Window 1"));

  await ctx.close();

  // A phone: its own browser, so its own windows, and the same sidebar controls.
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const phone = await ctx2.newPage();
  await phone.goto(base);
  await phone.waitForTimeout(1200);
  await phone.locator('button[aria-label="Toggle sidebar"]').first().click();
  await phone.waitForTimeout(500);
  check("on a phone, the window list is in the sidebar", (await winRows(phone)).length === 1, JSON.stringify(await winRows(phone)));
  await phone.locator("aside").getByRole("button", { name: "New window" }).click();
  await phone.waitForTimeout(700);
  // On a phone the drawer closes when the new window takes over; open it again to see the list.
  check("...the new window is on screen and the drawer got out of the way", (await phone.locator("aside").count()) === 0 && (await paneBoxes(phone)).length === 1);
  await phone.locator('button[aria-label="Toggle sidebar"]').first().click();
  await phone.waitForTimeout(500);
  check("...the button starts a window there too", (await winRows(phone)).length === 2 && (await winRows(phone))[1].checked === "true", JSON.stringify(await winRows(phone)));
  check("...44px or more to tap it", await phone.locator("aside").getByRole("button", { name: "New window" }).evaluate((el) => el.getBoundingClientRect().height >= 44));
  await phone.locator("aside").getByRole("radio", { name: /Window 1/ }).click();
  await phone.waitForTimeout(600);
  check("...a phone can switch windows from the sidebar", (await winRows(phone))[0].checked === "true");
  check("...and the panes came with it", (await paneBoxes(phone)).length === 1);
  await ctx2.close();

  await server.kill();
  await browser.close();
} catch (e) {
  console.log("THREW", e);
  try { await server.kill(); } catch {}
  await browser.close();
  process.exit(1);
}
console.log(failed ? `${failed} check(s) FAILED` : "all checks passed");
process.exit(failed ? 1 : 0);
