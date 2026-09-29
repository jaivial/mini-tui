// Real-browser end-to-end: a real server (temp database, no agent spawned) and real WebSockets.
// Run after `bun run build`:  bun scripts/e2e.mjs
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const root = join(import.meta.dir, "..", "..");
const dir = mkdtempSync(join(tmpdir(), "minitui-e2e-"));
const dbPath = join(dir, "sessions.db");
const PORT = 4700 + Math.floor(Math.random() * 200);
const { createSession, openDb, saveTranscript } = await import(join(root, "src/sessions.ts"));
const db = openDb(dbPath);
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

// The last step sends a real message: the agent must be a stub that exits at once, never a real run.
import { chmodSync } from "node:fs";
const stub = join(dir, "mini-stub");
writeFileSync(stub, "#!/bin/sh\nexit 0\n");
chmodSync(stub, 0o755);

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

try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const sockets = [];
  page.on("websocket", (ws) => { const rec = { url: ws.url(), frames: [], closed: false }; sockets.push(rec); ws.on("framereceived", (f) => rec.frames.push(JSON.parse(String(f.payload)))); ws.on("close", () => (rec.closed = true)); });
  // Route every session socket through a proxy we control, so the test can cut one mid-stream.
  const proxied = [];
  await page.routeWebSocket(/\/api\/sessions\/[^/]+\/socket/, (ws) => {
    const upstream = ws.connectToServer();
    proxied.push({ ws, url: ws.url() });
    ws.onMessage((m) => upstream.send(m));
    upstream.onMessage((m) => ws.send(m));
  });
  await page.goto(base);
  await page.waitForTimeout(1200);

  // --- one socket per session, each to its own URL
  const urls = sockets.map((s) => s.url.replace(/^ws:\/\/[^/]+/, ""));
  check("only the active session has a socket (idle ones do not)", sockets.length === 1, JSON.stringify(urls));
  const activeId = urls[0]?.match(/sessions\/([^/]+)\/socket/)?.[1];
  check("its URL names the active session", !!activeId && ["s-alpha", "s-beta"].includes(activeId), activeId);
  check("it delivered a snapshot with that session's transcript", sockets[0]?.frames[0]?.t === "snapshot" && JSON.stringify(sockets[0].frames[0]).includes(`hello from ${activeId}`));

  // --- switching opens the other session's own socket, closes the first
  const other = activeId === "s-alpha" ? "s-beta" : "s-alpha";
  await page.getByRole("button", { name: new RegExp(other === "s-alpha" ? "Alpha task" : "Beta task") }).first().click();
  await page.waitForTimeout(800);
  const second = sockets.find((s) => s.url.includes(other));
  check("switching opens a second socket for the other session", !!second, sockets.map((s) => s.url.split("/").slice(-2, -1)[0]).join(","));
  check("...and its frames are only that session's", !!second && !JSON.stringify(second.frames).includes(`hello from ${activeId}`));
  check("...and the previous idle session's socket was closed", sockets.find((s) => s.url.includes(activeId))?.closed === true);
  await page.waitForFunction(() => document.body.innerText.includes("hello from"));
  check("the transcript on screen is the selected session's", (await page.locator("main").innerText()).includes(`hello from ${other}`));

  // --- a change on the server reaches only the watched session's view
  await fetch(`${base}/api/sessions/${other}/model`, { method: "POST", body: JSON.stringify({ model: "xiaomi/mimo-v2.6-pro" }) });
  // Wait on the transcript itself: the prompt bar's model label also says "mimo" and updates from
  // the metadata stream slightly before this session's socket delivers the transcript delta.
  await page.waitForFunction(() => document.querySelector("main")?.innerText.includes("mimo-v2.6-pro"), null, { timeout: 4000 }).catch(() => {});
  const mainText = await page.locator("main").innerText();
  check("a server-side change streams into the open transcript", mainText.includes("mimo-v2.6-pro"), JSON.stringify(mainText.slice(-120)));

  // --- prompt bar
  const bar = page.locator("textarea[aria-label=Prompt]");
  check("prompt bar has a labelled textarea + described hint", (await bar.getAttribute("aria-describedby")) !== null && (await page.locator("#" + (await bar.getAttribute("aria-describedby"))).innerText()).includes("Enter sends"));
  check("send is disabled while empty", await page.getByRole("button", { name: "Send message" }).isDisabled());
  const unnamed = await page.evaluate(() => [...document.querySelectorAll("button")].filter((b) => !(b.getAttribute("aria-label") || b.textContent || b.title || "").trim()).length);
  check("every button has an accessible name", unnamed === 0, `${unnamed} unnamed`);

  // --- model picker: keyboard only
  const trigger = page.getByRole("button", { name: /^Model:/ });
  check("model trigger names the current model", /mimo-v2\.6-pro/.test((await trigger.getAttribute("aria-label")) ?? ""), await trigger.getAttribute("aria-label"));
  await trigger.focus();
  await page.keyboard.press("Enter");
  const combo = page.getByRole("dialog", { name: "Choose a model" }).getByRole("combobox");
  await combo.waitFor();
  check("opening moves focus into the search field", await combo.evaluate((el) => el === document.activeElement));
  await page.getByRole("option").first().waitFor(); // the catalogue is fetched on first open
  check("the list is grouped by provider", (await page.locator("[role=group][aria-label]:not([aria-label=\"Run target\"])").count()) >= 2);
  check("the current model is marked selected", (await page.locator("[role=option][aria-selected=true]").count()) === 1);
  await page.keyboard.type("flash");
  const n = await page.getByRole("option").count();
  check("typing filters the options", n >= 1 && n < 11, `${n} left`);
  await page.keyboard.press("ArrowDown");
  const activeDesc = await combo.getAttribute("aria-activedescendant");
  check("aria-activedescendant follows the highlight", !!activeDesc && (await page.locator("#" + activeDesc).count()) === 1, activeDesc);
  const posts = [];
  page.on("request", (r) => { if (r.url().includes("/model") && r.method() === "POST") posts.push(r.postData()); });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  check("Enter picks a model and POSTs the switch", posts.length === 1 && /flash/.test(posts[0] ?? ""), posts[0]);
  check("focus returns to the trigger", await trigger.evaluate((el) => el === document.activeElement));
  check("the panel closed", (await page.getByRole("dialog", { name: "Choose a model" }).getByRole("combobox").count()) === 0);
  await page.waitForTimeout(400);
  check("the switch shows up in the transcript over the socket", /model → .*flash/.test(await page.locator("main").innerText()));

  await trigger.click();
  await page.getByRole("dialog", { name: "Choose a model" }).getByRole("combobox").fill("acme/brand-new-1");
  check("a typed id not in the catalogue is offered", (await page.getByRole("option", { name: /acme\/brand-new-1/ }).count()) === 1);
  await page.keyboard.press("Escape");
  check("Escape closes and returns focus", (await page.getByRole("dialog", { name: "Choose a model" }).getByRole("combobox").count()) === 0 && (await trigger.evaluate((el) => el === document.activeElement)));

  // --- reconnect: sever the live socket, it must come back and resume from a fresh snapshot
  const liveBefore = proxied.length;
  const target = proxied.at(-1);
  await fetch(`${base}/api/sessions/${other}/model`, { method: "POST", body: JSON.stringify({ model: "deepseek/deepseek-chat" }) });
  await page.waitForTimeout(300);
  await target.ws.close({ code: 1006, reason: "test: connection lost" });
  await page.waitForFunction((n) => true, liveBefore);
  // A change made while the socket is down must not be lost.
  await fetch(`${base}/api/sessions/${other}/model`, { method: "POST", body: JSON.stringify({ model: "openai/gpt-6-astra" }) });
  let reconnected = false;
  for (let i = 0; i < 40 && !reconnected; i++) { await page.waitForTimeout(100); reconnected = proxied.length > liveBefore; }
  check("a severed session socket reconnects by itself", reconnected, `connections ${liveBefore}→${proxied.length}`);
  await page.waitForFunction(() => document.querySelector("main")?.innerText.includes("gpt-6-astra"), null, { timeout: 4000 }).catch(() => {});
  check("...and the change made while it was down still arrives (snapshot on reconnect)", (await page.locator("main").innerText()).includes("gpt-6-astra"));
  check("...and the 'reconnecting' banner clears", (await page.locator("[role=status]", { hasText: /Connection lost/ }).count()) === 0);

  // --- closing the open session tells the browser
  await fetch(`${base}/api/sessions/${other}`, { method: "DELETE" });
  await page.waitForTimeout(800);
  check("deleting a session server-side removes it from the sidebar", (await page.getByRole("button", { name: new RegExp(other === "s-alpha" ? "Alpha task" : "Beta task") }).count()) === 0);
  const remaining = await page.evaluate(() => document.querySelectorAll('[role="listitem"]').length);
  check("the other session is untouched", remaining === 1, `${remaining} left`);

  // === New chat: a draft, nothing on the server until the first message
  const sessionsBefore = (await (await fetch(`${base}/api/sessions`)).json()).length;
  await page.getByRole("button", { name: "New chat" }).click();
  await page.waitForTimeout(300);
  check("New chat shows an empty chat, not a modal", (await page.getByRole("heading", { name: "New chat" }).count()) === 1 && (await page.locator("dialog[open]").count()) === 0);
  check("...with no session selected and its transcript gone", (await page.getByText("What should we work on?").count()) === 1);
  check("...and nothing was created on the server", (await (await fetch(`${base}/api/sessions`)).json()).length === sessionsBefore);
  check("...the prompt bar is focused, ready to type", await page.getByLabel("Prompt").evaluate((el) => el === document.activeElement));
  const socketsOnDraft = await page.evaluate(() => performance.getEntriesByType("resource").length >= 0);
  check("...and no local/remote switch is shown when there are no remote hosts", (await page.getByRole("group", { name: "Run on" }).count()) === 0);

  // === The prompt bar is one line when empty, grows a line at a time, caps at five, then scrolls
  const grow = page.getByLabel("Prompt");
  const hOf = () => grow.evaluate((el) => +el.getBoundingClientRect().height.toFixed(1));
  const lineOf = () => grow.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
  await grow.fill("");
  await page.waitForTimeout(350);
  const oneLine = await hOf();
  check("an empty prompt bar is one line tall", oneLine === 44 && Math.abs(oneLine - (await lineOf())) < 20, `${oneLine}px`);
  await grow.click();
  const heights = [];
  for (let i = 1; i <= 7; i++) { await page.keyboard.type(`row ${i}`); if (i < 7) await page.keyboard.press("Shift+Enter"); await page.waitForTimeout(320); heights.push(await hOf()); }
  const steps = heights.slice(1).map((v, i) => +(v - heights[i]).toFixed(1));
  check("it grows one whole line per new line (26px steps) until the cap", steps.slice(0, 3).every((d) => d === 26) && steps.slice(3).every((d) => d === 0), heights.join(">"));
  check("it stops at five lines", Math.max(...heights) === 148 && heights.at(-1) === 148, `${heights.at(-1)}px`);
  check("past five lines it scrolls, with the newest line in view", await grow.evaluate((el) => getComputedStyle(el).overflowY === "auto" && el.scrollTop >= el.scrollHeight - el.clientHeight - 2));
  await grow.fill("");
  await page.waitForTimeout(350);
  check("clearing it returns to one line", (await hOf()) === 44);
  // growth is animated, not a jump: sample frames across a paste
  await grow.evaluate((el) => { window.__g = []; const tick = () => { window.__g.push(el.getBoundingClientRect().height); requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
  await grow.fill(Array.from({ length: 6 }, (_, i) => `p${i}`).join("\n"));
  await page.waitForTimeout(450);
  const frames = await grow.evaluate(() => window.__g);
  const jumps = frames.slice(1).map((v, i) => Math.abs(v - frames[i]));
  check("a paste eases up over several frames instead of jumping", Math.max(...jumps) < 104 * 0.7 && new Set(frames.map((f) => Math.round(f))).size >= 4, `${new Set(frames.map((f) => Math.round(f))).size} distinct heights, max step ${Math.max(...jumps).toFixed(1)}px`);
  await grow.fill("");
  await page.waitForTimeout(350);

  // === Slash commands
  const bar2 = page.getByLabel("Prompt");
  await bar2.fill("/");
  const menu = page.getByRole("listbox", { name: "Commands" });
  await menu.waitFor();
  check("typing / opens the command list", (await menu.getByRole("option").count()) >= 6);
  check("the textarea points at the highlighted command (aria-activedescendant)", !!(await bar2.getAttribute("aria-activedescendant")) && (await bar2.getAttribute("aria-expanded")) === "true");
  await bar2.fill("/mo");
  check("it narrows as you type", (await menu.getByRole("option").count()) === 1);
  await page.keyboard.press("Escape");
  check("Escape closes the list without clearing the text", (await menu.count()) === 0 && (await bar2.inputValue()) === "/mo");
  await bar2.fill("/mo");
  await page.keyboard.press("Enter");
  const rail = page.getByRole("list", { name: "Added to this message" });
  check("Enter turns the command into a chip instead of sending it", (await rail.getByRole("group", { name: "Command model" }).count()) === 1 && (await bar2.inputValue()) === "" && (await fetch(`${base}/api/sessions`).then((r) => r.json())).length === sessionsBefore);
  check("...announced to assistive tech", /Command model added/.test(await page.locator("[role=status][aria-live=polite]").first().innerText()));
  check("...and the prompt bar asks for an argument", /argument/.test((await bar2.getAttribute("placeholder")) ?? ""));
  await page.getByRole("button", { name: "Remove Command model" }).click();
  check("the chip's remove button removes it", (await rail.count()) === 0 && await bar2.evaluate((el) => el === document.activeElement));
  await bar2.fill("/mo");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Backspace");
  check("Backspace at the start of an empty bar removes the last chip", (await rail.count()) === 0);

  // /model with no argument opens the picker, and the draft keeps the choice
  await bar2.fill("/mo");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  const picker = page.getByRole("dialog", { name: "Choose a model" });
  await picker.waitFor();
  check("/model opens the model picker", (await picker.count()) === 1);
  await picker.getByRole("combobox").fill("deepseek-chat");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  check("picking a model in a draft is remembered for the first message", /deepseek-chat/.test((await page.getByRole("button", { name: /^Model:/ }).getAttribute("aria-label")) ?? ""));
  check("...and the chip and text were cleared after running the command", (await bar2.inputValue()) === "" && (await rail.count()) === 0);

  // an unknown command is reported, and the text is kept
  await bar2.fill("/modle");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  check("an unknown /command is reported and kept, not sent to the agent", (await page.getByText("Unknown command /modle").count()) >= 1 && (await bar2.inputValue()) === "/modle" && (await (await fetch(`${base}/api/sessions`)).json()).length === sessionsBefore);
  // a path is not a command
  await bar2.fill("/etc/hosts");
  check("a path is not treated as a command", (await page.getByRole("listbox", { name: "Commands" }).count()) === 0);

  // === $ skills
  await bar2.fill("please use $pr");
  const skills = page.getByRole("listbox", { name: "Skills" });
  await skills.waitFor();
  const skillNames = await skills.getByRole("option").allInnerTexts();
  check("$ opens the skills from the configured folder, best match first", skillNames.length === 1 && /pr-body/.test(skillNames[0]), skillNames.join("|"));
  await page.keyboard.press("Tab");
  const afterTab = await bar2.inputValue();
  check("Tab lifts the skill into a chip and keeps the surrounding text", (await rail.getByRole("group", { name: "Skill pr-body" }).count()) === 1 && afterTab.trim() === "please use", JSON.stringify(afterTab));
  await bar2.fill("please use $bet");
  await page.keyboard.press("Tab");
  check("a second skill joins the first", (await rail.getByRole("group").count()) === 2);
  await bar2.fill("again $pr");
  await page.keyboard.press("Tab");
  check("the same skill twice is refused, not duplicated", (await rail.getByRole("group").count()) === 2 && /already in the message/.test(await page.locator("[role=status][aria-live=polite]").first().innerText()));
  await page.getByRole("button", { name: "Remove Skill better-ui" }).click();
  await page.getByRole("button", { name: "Remove Skill pr-body" }).click();
  await bar2.fill("it costs $5");
  check("money is not a skill", (await page.getByRole("listbox", { name: "Skills" }).count()) === 0);
  await bar2.fill("");

  // === Settings panel
  await page.getByRole("button", { name: "Settings" }).first().click();
  const dlg = page.getByRole("dialog", { name: "Settings" });
  await dlg.waitFor();
  check("Settings opens as a dialog with three tabs", (await dlg.getByRole("tab").count()) === 3);
  check("the current tab is selected", (await dlg.getByRole("tab", { selected: true }).innerText()) === "General");
  await dlg.getByRole("tab", { name: "General" }).focus();
  await page.keyboard.press("ArrowRight");
  check("arrow keys move between tabs and select (roving tabindex)", (await dlg.getByRole("tab", { selected: true }).innerText()) === "Providers" && (await dlg.getByRole("tab", { name: "General" }).getAttribute("tabindex")) === "-1");
  await page.waitForFunction(() => document.body.innerText.includes("Add a provider"));
  await dlg.getByRole("button", { name: /^Connect / }).first().waitFor();
  const connectable = await dlg.getByRole("button", { name: /^Connect / }).count();
  check("Providers lists what can be connected", connectable >= 8, `${connectable} buttons`);
  check("...and shows no keys anywhere", !(await dlg.innerText()).match(/sk-[A-Za-z0-9]{6}/));
  // a bad key is rejected without crashing and without saving
  await dlg.getByRole("button", { name: "Connect DeepSeek" }).click();
  const keyField = dlg.getByLabel("API key");
  await keyField.waitFor();
  check("the key field is masked and not autofilled", (await keyField.getAttribute("type")) === "password" && (await keyField.getAttribute("autocomplete")) === "off");
  await keyField.fill("not a key");
  await dlg.getByRole("button", { name: /^Connect$/ }).click();
  await page.waitForTimeout(400);
  check("a malformed key is refused with an announced error", (await dlg.getByRole("alert").count()) === 1);
  check("...and nothing was saved", (await (await fetch(`${base}/api/providers`)).json()).connected.length === 0);
  await dlg.getByRole("button", { name: "Show key" }).click();
  check("the key can be revealed on request", (await keyField.getAttribute("type")) === "text");
  await dlg.getByRole("button", { name: "Cancel" }).click();
  check("cancelling discards the form", (await dlg.getByLabel("API key").count()) === 0);
  // output mode persists through the API
  await dlg.getByRole("tab", { name: "General" }).click();
  await dlg.getByRole("radio", { name: /expanded/ }).check({ force: true });
  await page.waitForTimeout(500);
  check("changing an option saves it on the server", (await (await fetch(`${base}/api/settings`)).json()).outputMode === "expanded");
  await dlg.getByRole("tab", { name: "Skills" }).click();
  await page.waitForFunction(() => document.body.innerText.includes("$better-ui"));
  check("Skills tab lists the installed skills", (await dlg.getByText("$pr-body").count()) === 1 && (await dlg.getByText("$better-ui").count()) === 1);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check("Escape closes settings", (await page.locator("dialog[open]").count()) === 0);
  check("/settings and /connect open the right tab", await (async () => {
    await bar2.fill("/connect");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Enter");
    const tab = await page.getByRole("dialog", { name: "Settings" }).getByRole("tab", { selected: true }).innerText();
    await page.keyboard.press("Escape");
    return tab === "Providers";
  })());
  await page.waitForTimeout(300);

  // === First message creates the session
  await bar2.fill("");
  await bar2.fill("write the description");
  await bar2.fill("write the description $pr");
  await page.keyboard.press("Tab");
  await bar2.fill("write the description");
  const created = [];
  page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname === "/api/sessions") created.push(r.postData()); });
  await page.getByRole("button", { name: "Send message" }).click();
  await page.waitForTimeout(1500);
  check("sending the first message creates exactly one session", created.length === 1, created.join());
  const body = JSON.parse(created[0] ?? "{}");
  check("...on the model picked in the draft", /deepseek-chat/.test(body.model ?? ""), body.model);
  check("...on this machine", body.target === "local" && !body.hostId);
  check("...with the skill chip joined ahead of the typed text", body.prompt === "$pr-body write the description", JSON.stringify(body.prompt));
  check("...and the chips are cleared once it is sent", (await page.getByRole("list", { name: "Added to this message" }).count()) === 0);
  await ctx.close();
} finally {
  await browser.close();
  server.kill();
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
