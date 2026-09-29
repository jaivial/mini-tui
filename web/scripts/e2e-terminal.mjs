// Real-browser end-to-end for the interactive terminal in the side panel: a real server (temp database, fake agent)
// and real WebSockets. Run after `bun run build`:  bun scripts/e2e-terminal.mjs
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const root = join(import.meta.dir, "..", "..");
const dir = mkdtempSync(join(tmpdir(), "minitui-e2e-term-"));
const dbPath = join(dir, "sessions.db");
const PORT = 7100 + Math.floor(Math.random() * 300);
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
const workDir = join(dir, "work-alpha");
mkdirSync(workDir, { recursive: true });
for (const [id, title] of [["s-alpha", "Alpha task"], ["s-beta", "Beta task"]]) {
  createSession(db, { id, cwd: id === "s-alpha" ? workDir : "/tmp", model: "deepseek/deepseek-chat", task: title, title });
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
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // The starting layout, set once: later loads (a reload) must keep whatever the app saved since.
  await ctx.addInitScript(() => { if (!localStorage.getItem("minitui.panes")) localStorage.setItem("minitui.panes", JSON.stringify({ v: 1, tree: { kind: "pane", id: "p1" }, panes: { p1: { sessionId: "s-alpha", notesOpen: false } }, focused: "p1" })); });
  const page = await ctx.newPage();
  const requests = [];
  page.on("request", (r) => { const u = r.url().replace(base, ""); if (u.startsWith("/api/") && !u.startsWith("/api/stream")) requests.push(u); });
  const chunks = [];
  page.on("request", (r) => { if (/TerminalPanel-.*\.js$/.test(r.url())) chunks.push(r.url()); });
  await page.goto(base);
  await page.waitForTimeout(1500);
  check("the terminal code is not downloaded until a terminal is opened", chunks.length === 0);
  const screen = () => page.locator(".xterm-rows").innerText();
  const until = async (fn, ms = 6000) => { for (let i = 0; i < ms / 50; i++) { if (await fn()) return true; await page.waitForTimeout(50); } return false; };

  await page.getByRole("button", { name: "Show terminal" }).click();
  const tabs = page.getByRole("tablist", { name: "Side panel" });
  check("a Terminal tab opens beside Notes in the side panel", (await tabs.getByRole("tab", { name: "Terminal" }).getAttribute("aria-selected")) === "true" && (await tabs.getByRole("tab", { name: "Notes" }).count()) === 1);
  check("...and its code is fetched now, once", await until(async () => chunks.length === 1));
  check("a shell starts, with the cursor in it", await until(async () => /\$|#|%|>/.test(await screen())) && (await page.evaluate(() => !!document.activeElement?.closest(".xterm"))));
  await page.keyboard.type("echo TERM-$((6*7)); pwd; tty");
  await page.keyboard.press("Enter");
  check("typing runs commands in a real terminal", await until(async () => (await screen()).includes("TERM-42")) && /\/dev\/pts\/\d+/.test(await screen()));
  check("it starts in the session's folder", (await screen()).includes(workDir), (await screen()).split("\n").find((l) => l.includes("/")));
  check("the header says where it runs", (await page.locator("[data-terminal]").locator("xpath=../..").innerText()).includes(workDir));
  // a full-screen program and Ctrl+C
  await page.keyboard.type("sleep 30");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  await page.keyboard.press("Control+c");
  await page.keyboard.type("echo AFTER-CTRL-C");
  await page.keyboard.press("Enter");
  check("Ctrl+C interrupts a running command (it goes to the shell, not the page)", await until(async () => (await screen()).includes("AFTER-CTRL-C")));
  // the terminal follows its size
  await page.keyboard.type("stty size");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  const size1 = (await screen()).match(/(\d+) (\d+)\s*$/m);
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.waitForTimeout(600);
  await page.keyboard.type("clear; stty size");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  const size2 = (await screen()).match(/(\d+) (\d+)/);
  check("resizing the window resizes the terminal (the shell sees the new size)", !!size1 && !!size2 && (Number(size2[1]) > Number(size1[1]) || Number(size2[2]) > Number(size1[2])), `${size1?.[0]} -> ${size2?.[0]}`);
  // switch to notes and back: same shell
  await page.keyboard.type("export KEEP=kept");
  await page.keyboard.press("Enter");
  await tabs.getByRole("tab", { name: "Notes" }).click();
  await page.waitForTimeout(400);
  check("Notes and Terminal share one panel: switching shows the notes", (await page.getByRole("complementary", { name: "Notes" }).count()) === 1 && (await page.locator(".xterm").count()) === 0);
  await tabs.getByRole("tab", { name: "Terminal" }).click();
  check("coming back to the terminal finds the same shell", await until(async () => /\$|#|%/.test(await screen())));
  await page.locator(".xterm").click();
  await page.keyboard.type("echo KEEP=$KEEP");
  await page.keyboard.press("Enter");
  check("...with its state (the variable set before is still there)", await until(async () => (await screen()).includes("KEEP=kept")));
  // reload: the shell survives and its output is replayed
  await page.reload();
  await page.waitForTimeout(1500);
  check("after a reload the terminal is still open and replays the shell's output", await until(async () => (await page.locator(".xterm").count()) === 1 && (await screen()).includes("KEEP=kept")));
  await page.locator(".xterm").click();
  await page.keyboard.type("echo STILL=$KEEP");
  await page.keyboard.press("Enter");
  check("...and it is the same shell", await until(async () => (await screen()).includes("STILL=kept")));
  // shortcuts: Ctrl+` hides and shows; in the terminal Ctrl+K goes to the shell
  await page.keyboard.type("echo abc");
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+k");
  await page.keyboard.type("echo KILLED-LINE-OK");
  await page.keyboard.press("Enter");
  check("readline keys reach the shell (Ctrl+K kills the line, the app's new-chat shortcut does not fire)", await until(async () => (await screen()).includes("KILLED-LINE-OK")) && !(await screen()).includes("abcecho") && /Alpha task/.test((await page.locator("section[data-pane]").first().getAttribute("aria-label")) ?? ""));
  await page.keyboard.press("Control+Backquote");
  await page.waitForTimeout(300);
  check("Ctrl+` hides the terminal, even while typing in it", (await page.locator(".xterm").count()) === 0);
  await page.keyboard.press("Control+Backquote");
  check("...and shows it again", await until(async () => (await page.locator(".xterm").count()) === 1));
  // exit and restart
  await page.locator(".xterm").click();
  await page.keyboard.type("exit");
  await page.keyboard.press("Enter");
  check("exiting the shell says so", await until(async () => (await screen()).includes("process exited")));
  await page.getByRole("button", { name: "Restart the terminal" }).click();
  await page.waitForTimeout(800);
  await page.locator(".xterm").click();
  await page.keyboard.type("echo FRESH=[$KEEP]");
  await page.keyboard.press("Enter");
  check("Restart gives a fresh shell", await until(async () => (await screen()).includes("FRESH=[]")));
  // no REST for terminals: everything on the hub
  check("the terminal never used a REST endpoint (only the hub socket)", !requests.some((u) => /term/i.test(u)), JSON.stringify(requests.filter((u) => /term/i.test(u))));
  const hubClients = (await (await fetch(`${base}/api/health`)).json()).hubClients;
  check("notes and terminal share the tab's one hub socket", hubClients === 1, `${hubClients} hub clients`);
  // /terminal command
  await page.getByRole("button", { name: "Hide the terminal panel" }).click();
  await page.getByLabel("Prompt").fill("/termi");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  check("/terminal opens it from the prompt bar", await until(async () => (await page.locator(".xterm").count()) === 1));
  await ctx.close();

  // ============================== phone
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  await phone.addInitScript(() => localStorage.setItem("minitui.panes", JSON.stringify({ v: 1, tree: { kind: "pane", id: "p1" }, panes: { p1: { sessionId: "s-alpha", notesOpen: true, sideTab: "terminal" } }, focused: "p1" })));
  const ph = await phone.newPage();
  await ph.goto(base);
  await ph.waitForTimeout(2000);
  const box = await ph.locator(".xterm").boundingBox();
  check("on a phone the terminal covers the pane, full width, inside the screen", !!box && box.width > 330 && box.x >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844, JSON.stringify(box));
  const small = await ph.evaluate(() => [...document.querySelectorAll('[role=tablist][aria-label="Side panel"] button, [data-terminal] ~ *, button[aria-label*="terminal" i]')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && (r.width < 43.5 || r.height < 43.5); }).map((e) => `${e.getAttribute("aria-label") || e.textContent.trim()} ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`));
  check("...its tabs and buttons are at least 44px", small.length === 0, JSON.stringify(small));
  check("...and nothing scrolls sideways", (await ph.evaluate(() => document.documentElement.scrollWidth)) <= 390);
  await phone.close();
} finally {
  await browser.close();
  server.kill();
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `${failed} check(s) FAILED` : "all checks passed");
process.exit(failed ? 1 : 0);
