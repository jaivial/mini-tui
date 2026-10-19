// Real-browser end-to-end for one question: **does the panel's agents feed keep its promises?**
// Real server (temp database), real Chrome — and the only thing the test touches from outside is
// the page's EventSource (a drop, a server that refuses) and the timing of the panel's reads (the
// same outside-the-code trick as e2e-agent-tree-poll.mjs). The app code is untouched.
//
//   live:    the stream is what feeds the panel while it works (no REST polling behind it).
//   drop:    one drop bridges with reads AND COMES BACK to the stream (the deployed copy polled
//            at 1.5 s/4 s until the session closed — 0 stream attempts after the first error).
//   hidden:  a hidden tab does not read at all (the deployed copy polled for ever at 4 s), and
//            becoming seen reads at once.
//   hung:    a read that never answers cannot silence the panel (the deployed copy re-armed its
//            poll only after the await: one hung read = frozen panel until reload).
//
// Run after `bun run build` in web/:
//   cd web && bun scripts/e2e-agents-feed.mjs                     # this checkout
//   MINITUI_E2E_ROOT=/home/jaime/mini-tui-wa bun scripts/...     # another checkout's build
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const root = process.env.MINITUI_E2E_ROOT ?? join(import.meta.dir, "..", "..");
const outDir = process.env.EVIDENCE_DIR ?? join(import.meta.dir, "..", "..", "..", ".e2e-agents-feed");
mkdirSync(outDir, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "minitui-e2e-feed-"));
const dbPath = join(dir, "sessions.db");
const PORT = Number(process.env.PORT ?? 6600 + Math.floor(Math.random() * 280));
const base = `http://127.0.0.1:${PORT}`;

const { createSession, openDb, saveTranscript, rememberAgentRun } = await import(join(root, "src/sessions.ts"));
const db = openDb(dbPath);
const ID = "s-feed-a";
const TITLE = "feed row";
const writeTree = (names) => {
  const runDir = join(dir, "runs", ID);
  mkdirSync(join(runDir, "subagents"), { recursive: true });
  writeFileSync(join(runDir, "traj.json"), "{}");
  writeFileSync(
    join(runDir, "subagents", "index.json"),
    JSON.stringify({
      children: names.map((n) => ({ name: n, state: "running", task: `${n} task of ${ID}`, steps: 1, exit_status: "", started_at: Date.now(), last_activity: Date.now(), traj_path: "" })),
    }),
  );
};
createSession(db, { id: ID, cwd: "/tmp", model: "deepseek/deepseek-chat", task: `${ID} row`, title: TITLE });
saveTranscript(db, ID, [{ type: "task", text: `${ID} row` }, { type: "assistant", text: `hello from ${ID}` }], { cost: 0, apiCalls: 0 }, []);
writeTree(["worker1"]);
rememberAgentRun(db, ID, join(dir, "runs", ID, "traj.json"));
db.close();

const server = spawn(process.execPath, [join(root, "src/web/serve.ts"), "--port", String(PORT)], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, MINITUI_EMBEDDED_AGENT: "0", MINITUI_LAST_MODEL_PATH: join(dir, "last-model.json"), MINITUI_CONNECTIONS_PATH: join(dir, "providers.json"), MINITUI_SETTINGS_PATH: join(dir, "settings.json"), MINITUI_SKILLS_DIR: join(dir, "skills"), MINITUI_DB_PATH: dbPath, MINITUI_CONFIG_DIR: dir, MINITUI_RESUME_DIR: join(dir, "resume"), MINITUI_RUNS_DIR: join(dir, "runs") },
});
server.stderr.on("data", (b) => process.env.E2E_VERBOSE && console.log("  [server]", String(b).trim()));
for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await Bun.sleep(100); }
await fetch(`${base}/api/history/${ID}`, { method: "POST" });

const browser = await chromium.launch({ executablePath: process.env.E2E_CHROME ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); return ok; };

// Two outside controls: which EventSources exist (and can be dropped / made to fail), and how the
// panel's REST reads behave (delayed, hung). Both live in the page; no app code is touched.
const guardInit = () => {
  const Real = window.EventSource;
  const esLog = [];
  const live = [];
  const urls = new WeakMap();
  Object.defineProperty(window, "__esGuard", {
    value: {
      log: esLog,
      failNew: false,
      agents: () => live.filter((e) => /\/agents\/stream/.test(urls.get(e) ?? "")),
      killAgents() {
        for (const es of [...live]) {
          if (!/\/agents\/stream/.test(urls.get(es) ?? "")) continue;
          es.close();
          es.onerror?.(new Event("error"));
        }
      },
    },
    writable: true,
  });
  window.EventSource = class extends Real {
    constructor(url, init) {
      super(url, init);
      urls.set(this, url); // `url` is a read-only getter on the real object
      esLog.push({ url, at: Date.now(), kind: "open" });
      live.push(this);
      if (window.__esGuard.failNew && /\/agents\/stream/.test(url)) {
        queueMicrotask(() => {
          this.close();
          this.onerror?.(new Event("error"));
        });
      }
    }
    close() {
      const i = live.indexOf(this);
      if (i >= 0) live.splice(i, 1);
      super.close();
    }
  };
  Object.defineProperty(window, "__pollGuard", { value: { delays: {}, log: [] }, writable: true });
  Object.defineProperty(document, "hidden", { get: () => window.__pollGuard.fakeHidden, configurable: true });
  Object.defineProperty(document, "visibilityState", { get: () => (window.__pollGuard.fakeHidden ? "hidden" : "visible"), configurable: true });
  const real = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const m = url.match(/\/api\/sessions\/([^/]+)\/agents(\?|$)/);
    if (!m) return real(input, init);
    const id = decodeURIComponent(m[1]);
    window.__pollGuard.log.push({ id, url, at: Date.now(), kind: "start" });
    const ms = window.__pollGuard.delays[id] ?? 0;
    const signal = init?.signal;
    return new Promise((resolve, reject) => {
      let done = false;
      const onAbort = () => { if (!done) { done = true; reject(new DOMException("aborted", "AbortError")); } };
      if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener("abort", onAbort); }
      const go = () => { if (done) return; if (ms < 0) return; done = true; resolve(real(input, init)); };
      if (ms > 0) setTimeout(go, ms); else queueMicrotask(go);
    });
  };
};

const page = await ctx.newPage();
await page.addInitScript(`(${guardInit.toString()})();`);
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text().slice(0, 160)}`));
await page.goto(base);
await page.waitForTimeout(2500);

const bodyHas = (t) => page.evaluate((x) => document.body.innerText.includes(x), t);
const until = async (fn, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await Bun.sleep(150); }
  return false;
};
const readsSince = (t) => page.evaluate((s) => window.__pollGuard.log.filter((l) => l.at >= s && l.kind === "start" && !/brief=1/.test(l.url)), t); // the PANEL's reads (the sidebar's own poll is brief)
const briefReadsSince = (t) => page.evaluate((s) => window.__pollGuard.log.filter((l) => l.at >= s && l.kind === "start" && /brief=1/.test(l.url)), t);
const esSince = (t) => page.evaluate((s) => window.__esGuard.log.filter((l) => l.at >= s && /\/agents\/stream/.test(l.url)), t);

// Open the session in the pane (Bot menu -> Resume -> its row), then the side panel's Agents tab.
await page.locator("section[data-pane]").first().getByRole("button", { name: "Bot menu" }).click();
await page.waitForTimeout(300);
await page.getByRole("menuitem", { name: /Resume/ }).first().click();
await page.waitForTimeout(800);
await page.locator('[role="option"]').filter({ hasText: TITLE }).first().click();
await page.waitForTimeout(600);
await page.keyboard.press("Control+Shift+.");
await page.waitForTimeout(500);
// The side panel opens on Notes; its own tablist also has an "Agents" tab (exact: both exist).
await page.getByRole("tab", { name: "Agents", exact: true }).click();
const panelOpen = await until(() => page.locator('section[aria-label="Agents"]').count().then((n) => n > 0), 4000);
check("the side panel's Agents tab opens the panel", panelOpen);

// c0: the panel shows the tree.
const c0 = await until(() => bodyHas("worker1"), 8000);
check("c0: the agents panel shows the session's tree", c0, `body=${(await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "))).slice(0, 160)}`);

// c1: while the stream works, the panel does NOT rest-poll behind it.
let t = Date.now();
await page.waitForTimeout(6000);
let reads = await readsSince(t);
console.log(`LIVE  stream-opens=${(await esSince(0)).length} rest-reads=${reads.length} in 6s`);
check("c1: a live stream feeds the panel with no polling behind it", reads.length === 0, `rest-reads=${reads.length}`);

// c2/c3/c4: one drop -> bridge, and the STREAM COMES BACK (the deployed copy polled for ever).
t = Date.now();
await page.evaluate(() => window.__esGuard.killAgents());
const bridged = await until(async () => (await readsSince(t)).length >= 1, 4000);
check("c2: a drop is bridged with reads at once", bridged, `reads=${(await readsSince(t)).length}`);
const esAfter = await esSince(t);
const cameBack = await until(async () => (await esSince(t)).length >= 1, 12_000);
const esNow = await esSince(t);
check("c3: the stream is RETRIED after the drop (deployed: 0 further attempts)", cameBack, `stream-attempts-after-drop=${esNow.length} (${esAfter.length} immediately)`);
// Once the stream delivered again (its snapshot arrives on connect), the bridge stands down.
await page.waitForTimeout(1500);
t = Date.now();
await page.waitForTimeout(8000);
reads = await readsSince(t);
check("c4: the bridge STOPS when the stream is back (deployed: polls every 1.5 s for ever)", reads.length === 0, `reads-after-recovery=${reads.length} in 8s`);

// From here the server "refuses" every new stream: both builds must live on the bridge.
await page.evaluate(() => { window.__esGuard.failNew = true; window.__esGuard.killAgents(); });
await until(async () => (await readsSince(Date.now() - 2000)).length >= 1, 5000);

// c5/c6: a hidden tab does not poll; becoming seen polls at once.
await page.waitForTimeout(2500);
t = Date.now();
await page.evaluate(() => { window.__pollGuard.fakeHidden = true; document.dispatchEvent(new Event("visibilitychange")); });
await page.waitForTimeout(10_000);
reads = await readsSince(t);
check("c5: a hidden tab does not poll (deployed: every 4 s for ever)", reads.length === 0, `reads=${reads.length} in 10s`);
const visAt = await page.evaluate(() => {
  window.__pollGuard.visAt = Date.now();
  window.__pollGuard.fakeHidden = false;
  document.dispatchEvent(new Event("visibilitychange"));
  return window.__pollGuard.visAt;
});
await until(async () => (await readsSince(visAt)).length >= 1, 4000);
const after = await readsSince(visAt);
const first = after.length ? after[0].at - visAt : -1;
check("c6: becoming seen polls at once", first >= 0 && first <= 2000, `first-read ${first}ms after visibilitychange`);

// c7: a read that NEVER answers cannot silence the panel (and a tree change still lands).
await page.evaluate(() => { window.__pollGuard.delays["s-feed-a"] = -1; });
t = Date.now();
await page.waitForTimeout(25_000);
reads = await readsSince(t);
console.log(`HUNG  reads=${reads.length} in 25s`);
check("c7a: a hung read does not stop the polling (deployed: 1 read, for ever)", reads.length >= 2, `reads=${reads.length} in 25s`);
writeTree(["worker1", "worker2"]);
await page.evaluate(() => { delete window.__pollGuard.delays["s-feed-a"]; });
const landed = await until(() => bodyHas("worker2"), 25_000);
check("c7b: a tree changed on disk reaches the panel after the hung read is abandoned", landed);

// c8 (informational): what the two answers cost on this fixture, and what the sidebar asks for.
const full = await (await fetch(`${base}/api/sessions/${ID}/agents`)).text();
const brief = await (await fetch(`${base}/api/sessions/${ID}/agents?brief=1`)).text();
const briefZero = await (await fetch(`${base}/api/sessions/${ID}/agents?brief=0`)).text();
check("c8: only ?brief=1 is the brief (?brief=0 stays the full answer)", briefZero === full, `brief=0 -> ${briefZero.length}B vs full ${full.length}B`);
const sidebarReads = await briefReadsSince(0);
console.log(`PAYLOAD  full=${full.length}B  brief=${brief.length}B  sidebar-brief-reads=${sidebarReads.length} (the sidebar polls the small answer)`);
console.log(`errors=${errors.length ? errors.slice(0, 3).join(" | ") : 0}`);

await browser.close();
server.kill("SIGTERM");
rmSync(dir, { recursive: true, force: true });
