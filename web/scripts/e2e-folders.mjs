// Real-browser end-to-end for the sidebar history and the folder picker (local and remote): a real server (temp database, fake agent)
// and real WebSockets. Run after `bun run build`:  bun scripts/e2e-folders.mjs
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const root = join(import.meta.dir, "..", "..");
const dir = mkdtempSync(join(tmpdir(), "minitui-e2e-folders-"));
const dbPath = join(dir, "sessions.db");
const PORT = 6100 + Math.floor(Math.random() * 300);
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
  for (let i = 0; i < 60; i++) {
    createSession(hdb, { id: `s-h-${i}`, cwd: `/work/p${i % 3}`, model: "m", task: `archived task ${i}`, title: `Archived ${i}` });
    saveTranscript(hdb, `s-h-${i}`, [{ type: "task", text: `archived task ${i}` }, { type: "assistant", text: `old answer ${i}` }], { cost: 0, apiCalls: 1, exitStatus: "Submitted" }, [{ role: "user", content: `archived task ${i}` }, { role: "assistant", content: `old answer ${i}` }]);
    hdb.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(Date.now() - (i + 5) * 3600e3, `s-h-${i}`);
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
  page.on("request", (r) => { const u = r.url().replace(base, ""); if (u.startsWith("/api/")) apiCalls.push([Date.now(), `${r.method()} ${u.split("?")[0]}`]); });
  const callsSince = (t) => apiCalls.filter(([at]) => at >= t).map(([, k]) => k);
  await page.goto(base);
  await page.waitForTimeout(1500);
  const side = page.locator("aside").first();
  // No polling: an idle tab makes no API requests at all (it used to ask for /api/history every 200 ms).
  const idleFrom = Date.now();
  await page.waitForTimeout(5000);
  check("an idle tab makes no requests: nothing polls", callsSince(idleFrom).length === 0, JSON.stringify(callsSince(idleFrom).slice(0, 4)));
  const firstLoad = apiCalls.filter(([, k]) => k === "GET /api/history").length;
  check("the sidebar history is fetched once on load", firstLoad === 1, `${firstLoad} requests`);

  // ============================== sidebar history
  const hist = side.getByRole("group", { name: /^History, / });
  check("the sidebar lists saved chats from the database, not only open ones", (await side.locator("[data-history]").count()) >= 40 && (await side.getByText("Archived 0", { exact: true }).count()) === 1);
  check("...grouped by day", (await hist.count()) >= 2, String(await hist.count()));
  check("a session open above is not repeated in History", (await side.locator('[data-history="s-alpha"]').count()) === 0);
  const before = await side.locator("[data-history]").count();
  await side.getByRole("button", { name: "Show more" }).click();
  await page.waitForTimeout(700);
  check("Show more loads the next page", (await side.locator("[data-history]").count()) > before, `${before} -> ${await side.locator("[data-history]").count()}`);
  const typedAt = Date.now();
  await side.getByLabel("Search sessions").pressSequentially("archived task 42", { delay: 30 });
  await page.waitForTimeout(1500);
  const searches = callsSince(typedAt).filter((k) => k === "GET /api/history").length;
  check("typing a search asks the server once when you pause, not once per key or in a loop", searches === 1, `${searches} requests for 16 keys`);
  check("search looks through the whole database (the first message too)", (await side.locator("[data-history]").count()) === 1 && (await side.getByText("Archived 42", { exact: true }).count()) === 1);
  await side.locator('[data-history="s-h-42"] button').click();
  await page.waitForTimeout(900);
  check("clicking a history row opens it in the focused pane, with its transcript", ((await page.locator("section[data-pane]").first().getAttribute("aria-label")) ?? "").includes("Archived 42") && (await page.locator("main").first().innerText()).includes("old answer 42"));
  await side.getByLabel("Search sessions").fill("");
  await page.waitForTimeout(700);
  check("once open it moves up to the open sessions, out of History", (await side.locator('[data-history="s-h-42"]').count()) === 0 && (await side.getByRole("button", { name: /Archived 42/ }).count()) === 1);
  const resumeAt = Date.now();
  await side.getByRole("button", { name: "All", exact: true }).click();
  check("All opens the full Resume panel", (await page.getByRole("dialog", { name: "Resume a session" }).count()) === 1);
  await page.waitForTimeout(3000);
  const resumeCalls = callsSince(resumeAt).filter((k) => k === "GET /api/history").length;
  check("the open Resume panel loads its list once and then stays quiet", resumeCalls === 1, `${resumeCalls} requests in 3s`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const settingsAt = Date.now();
  await page.keyboard.press("Control+Comma");
  await page.waitForTimeout(3000);
  const settingsCalls = callsSince(settingsAt);
  check("an open Settings panel loads once and then stays quiet", settingsCalls.length <= 1, JSON.stringify(settingsCalls));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // ============================== folder picker, local
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await page.waitForTimeout(300);
  const trigger = page.getByRole("button", { name: /^Folder: / });
  check("a new chat has a folder button in the prompt bar", (await trigger.count()) === 1 && /Server folder/.test((await trigger.getAttribute("aria-label")) ?? ""));
  await trigger.click();
  const dlg = page.getByRole("dialog", { name: /Choose a folder on this machine/ });
  await dlg.waitFor();
  check("it opens a folder browser with focus in its path field", await dlg.getByRole("combobox").evaluate((el) => el === document.activeElement));
  await dlg.getByRole("combobox").fill(localRoot);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  const opts = await dlg.getByRole("option").allInnerTexts();
  check("typing a path + Enter goes there and lists its folders (no files, hidden ones tucked away)", JSON.stringify(opts.map((o) => o.split("\n")[0])) === JSON.stringify(["api", "docs", "web"]), JSON.stringify(opts));
  check("a git repository is marked", /git/.test(opts[0] ?? ""));
  await dlg.getByRole("button", { name: /Show 1 hidden/ }).click();
  check("hidden folders show on request", (await dlg.getByRole("option").count()) === 4);
  await dlg.getByRole("combobox").fill("ap");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  check("filter, arrow, Enter opens that folder", ((await dlg.getByRole("navigation", { name: "Current folder" }).innerText()).replace(/\s/g, "")).endsWith("/api"));
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(400);
  check("Backspace in the empty field goes up a level", !((await dlg.getByRole("navigation", { name: "Current folder" }).innerText()).replace(/\s/g, "")).endsWith("/api"));
  await dlg.getByRole("option", { name: /web/ }).click();
  await page.waitForTimeout(400);
  await dlg.getByRole("button", { name: "Use this folder" }).click();
  check("Use this folder picks it: the button now names it", /Folder: .*web/.test((await trigger.getAttribute("aria-label")) ?? ""), await trigger.getAttribute("aria-label"));
  check("...and the empty chat says where it will run", (await page.locator("section[data-pane]").first().innerText()).includes(join(localRoot, "web")));
  const callsBefore = fake.calls().length;
  await page.getByLabel("Prompt").fill("work in web");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
  const call = fake.calls().slice(callsBefore)[0];
  check("the first message starts the session in that folder", !!call && call.cwd === join(localRoot, "web"), call?.cwd);
  const created = (await (await fetch(`${base}/api/sessions`)).json()).find((s) => s.title === "work in web");
  check("...and the session records it", created?.cwd === join(localRoot, "web"));
  check("an existing chat has no folder button (it already runs somewhere)", (await page.getByRole("button", { name: /^Folder: / }).count()) === 0);
  // recent
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await page.getByRole("button", { name: /^Folder: / }).click();
  await page.waitForTimeout(500);
  const recent = page.getByRole("dialog", { name: /Choose a folder/ }).getByRole("button", { name: join(localRoot, "web"), exact: true });
  check("the folder you used shows under Recent next time", (await recent.count()) === 1);
  await recent.click();
  check("...and one click on it picks it", /Folder: .*local-work\/web/.test((await page.getByRole("button", { name: /^Folder: / }).getAttribute("aria-label")) ?? ""));
  await page.keyboard.press("Escape");
  // a bad folder is refused by the server, and the prompt stays
  const bad = await fetch(`${base}/api/sessions`, { method: "POST", body: JSON.stringify({ prompt: "x", target: "local", cwd: join(dir, "does-not-exist") }) });
  check("the server refuses a local folder that does not exist (400, with the reason)", bad.status === 400 && /not a folder on this machine/.test((await bad.json()).error));
  const nope = await fetch(`${base}/api/folders?path=${encodeURIComponent(join(dir, "nope"))}`);
  check("listing a missing folder is a 404 with words", nope.status === 404 && /does not exist/.test((await nope.json()).error));

  // ============================== folder picker, remote host
  await page.getByRole("button", { name: "build-box" }).click();
  check("switching to the remote host resets the folder to the host's", /Host folder/.test((await page.getByRole("button", { name: /^Folder: / }).getAttribute("aria-label")) ?? ""));
  await page.getByRole("button", { name: /^Folder: / }).click();
  const rdlg = page.getByRole("dialog", { name: /Choose a folder on build-box/ });
  await rdlg.waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[role=dialog] [role=option]').length > 0, null, { timeout: 8000 }).catch(() => {});
  const ropts = (await rdlg.getByRole("option").allInnerTexts()).map((o) => o.split("\n")[0]);
  const sshLog = (() => { try { return readFileSync(join(dir, "ssh-calls.log"), "utf8"); } catch { return ""; } })();
  check("on a remote host it lists the host's folders, over ssh", JSON.stringify(ropts) === JSON.stringify(["logs", "srv-app", "srv-data"]) && /deploy@build\.example/.test(sshLog), JSON.stringify(ropts));
  await rdlg.getByRole("option", { name: /srv-app/ }).click();
  await page.waitForTimeout(500);
  await rdlg.getByRole("button", { name: "Use this folder" }).click();
  check("a remote folder can be picked", /srv-app/.test((await page.getByRole("button", { name: /^Folder: / }).getAttribute("aria-label")) ?? ""));
  await page.getByRole("button", { name: "Local" }).click();
  check("switching back to this machine drops the remote folder", /Server folder/.test((await page.getByRole("button", { name: /^Folder: / }).getAttribute("aria-label")) ?? ""));
  const unknown = await fetch(`${base}/api/folders?hostId=h-nope&path=/`);
  check("an unknown host is a 404", unknown.status === 404);
  await ctx.close();

  // ============================== phone
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const ph = await phone.newPage();
  await ph.goto(base);
  await ph.waitForTimeout(1200);
  // The phone opens on the same layout as the desktop (the workspace is shared), so it starts its own
  // new chat from the sidebar, the way you would on a phone.
  await ph.getByRole("button", { name: "Toggle sidebar" }).first().tap();
  await ph.waitForTimeout(400);
  await ph.locator("aside").getByRole("button", { name: "New chat", exact: true }).tap();
  await ph.waitForTimeout(400);
  await ph.getByRole("button", { name: /^Folder: / }).tap();
  const pd = ph.getByRole("dialog", { name: /Choose a folder/ });
  await pd.waitFor();
  await ph.waitForTimeout(500);
  const pb = await pd.boundingBox();
  const small = await pd.evaluate((root) => [...root.querySelectorAll("button, [role=option], input")].filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.height && (r.height < 43.5 || (e.tagName === "BUTTON" && r.width < 43.5)); }).map((e) => `${(e.getAttribute("aria-label") || e.textContent).trim().slice(0, 16)} ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`));
  check("on a phone the picker is a sheet inside the screen", !!pb && pb.x >= 0 && pb.x + pb.width <= 390 && pb.y >= 0 && pb.y + pb.height <= 844, JSON.stringify(pb));
  check("...every control in it is at least 44px", small.length === 0, JSON.stringify(small.slice(0, 6)));
  check("...and the path field is 16px (no iOS zoom)", (await pd.getByRole("combobox").evaluate((e) => parseFloat(getComputedStyle(e).fontSize))) >= 16);
  await ph.keyboard.press("Escape").catch(() => {});
  await ph.getByRole("button", { name: "Toggle sidebar" }).first().tap();
  await ph.waitForTimeout(500);
  check("the phone's sidebar shows History too", (await ph.locator("aside [data-history]").count()) > 10);
  await phone.close();
} finally {
  await browser.close();
  server.kill();
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `${failed} check(s) FAILED` : "all checks passed");
process.exit(failed ? 1 : 0);
