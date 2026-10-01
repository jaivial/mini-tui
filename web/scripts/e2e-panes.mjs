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
const paneBoxes = (page) => page.locator("section[data-pane]").evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { id: e.dataset.pane, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), label: e.getAttribute("aria-label"), current: e.getAttribute("aria-current") }; }));
// "Another device": a hub client of its own, the only way notes are read or written now.
const hubPeer = async () => {
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/hub`);
  const got = [];
  ws.onmessage = (ev) => got.push(JSON.parse(String(ev.data)));
  await new Promise((r) => (ws.onopen = r));
  let req = 0;
  const wait = async (pred, ms = 4000) => { for (let t = 0; t < ms / 25; t++) { const i = got.findIndex(pred); if (i >= 0) return got.splice(i, 1)[0]; await Bun.sleep(25); } throw new Error("hub peer: no answer"); };
  return {
    async read(id) { ws.send(JSON.stringify({ t: "note.watch", id })); const m = await wait((m) => m.t === "note" && m.note.id === id); ws.send(JSON.stringify({ t: "note.unwatch", id })); return m.note; },
    async write(id, body, base) { const r = ++req; ws.send(JSON.stringify({ t: "note.save", id, body, base, req: r })); return await wait((m) => (m.t === "note.saved" || m.t === "note.conflict") && m.req === r); },
    close: () => ws.close(),
  };
};
let peer = await hubPeer();
const noteOf = (id) => peer.read(id);

try {
  // ============================== desktop: split, stream, resize, close
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const sockets = [];
  page.on("websocket", (ws) => { const rec = { url: ws.url(), closed: false }; sockets.push(rec); ws.on("close", () => (rec.closed = true)); });
  const noteRequests = [];
  page.on("request", (r) => { if (/\/api\/notes/.test(r.url())) noteRequests.push(`${r.method()} ${r.url()}`); });
  await page.goto(base);
  await page.waitForTimeout(1200);
  check("one pane to start", (await paneBoxes(page)).length === 1);
  const firstTitle = await page.getByRole("heading", { level: 1 }).first().innerText();

  // split right with the keyboard
  await page.getByLabel("Prompt").click();
  await page.keyboard.press("Control+Backslash");
  await page.waitForTimeout(500);
  let boxes = await paneBoxes(page);
  check("Ctrl+\\ splits right: two panes side by side, the new one on the right", boxes.length === 2 && boxes[0].x < boxes[1].x && boxes[0].y === boxes[1].y, JSON.stringify(boxes.map((b) => [b.x, b.w])));
  check("...the halves are even", Math.abs(boxes[0].w - boxes[1].w) <= 2);
  check("...the new pane is a new chat, and has focus (and the prompt)", /new chat/.test(boxes[1].label) && boxes[1].current === "true" && (await page.evaluate(() => document.activeElement?.closest("section[data-pane]")?.getAttribute("data-pane"))) === boxes[1].id);
  check("...the first pane still shows its session", boxes[0].label.includes(firstTitle));
  check("only the first pane has the sidebar toggle", (await page.locator(`section[data-pane="${boxes[1].id}"]`).getByRole("button", { name: "Toggle sidebar" }).count()) === 0);

  // open the other seeded session in the new pane from the sidebar
  const otherTitle = firstTitle.includes("Alpha") ? "Beta task" : "Alpha task";
  await page.locator("aside").getByRole("button", { name: new RegExp(otherTitle) }).first().click();
  await page.waitForTimeout(900);
  boxes = await paneBoxes(page);
  check("a sidebar click opens that session in the focused pane", boxes[1].label.includes(otherTitle) && boxes[0].label.includes(firstTitle));
  const open = sockets.filter((s) => !s.closed).map((s) => s.url.match(/sessions\/([^/]+)\/socket/)?.[1]);
  check("each pane streams over its own socket, both open at once", open.includes("s-alpha") && open.includes("s-beta") && new Set(open).size === open.length, JSON.stringify(open));
  check("the sidebar numbers the sessions by pane", (await page.locator("aside").getByText("in pane 1").count()) === 1 && (await page.locator("aside").getByText("in pane 2").count()) === 1);

  // a session shown in one pane is focused, not duplicated, when picked for another
  await page.locator(`section[data-pane="${boxes[1].id}"]`).click({ position: { x: 200, y: 200 } });
  await page.locator("aside").getByRole("button", { name: new RegExp(firstTitle) }).first().click();
  await page.waitForTimeout(400);
  boxes = await paneBoxes(page);
  check("picking a session already in another pane focuses that pane instead of showing it twice", boxes[0].current === "true" && boxes[1].label.includes(otherTitle));

  // a new session per pane, running at once: make both panes new chats, then send in each
  const pane = (i) => page.locator(`section[data-pane="${boxes[i].id}"]`);
  await pane(0).getByRole("button", { name: "New chat here" }).click();
  await pane(1).getByRole("button", { name: "New chat here" }).click();
  check("New chat here turns just that pane into a new chat", /new chat/.test((await paneBoxes(page))[0].label) && /new chat/.test((await paneBoxes(page))[1].label));
  const callsBefore = fake.calls().length;
  await pane(0).getByLabel("Prompt").fill("first pane question");
  await pane(0).getByRole("button", { name: "Send message" }).click();
  await pane(1).getByLabel("Prompt").fill("second pane question");
  await pane(1).getByRole("button", { name: "Send message" }).click();
  await page.waitForFunction(() => { const t = [...document.querySelectorAll("section[data-pane]")].map((s) => s.innerText); return t[0]?.includes("fake reply to: first pane question") && t[1]?.includes("fake reply to: second pane question"); }, null, { timeout: 10000 }).catch(() => {});
  const t0 = await pane(0).innerText(), t1 = await pane(1).innerText();
  check("both panes run and stream at the same time, each its own reply", t0.includes("fake reply to: first pane question") && t1.includes("fake reply to: second pane question"));
  check("...and neither pane shows the other's conversation", !t0.includes("second pane question") && !t1.includes("first pane question"));
  const created = fake.calls().slice(callsBefore);
  check("each pane's first message created its own session (two agents, two tasks)", created.length === 2 && new Set(created.map((c) => c.task)).size === 2, JSON.stringify(created.map((c) => c.task)));
  boxes = await paneBoxes(page);
  check("...and each pane now shows its new session", boxes[0].label.includes("first pane question") && boxes[1].label.includes("second pane question"), JSON.stringify(boxes.map((b) => b.label)));

  // resize: drag the divider, then keyboard
  const sep = page.getByRole("separator").first();
  const sb = await sep.boundingBox();
  await page.mouse.move(sb.x + sb.width / 2, sb.y + 300);
  await page.mouse.down();
  await page.mouse.move(sb.x - 250, sb.y + 300, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  boxes = await paneBoxes(page);
  check("dragging the divider resizes the panes", boxes[0].w < boxes[1].w - 300, JSON.stringify(boxes.map((b) => b.w)));
  await sep.focus();
  const before = Number(await sep.getAttribute("aria-valuenow"));
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  check("arrow keys on the focused divider move it 5% a step", Number(await sep.getAttribute("aria-valuenow")) === before + 10, `${before} -> ${await sep.getAttribute("aria-valuenow")}`);
  await page.keyboard.press("Home");
  check("Home goes to the limit, and no further than 15%", (await sep.getAttribute("aria-valuenow")) === "15");
  await page.keyboard.press("Enter");
  boxes = await paneBoxes(page);
  check("Enter evens it out again", (await sep.getAttribute("aria-valuenow")) === "50" && Math.abs(boxes[0].w - boxes[1].w) <= 2);
  check("the divider has a name and a value for screen readers", /Resize pane 1/.test((await sep.getAttribute("aria-label")) ?? "") && /50% for pane 1/.test((await sep.getAttribute("aria-valuetext")) ?? ""));

  // split down from the menu
  await pane(1).getByRole("button", { name: "Pane menu" }).click();
  const menu = page.getByRole("menu", { name: "Pane" });
  // A 596px pane is too narrow to halve sideways (two 298px chats), so Split right is disabled and
  // says why, and focus starts on the first item that can run.
  check("an action that cannot run stays in the menu and says why", /Too narrow to split/.test(await menu.getByRole("menuitem", { name: /Split right/ }).innerText()) && (await menu.getByRole("menuitem", { name: /Split right/ }).getAttribute("aria-disabled")) === "true");
  check("the menu opens with focus on the first item that can run", await menu.getByRole("menuitem", { name: /Split down/ }).evaluate((el) => el === document.activeElement));
  await page.keyboard.press("ArrowDown");
  // The menu now also moves the pane to another window; from one window only, "New window" is next.
  check("arrow keys move through the menu, past the move items", await menu.getByRole("menuitem", { name: /New window/ }).evaluate((el) => el === document.activeElement));
  check("the move group is labelled", /move to/i.test(await menu.innerText()));
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  boxes = await paneBoxes(page);
  check("Split down stacks a new pane under the right one", boxes.length === 3 && boxes[1].x === boxes[2].x && boxes[2].y > boxes[1].y, JSON.stringify(boxes.map((b) => [b.x, b.y])));

  // the layout survives a reload
  const layoutBefore = JSON.stringify(boxes.map((b) => [b.x, b.y, b.w, b.h, b.label]));
  await page.reload();
  await page.waitForTimeout(1500);
  const after = await paneBoxes(page);
  check("a reload brings back the same panes, sizes and sessions", JSON.stringify(after.map((b) => [b.x, b.y, b.w, b.h, b.label])) === layoutBefore, JSON.stringify(after.map((b) => b.label)));

  // too small to split: a 3rd column in the right half of a 1440 window is still ok; keep splitting the focused pane until refused
  let refusals = 0;
  for (let i = 0; i < 6; i++) {
    const n = (await paneBoxes(page)).length;
    await page.keyboard.press("Control+Backslash");
    await page.waitForTimeout(250);
    if ((await paneBoxes(page)).length === n) { refusals++; break; }
  }
  const tooSmall = /Not enough room|At most 12 panes/.test(await page.locator("body").innerText());
  boxes = await paneBoxes(page);
  check("splitting stops before a pane gets too small to use, and says why", refusals === 1 && tooSmall && boxes.every((b) => b.w >= 340), JSON.stringify(boxes.map((b) => b.w)));

  // close panes: Alt+X; the session keeps running and stays in the sidebar
  const nBefore = boxes.length;
  await page.keyboard.press("Alt+x");
  await page.waitForTimeout(300);
  check("Alt+X closes the focused pane", (await paneBoxes(page)).length === nBefore - 1);
  for (let i = 0; i < 8; i++) { await page.keyboard.press("Alt+x"); await page.waitForTimeout(120); }
  boxes = await paneBoxes(page);
  check("the last pane cannot be closed", boxes.length === 1);
  check("closing panes never closes their sessions: both are still listed", (await page.locator("aside").getByRole("button", { name: /Alpha task/ }).count()) >= 1 && (await page.locator("aside").getByRole("button", { name: /Beta task/ }).count()) >= 1);

  // ============================== notes
  const one = page.locator("section[data-pane]").first();
  // The note is keyed by the pane's session: read its id from the server by the pane's title.
  const oneTitle = (await one.getAttribute("aria-label")).replace(/^Pane \d+: /, "");
  const sid = (await (await fetch(`${base}/api/sessions`)).json()).find((x) => x.title === oneTitle).id;
  await one.getByRole("button", { name: "Show notes" }).click();
  const notes = one.getByRole("complementary", { name: "Notes" });
  await notes.waitFor();
  const area = notes.getByRole("textbox");
  check("the notes sidebar opens on the pane's right, with focus in the text area", await area.evaluate((el) => el === document.activeElement) && (await notes.boundingBox()).x > (await one.boundingBox()).x + (await one.boundingBox()).width / 2);
  await area.pressSequentially("plan: add retry\n- check timeouts", { delay: 5 });
  check("while typing it says there are unsaved changes", /Unsaved changes|Saving/.test(await notes.getByRole("status").last().innerText()));
  await page.waitForTimeout(1200);
  check("it saves itself shortly after typing stops", (await noteOf(sid)).body === "plan: add retry\n- check timeouts" && /Saved/.test(await notes.innerText()));
  check("the footer counts words", /6 words/.test(await notes.innerText()));
  await area.press("End");
  await area.pressSequentially("\nlast line");
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(400);
  check("Ctrl+S saves at once (and does not open the browser's save dialog)", (await noteOf(sid)).body.endsWith("last line"));
  // conflict: another tab saves in between
  // Another device saves while you are mid-edit (unsaved text here): it is pushed at once, and since
  // taking it would throw your typing away, the panel stops and asks instead.
  const cur = await noteOf(sid);
  await area.press("End");
  await page.keyboard.type(" and more");
  await peer.write(sid, "written on my phone", cur.updatedAt);
  await page.waitForTimeout(400);
  check("an edit from elsewhere while you type is stopped at once, and says so (your text is kept)", (await notes.getByRole("alert").count()) === 1 && (await area.inputValue()).endsWith(" and more") && (await noteOf(sid)).body === "written on my phone");
  await page.waitForTimeout(1000);
  check("...and your autosave does not overwrite theirs while you decide", (await noteOf(sid)).body === "written on my phone");
  await notes.getByRole("button", { name: "Keep mine" }).click();
  await page.waitForTimeout(600);
  check("Keep mine saves this editor's text over the other", (await noteOf(sid)).body.endsWith("and more") && (await notes.getByRole("alert").count()) === 0);
  // Live: another device edits while you are not typing: the text changes here, with no request made.
  const now1 = await noteOf(sid);
  await peer.write(sid, "pushed from another device", now1.updatedAt);
  await page.waitForFunction(() => document.querySelector('aside[aria-labelledby] textarea')?.value === "pushed from another device", null, { timeout: 4000 }).catch(() => {});
  check("an edit from another device appears live, pushed over the hub", (await area.inputValue()) === "pushed from another device" && /Saved/.test(await notes.innerText()));
  // Counted on the server: the tab holds one hub socket, plus the test's own "other device" peer.
  // (Playwright never reports a socket from before a reload as closed, so the browser side cannot tell.)
  const hubClients = (await (await fetch(`${base}/api/health`)).json()).hubClients;
  check("the whole tab uses one hub socket for notes", hubClients === 2, `${hubClients} hub clients on the server (tab + test peer)`);
  check("the browser never called a notes REST endpoint", noteRequests.length === 0, JSON.stringify(noteRequests.slice(0, 3)));
  await area.fill("typed after the push");
  await page.waitForTimeout(1200);
  // persist across reload and pane moves
  await page.reload();
  await page.waitForTimeout(1500);
  const areaAfter = page.locator("section[data-pane]").first().getByRole("complementary", { name: "Notes" }).getByRole("textbox");
  check("notes stay open across a reload and come back with their text", (await areaAfter.inputValue()) === "typed after the push");
  // switching the pane's session shows that session's notes; unsaved text in the old one is flushed
  await areaAfter.fill("alpha-or-beta draft unsaved");
  const other2 = "Alpha task";
  await page.locator("aside").getByRole("button", { name: new RegExp(other2) }).first().click();
  await page.waitForTimeout(900);
  check("switching sessions saves the old note first (nothing typed is lost)", (await noteOf(sid)).body === "alpha-or-beta draft unsaved");
  check("...and shows the new session's own (empty) note", (await page.locator("section[data-pane]").first().getByRole("complementary", { name: "Notes" }).getByRole("textbox").inputValue()) === "");
  // Escape closes notes
  await page.locator("section[data-pane]").first().getByRole("complementary", { name: "Notes" }).getByRole("textbox").press("Escape");
  await page.waitForTimeout(200);
  check("Escape closes the notes", (await page.getByRole("complementary", { name: "Notes" }).count()) === 0);
  // notes on a new chat: explained, not a trap
  await page.keyboard.press("Control+Backslash");
  await page.waitForTimeout(400);
  await page.locator("section[data-pane]").nth(1).getByRole("button", { name: "Show notes" }).click();
  check("a new chat's notes explain they belong to a session (no text box that would lose text)", /Notes belong to a session/.test(await page.locator("section[data-pane]").nth(1).innerText()) && (await page.locator("section[data-pane]").nth(1).getByRole("textbox", { name: /^Notes/ }).count()) === 0);
  await page.keyboard.press("Alt+x");

  // ============================== reconnect after a server restart
  // Stop the server, change the note in the database while it is down, start it again. The tab must
  // notice, reconnect by itself and show the new text, without any request. (Last, because a restart
  // forgets the sessions this test started in memory; a real server keeps them in the database.)
  await page.locator("section[data-pane]").first().getByRole("button", { name: "Show notes" }).click();
  const areaR = page.locator("section[data-pane]").first().getByRole("complementary", { name: "Notes" }).getByRole("textbox");
  await areaR.waitFor();
  const labelR = (await page.locator("section[data-pane]").first().getAttribute("aria-label")).replace(/^Pane \d+: /, "");
  const sidR = (await (await fetch(`${base}/api/sessions`)).json()).find((x) => x.title === labelR)?.id;
  const beforeDrop = (await noteOf(sidR)).updatedAt;
  peer.close();
  server.kill();
  await new Promise((r) => server.once("exit", r));
  {
    const { saveNote } = await import(join(root, "src/sessions.ts"));
    const ndb = openDb(dbPath);
    saveNote(ndb, sidR, "changed while the server was down", beforeDrop);
    ndb.close();
  }
  server = startServer();
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await Bun.sleep(100); }
  for (const id of ["s-alpha", "s-beta"]) await fetch(`${base}/api/history/${id}`, { method: "POST" });
  await page.waitForFunction(() => document.querySelector('aside[aria-labelledby] textarea')?.value === "changed while the server was down", null, { timeout: 20000 }).catch(() => {});
  check("after a server restart, the hub reconnects and catches up on its own", (await areaR.inputValue()) === "changed while the server was down", await areaR.inputValue());
  check("...with still no REST call for notes", noteRequests.length === 0);
  peer = await hubPeer();

  // ============================== size
  const px = (loc) => loc.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const para = page.locator("main .prose-mini").first();
  const chromeText = page.locator("aside").getByText("Settings", { exact: true });
  const [p0, c0] = [await px(para), await px(chromeText)];
  const sideW0 = (await page.locator("aside").first().boundingBox()).width;
  await page.keyboard.press("Control+Shift+Equal");
  await page.keyboard.press("Control+Shift+Equal");
  await page.waitForTimeout(200);
  check("Ctrl+Shift+= grows reading text only", (await px(para)) > p0 * 1.2 && (await px(chromeText)) === c0, `${p0} -> ${await px(para)}, chrome ${c0} -> ${await px(chromeText)}`);
  await page.keyboard.press("Control+Shift+Digit0");
  check("Ctrl+Shift+0 resets it", (await px(para)) === p0);
  await page.keyboard.press("Control+Equal");
  await page.keyboard.press("Control+Equal");
  await page.waitForTimeout(300);
  const zoomed = await page.evaluate(() => ({ z: getComputedStyle(document.documentElement).getPropertyValue("--ui-scale").trim(), sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, iw: innerWidth, ih: innerHeight }));
  const sideW1 = (await page.locator("aside").first().boundingBox()).width;
  check("Ctrl+= zooms the whole interface (the sidebar grows too)", zoomed.z === "1.25" && sideW1 > sideW0 * 1.2, `${zoomed.z}, sidebar ${sideW0} -> ${sideW1}`);
  check("...and it still fits the window exactly: no scrollbars", zoomed.sw <= zoomed.iw && zoomed.sh <= zoomed.ih, JSON.stringify(zoomed));
  const comp = await page.getByLabel("Prompt").boundingBox();
  check("...with the prompt bar still on screen", comp.y + comp.height <= 900);
  // settings panel: controls and live preview
  await page.keyboard.press("Control+Comma");
  const dlg = page.getByRole("dialog", { name: "Settings" });
  await dlg.waitFor();
  check("Settings shows both sizes at their current value", (await dlg.getByRole("combobox", { name: "Interface size" }).inputValue()) === "1.25" && (await dlg.getByRole("combobox", { name: "Text size" }).inputValue()) === "1");
  await dlg.getByRole("combobox", { name: "Text size" }).selectOption("1.5");
  check("picking a text size applies at once (the preview grows)", (await px(dlg.getByText("The retry now waits"))) === 13.5 * 1.5);
  const box = await dlg.locator('[role="document"]').boundingBox();
  check("the settings panel fits inside the window at 125%", box.y >= 0 && box.y + box.height <= 900 && box.x >= 0 && box.x + box.width <= 1440, JSON.stringify(box));
  await dlg.getByRole("button", { name: "Reset interface size to 100%" }).click();
  await dlg.getByRole("button", { name: "Reset text size to 100%" }).click();
  check("reset buttons go back to 100% and then disable", (await dlg.getByRole("button", { name: "Reset interface size to 100%" }).isDisabled()) && (await dlg.getByRole("combobox", { name: "Interface size" }).inputValue()) === "1");
  await dlg.getByRole("combobox", { name: "Interface size" }).selectOption("0.85");
  await page.reload();
  await page.waitForTimeout(1200);
  check("the size is remembered across a reload", (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--ui-scale").trim())) === "0.85");
  await page.evaluate(() => { localStorage.setItem("minitui.uiScale", "1"); });
  await ctx.close();

  // ============================== phone: panes become tabs
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const ph = await phone.newPage();
  await ph.goto(base);
  await ph.waitForTimeout(1200);
  // The phone opens on the desktop's layout (one shared workspace). Start a window of its own, with
  // one session pane, for the phone checks below.
  // The sessions sidebar (the notes panel is an <aside> too).
  const side = () => ph.locator("aside").filter({ has: ph.getByRole("button", { name: "New chat", exact: true }) });
  const openSide = async () => {
    if (await side().count()) return;
    // The notes panel may cover the pane on a phone (the desktop left it open, and it is shared):
    // close it first, then the sidebar toggle in the pane header is reachable.
    const closeNotes = ph.getByRole("button", { name: /^Close (notes|side panel)/i });
    if (await closeNotes.count()) await closeNotes.first().tap().catch(() => {});
    await ph.getByRole("button", { name: "Toggle sidebar" }).first().tap();
    await ph.waitForTimeout(400);
  };
  await openSide();
  await side().getByRole("button", { name: "New window" }).tap();
  await ph.waitForTimeout(600);
  await openSide();
  // A saved session no window shows yet: it opens in the new window's pane.
  await side().getByRole("button", { name: /Migrate settings page/ }).first().tap();
  await ph.waitForTimeout(900);
  if (await side().count()) await ph.getByRole("button", { name: "Close sidebar" }).tap().catch(() => {});
  await ph.waitForTimeout(300);
  await ph.locator("section[data-pane]").getByRole("button", { name: "Pane menu" }).tap();
  check("on a phone the menu offers a new pane (not two directions)", (await ph.getByRole("menuitem", { name: /New pane/ }).count()) === 1 && (await ph.getByRole("menuitem", { name: /Split right/ }).count()) === 0);
  await ph.getByRole("menuitem", { name: /New pane/ }).tap();
  await ph.waitForTimeout(500);
  const tabs = ph.getByRole("tablist", { name: "Panes" });
  check("panes show as tabs, one pane on screen, full width", (await tabs.getByRole("tab").count()) === 2 && (await paneBoxes(ph)).length === 1 && (await paneBoxes(ph))[0].w === 390);
  check("the new tab is selected", (await tabs.getByRole("tab").nth(1).getAttribute("aria-selected")) === "true");
  await tabs.getByRole("tab").first().tap();
  await ph.waitForTimeout(500);
  check("tapping a tab shows that pane", (await tabs.getByRole("tab").first().getAttribute("aria-selected")) === "true" && !/new chat/.test((await paneBoxes(ph))[0].label));
  // notes on phone: full width over the chat
  await ph.locator("section[data-pane]").getByRole("button", { name: "Show notes" }).tap();
  const pn = ph.getByRole("complementary", { name: "Notes" });
  await pn.waitFor();
  const nb = await pn.boundingBox();
  check("notes on a phone cover the pane, full width, inside the screen", Math.round(nb.width) === 390 && nb.x === 0 && nb.y + nb.height <= 844, JSON.stringify(nb));
  check("the notes field is 16px (no iOS zoom on focus)", (await pn.getByRole("textbox").evaluate((el) => parseFloat(getComputedStyle(el).fontSize))) >= 16);
  const small = await ph.evaluate(() => [...document.querySelectorAll("button, [role=tab], [role=separator], textarea, select, input")].filter((el) => { const r = el.getBoundingClientRect(); if (!r.width || !r.height) return false; const s = getComputedStyle(el); if (s.visibility === "hidden") return false; return (r.width < 43.5 || r.height < 43.5) && !el.closest("[aria-hidden=true]"); }).map((el) => `${el.getAttribute("aria-label") || el.textContent.trim().slice(0, 20)} ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`));
  check("every control on the phone is at least 44px", small.length === 0, JSON.stringify(small.slice(0, 8)));
  check("no sideways scroll on the phone", (await ph.evaluate(() => document.documentElement.scrollWidth)) <= 390);
  await phone.close();
} finally {
  peer.close();
  await browser.close();
  server.kill();
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `${failed} check(s) FAILED` : "all checks passed");
process.exit(failed ? 1 : 0);
