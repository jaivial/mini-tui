// Real-browser end-to-end for the sidebar organized by folder: a real server (temp database, fake agent)
// and real WebSockets. Run after `bun run build`:  bun scripts/e2e-byfolder.mjs
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const root = join(import.meta.dir, "..", "..");
const dir = mkdtempSync(join(tmpdir(), "minitui-e2e-byfolder-"));
const dbPath = join(dir, "sessions.db");
const PORT = 6500 + Math.floor(Math.random() * 300);
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

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
mkdirSync(join(dir, "skills", "pr-body"), { recursive: true });
writeFileSync(join(dir, "skills", "pr-body", "SKILL.md"), "---\nname: pr-body\ndescription: Write a PR body\n---\nBody.\n");
mkdirSync(join(dir, "skills", "better-ui"), { recursive: true });
writeFileSync(join(dir, "skills", "better-ui", "SKILL.md"), "---\nname: better-ui\ndescription: Polish the UI\n---\nPolish.\n");

// Steps send real messages: the agent must be a stub, never a real run. This one records what it was asked
// and journals a reply, so a resumed session can be seen continuing from its saved messages.
const { makeFakeAgent } = await import(join(root, "tests/helpers/fake-agent.ts"));
const fake = makeFakeAgent(join(dir, "bin"), { holdMs: 200 });
const stub = fake.script;


// ---- folders to pick from: a local tree, and a "remote" home reached through a stand-in ssh
const localRoot = join(dir, "local-work");
for (const p of ["api/.git", "web", "docs", ".secret"]) mkdirSync(join(localRoot, p), { recursive: true });
const remoteHome = join(dir, "remote-home");
for (const p of ["srv-app/.git", "srv-data", "logs"]) mkdirSync(join(remoteHome, p), { recursive: true });
const shim = join(dir, "shim");
mkdirSync(shim, { recursive: true });
// Real remote protocol, no network: the script that would go over ssh runs through bash -s with the
// fake remote's HOME. Every call is logged, so the test can see the picker really went "remote".
writeFileSync(join(shim, "ssh"), `#!/bin/sh\necho "$@" >> ${join(dir, "ssh-calls.log")}\nlast=""; for a in "$@"; do last="$a"; done\nif [ "$last" = "-s" ]; then HOME=${remoteHome} exec bash -s; fi\nexit 1\n`);
chmodSync(join(shim, "ssh"), 0o755);
writeFileSync(join(dir, "web-hosts.json"), JSON.stringify([{ id: "h-box", label: "build-box", host: "build.example", port: 22, user: "deploy", workdir: remoteHome }]));
// History the sidebar must show: saved sessions nobody opened, older than a page.
{
  const hdb = openDb(dbPath);
  // p0 and p2 get 17 each, p1 gets 26: enough to need a second page (20 per page).
  for (let i = 0; i < 60; i++) {
    createSession(hdb, { id: `s-h-${i}`, cwd: `/work/p${i < 26 ? 1 : i % 2 === 0 ? 0 : 2}`, model: "m", task: `archived task ${i}`, title: `Archived ${i}` });
    saveTranscript(hdb, `s-h-${i}`, [{ type: "task", text: `archived task ${i}` }, { type: "assistant", text: `old answer ${i}` }], { cost: 0, apiCalls: 1, exitStatus: "Submitted" }, [{ role: "user", content: `archived task ${i}` }, { role: "assistant", content: `old answer ${i}` }]);
    hdb.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(Date.now() - (i + 5) * 3600e3, `s-h-${i}`);
  }
  // A folder that really exists on this machine, so a new chat can start in it.
  for (let i = 0; i < 3; i++) {
    createSession(hdb, { id: `s-real-${i}`, cwd: join(localRoot, "web"), model: "m", task: `real ${i}`, title: `Real ${i}` });
    hdb.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(Date.now() - (i + 100) * 3600e3, `s-real-${i}`);
  }
  hdb.close();
}
const server = spawn("bun", ["src/web/serve.ts", "--port", String(PORT)], {
  cwd: root, stdio: "ignore",
  env: { ...process.env, PATH: `${shim}:${process.env.PATH}`, MINITUI_MINI_BIN: stub, MINITUI_EMBEDDED_AGENT: "0", MINITUI_LAST_MODEL_PATH: join(dir, "last-model.json"), MINITUI_CONNECTIONS_PATH: join(dir, "providers.json"), MINITUI_SETTINGS_PATH: join(dir, "settings.json"), MINITUI_SKILLS_DIR: join(dir, "skills"), MINITUI_DB_PATH: dbPath, MINITUI_CONFIG_DIR: dir, MINITUI_RESUME_DIR: join(dir, "resume"), MINITUI_RUNS_DIR: join(dir, "runs") },
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
  const apiCalls = [];
  page.on("request", (r) => { const u = r.url().replace(base, ""); if (u.startsWith("/api/")) apiCalls.push([Date.now(), `${r.method()} ${u}`]); });
  const since = (t) => apiCalls.filter(([at]) => at >= t).map(([, k]) => k);
  await page.goto(base);
  await page.waitForTimeout(1500);
  const side = page.locator("aside").first();

  check("the sidebar offers Recent and By folder", (await side.getByRole("radio", { name: "Recent" }).getAttribute("aria-checked")) === "true" && (await side.getByRole("radio", { name: "By folder" }).count()) === 1);
  const t0 = Date.now();
  await side.getByRole("radio", { name: "By folder" }).click();
  await page.waitForTimeout(1200);
  const tree = side.getByRole("tree", { name: "Sessions by folder" });
  const folders = await tree.locator("[data-folder]").evaluateAll((els) => els.map((e) => [e.dataset.folder, e.getAttribute("aria-label"), e.getAttribute("aria-expanded")]));
  const byCwd = Object.fromEntries(folders.map(([c, l, x]) => [c, { l, x }]));
  check("every folder with sessions is listed, once", ["/work/p0", "/work/p1", "/work/p2", "/tmp"].every((c) => byCwd[c]) && new Set(folders.map((f) => f[0])).size === folders.length, JSON.stringify(folders.map((f) => f[0])));
  check("each shows how many sessions it holds (all of them, not just those loaded)", /26 sessions/.test(byCwd["/work/p1"]?.l ?? ""), byCwd["/work/p1"]?.l);
  check("a folder with open sessions starts expanded; the others start collapsed", byCwd["/tmp"]?.x === "true" && byCwd["/work/p1"]?.x === "false");
  check("the folder view costs one request for the folder list, plus one per expanded folder", since(t0).filter((k) => k.startsWith("GET /api/history/folders")).length === 1, JSON.stringify(since(t0)));
  // expand a collapsed folder: its sessions load, 20 at a time
  const p1 = tree.locator('[data-folder="/work/p1"]');
  const t1 = Date.now();
  await p1.getByRole("button", { name: /^p1/ }).click();
  await page.waitForTimeout(700);
  const shown1 = await p1.locator("[data-history]").count();
  check("expanding a folder shows its first 20 sessions, only that folder's", shown1 === 20 && (await p1.locator("[data-history]").allInnerTexts()).every((t) => /p1/.test(t)), String(shown1));
  check("...loaded with one request for that folder", since(t1).filter((k) => k.includes("cwd=%2Fwork%2Fp1")).length === 1, JSON.stringify(since(t1)));
  check("...and says how many older ones there are", /Show more \(6 older\)/.test(await p1.innerText()));
  await p1.getByRole("button", { name: /Show more/ }).click();
  await page.waitForTimeout(700);
  check("Show more loads the rest, and then goes away", (await p1.locator("[data-history]").count()) === 26 && (await p1.getByRole("button", { name: /Show more/ }).count()) === 0);
  // pin
  await p1.hover();
  await p1.getByRole("button", { name: "Pin /work/p1 to the top" }).click();
  await page.waitForTimeout(300);
  check("pinning moves a folder to the top", (await tree.locator("[data-folder]").first().getAttribute("data-folder")) === "/work/p1");
  // collapse and remember across reload
  await tree.locator('[data-folder="/tmp"]').getByRole("button", { name: /^tmp/ }).click();
  await page.reload();
  await page.waitForTimeout(1500);
  const tree2 = page.locator("aside").first().getByRole("tree", { name: "Sessions by folder" });
  check("the view, the pin and what you collapsed are remembered after a reload", (await tree2.count()) === 1 && (await tree2.locator("[data-folder]").first().getAttribute("data-folder")) === "/work/p1" && (await tree2.locator('[data-folder="/tmp"]').getAttribute("aria-expanded")) === "false");
  check("folders are labelled by name, with where they live under it", /Folder|p1/.test(await tree2.locator('[data-folder="/work/p1"]').innerText()) && (await tree2.locator('[data-folder="/work/p1"]').innerText()).includes("/work"));
  // open a saved session from a folder
  const p1b = tree2.locator('[data-folder="/work/p1"]');
  await p1b.locator("[data-history] button").first().click();
  await page.waitForTimeout(900);
  const opened = await page.locator("section[data-pane]").first().getAttribute("aria-label");
  check("clicking a session inside a folder opens it in the focused pane", /Archived/.test(opened ?? ""), opened);
  // new chat in a folder
  const realDir = join(localRoot, "web");
  await tree2.locator(`[data-folder="${realDir}"]`).hover();
  await tree2.getByRole("button", { name: `New chat in ${realDir}` }).click();
  await page.waitForTimeout(400);
  check("New chat in a folder opens a new chat already set to that folder", /Folder: .*web/.test((await page.getByRole("button", { name: /^Folder: / }).getAttribute("aria-label")) ?? "") && (await page.locator("section[data-pane]").first().innerText()).includes(realDir));
  check("...and puts the cursor in the prompt", await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Prompt"));
  // search in folder view: only matching sessions, their folders open
  await page.locator("aside").first().getByLabel("Search sessions").fill("archived task 7");
  await page.waitForTimeout(900);
  const found = await tree2.locator("[data-folder]").evaluateAll((els) => els.map((e) => [e.dataset.folder, e.getAttribute("aria-expanded"), e.querySelectorAll("[data-history]").length]));
  check("searching shows only the folders with a match, opened", found.length >= 1 && found.every(([, x, n]) => x === "true" && n >= 1), JSON.stringify(found));
  await page.locator("aside").first().getByLabel("Search sessions").fill("");
  await page.waitForTimeout(600);
  // idle: nothing polls
  const tIdle = Date.now();
  await page.waitForTimeout(5000);
  check("idle in the folder view makes no requests", since(tIdle).length === 0, JSON.stringify(since(tIdle).slice(0, 4)));
  // a session finishing moves between folders without a reload
  const tRun = Date.now();
  await page.getByLabel("Prompt").fill("fresh run in web");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2500);
  const call = fake.calls().at(-1);
  check("...and the chat really starts there", call?.cwd === realDir, call?.cwd);
  const real = tree2.locator(`[data-folder="${realDir}"]`);
  check("a new chat shows up in its folder at once, expanded, and the count goes up", (await real.getAttribute("aria-expanded")) === "true" && (await real.getByText("fresh run in web").count()) >= 1 && /4 sessions/.test((await real.getAttribute("aria-label")) ?? ""), await real.getAttribute("aria-label"));
  const runCalls = since(tRun).filter((k) => k.startsWith("GET /api/history"));
  // The new session's folder is expanded for the first time (1 request). Then start and finish are two
  // changes, each re-reading the recent list, the folder counts and only that folder: 3 requests each.
  // /work/p1, open but untouched, must not be re-read.
  check("...and the refresh it causes re-reads only that folder, not every open one", runCalls.length <= 7 && !runCalls.some((k) => k.includes("cwd=%2Fwork%2Fp1")), `${runCalls.length}: ${JSON.stringify(runCalls)}`);
  // a remote-host folder chat is saved (row) so it appears under its folder too
  await ctx.close();

  // ============================== phone
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const ph = await phone.newPage();
  await ph.goto(base);
  await ph.waitForTimeout(1200);
  await ph.getByRole("button", { name: "Toggle sidebar" }).first().tap();
  await ph.waitForTimeout(400);
  await ph.getByRole("radio", { name: "By folder" }).tap();
  await ph.waitForTimeout(900);
  const small = await ph.locator("aside").first().evaluate((root) => [...root.querySelectorAll("button, [role=radio]")].filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.height && (r.height < 43.5 || r.width < 43.5); }).map((e) => `${(e.getAttribute("aria-label") || e.textContent).trim().slice(0, 22)} ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`));
  check("on a phone every control in the folder view is at least 44px (pin and new chat visible without hover)", small.length === 0, JSON.stringify(small.slice(0, 6)));
  check("...and nothing scrolls sideways", (await ph.evaluate(() => document.documentElement.scrollWidth)) <= 390);
  await phone.close();
} finally {
  await browser.close();
  server.kill();
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `${failed} check(s) FAILED` : "all checks passed");
process.exit(failed ? 1 : 0);
