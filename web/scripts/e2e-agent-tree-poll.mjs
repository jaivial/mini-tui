// Real-browser end-to-end for one question: **is the sidebar's agent-tree poll a loop that can
// keep its promise?** Real server (temp database), real Chrome — and the only thing the test
// touches is the *timing of the reads*, from the outside (a page-level fetch guard, the same
// outside-the-code trick as e2e-notes-late-save.mjs's socket guard). The app code is untouched.
//
// Three sessions, each with one working delegate on disk. The loop polls all of them per tick.
//   slow:   session B's read takes 8 s. Does A's cadence survive? (the deployed loop sleeps AFTER
//           the slowest read, so one slow sibling stretches everyone's period to slowest + pace)
//   hang:   B's read NEVER answers. Does A keep polling? (the deployed loop awaits the slowest
//           read forever: one hung read silences every session until reload)
//   hidden: the tab is hidden. Does it keep polling? (the deployed loop polls at 2x pace forever)
//   visible again: does a hidden→visible tab poll at once?
//
// Run after `bun run build` in web/:
//   cd web && bun scripts/e2e-agent-tree-poll.mjs                     # this checkout
//   MINITUI_E2E_ROOT=/home/jaime/mini-tui-wa bun scripts/...          # another checkout's build
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const root = process.env.MINITUI_E2E_ROOT ?? join(import.meta.dir, "..", "..");
const outDir = process.env.EVIDENCE_DIR ?? join(import.meta.dir, "..", "..", "..", ".e2e-agent-tree-poll");
mkdirSync(outDir, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "minitui-e2e-tree-"));
const dbPath = join(dir, "sessions.db");
const PORT = Number(process.env.PORT ?? 6500 + Math.floor(Math.random() * 280));
const base = `http://127.0.0.1:${PORT}`;
const PACE = 3000; // the deployed loop's pace while a delegate is live (3 s live / 5 s quiet)

const { createSession, openDb, saveTranscript, rememberAgentRun } = await import(join(root, "src/sessions.ts"));
const db = openDb(dbPath);
const S = ["s-tree-a", "s-tree-b", "s-tree-c"];
const writeTree = (id, names) => {
  const runDir = join(dir, "runs", id);
  mkdirSync(join(runDir, "subagents"), { recursive: true });
  writeFileSync(join(runDir, "traj.json"), "{}");
  writeFileSync(
    join(runDir, "subagents", "index.json"),
    JSON.stringify({
      children: names.map((n) => ({ name: n, state: "running", task: `${n} task of ${id}`, steps: 1, exit_status: "", started_at: Date.now(), last_activity: Date.now(), traj_path: "" })),
    }),
  );
};
for (const id of S) {
  createSession(db, { id, cwd: "/tmp", model: "deepseek/deepseek-chat", task: `${id} row`, title: `${id} row` });
  saveTranscript(db, id, [{ type: "task", text: `${id} row` }, { type: "assistant", text: `hello from ${id}` }], { cost: 0, apiCalls: 0 }, []);
  const runDir = join(dir, "runs", id);
  writeTree(id, ["worker1"]);
  rememberAgentRun(db, id, join(runDir, "traj.json"));
}
db.close();

const server = spawn(process.execPath, [join(root, "src/web/serve.ts"), "--port", String(PORT)], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, MINITUI_EMBEDDED_AGENT: "0", MINITUI_LAST_MODEL_PATH: join(dir, "last-model.json"), MINITUI_CONNECTIONS_PATH: join(dir, "providers.json"), MINITUI_SETTINGS_PATH: join(dir, "settings.json"), MINITUI_SKILLS_DIR: join(dir, "skills"), MINITUI_DB_PATH: dbPath, MINITUI_CONFIG_DIR: dir, MINITUI_RESUME_DIR: join(dir, "resume"), MINITUI_RUNS_DIR: join(dir, "runs") },
});
server.stderr.on("data", (b) => process.env.E2E_VERBOSE && console.log("  [server]", String(b).trim()));
for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await Bun.sleep(100); }
for (const id of S) await fetch(`${base}/api/history/${id}`, { method: "POST" });

const browser = await chromium.launch({ executablePath: process.env.E2E_CHROME ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); return ok; };

// The fetch guard: log every agents read that STARTS, and give each session an outside latency.
const guardInit = () => {
  Object.defineProperty(window, "__pollGuard", { value: { delays: {}, log: [], fakeHidden: false }, writable: true });
  Object.defineProperty(document, "hidden", { get: () => window.__pollGuard.fakeHidden, configurable: true });
  Object.defineProperty(document, "visibilityState", { get: () => (window.__pollGuard.fakeHidden ? "hidden" : "visible"), configurable: true });
  const real = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const m = url.match(/\/api\/sessions\/([^/]+)\/agents(\?|$)/);
    if (!m) return real(input, init);
    const id = decodeURIComponent(m[1]);
    window.__pollGuard.log.push({ id, at: Date.now(), kind: "start" });
    const ms = window.__pollGuard.delays[id] ?? 0;
    const signal = init?.signal;
    return new Promise((resolve, reject) => {
      let done = false;
      const onAbort = () => { if (!done) { done = true; reject(new DOMException("aborted", "AbortError")); } };
      if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener("abort", onAbort); }
      const go = () => { if (done) return; if (ms < 0) return; done = true; window.__pollGuard.log.push({ id, at: Date.now(), kind: "end" }); resolve(real(input, init)); };
      if (ms > 0) setTimeout(go, ms); else queueMicrotask(go);
    });
  };
};

async function newGuardedPage(hidden = false) {
  const page = await ctx.newPage();
  await page.addInitScript(`(${guardInit.toString()})(); window.__pollGuard.fakeHidden = ${JSON.stringify(hidden)};`);
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text().slice(0, 160)}`));
  await page.goto(base);
  await page.waitForTimeout(2500);
  return { page, errors };
}

const logOf = (page, since) => page.evaluate((s) => window.__pollGuard.log.filter((l) => l.at >= s && l.kind === "start"), since);
const gapsOf = (log, id) => { const t = log.filter((l) => l.id === id).map((l) => l.at); return t.slice(1).map((v, i) => v - t[i]); };
const bodyHas = (page, text) => page.evaluate((t) => document.body.innerText.includes(t), text);

// ------------------------------------------------------------------ P1: cadence
const { page, errors } = await newGuardedPage();
// Expand session A's row ("Show its work"): the delegate rows live under it.
await page.getByRole("button", { name: "Show s-tree-a row's work" }).click();
await page.waitForTimeout(800);
check("c0: the sidebar shows a session's delegate rows", await bodyHas(page, "worker1"), await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 200)));
let t = Date.now();
await page.waitForTimeout(14000);
let log = await logOf(page, t);
const g1 = gapsOf(log, "s-tree-a");
console.log(`CADENCE  requests=${log.length} per-session=${S.map((s) => `${s}:${log.filter((l) => l.id === s).length}`).join(" ")} a-gaps=${g1.map((x) => x + "ms").join(",")}`);

// ------------------------------------------------------------------ P2: slow sibling
await page.evaluate(() => { window.__pollGuard.delays["s-tree-b"] = 8000; });
t = Date.now();
await page.waitForTimeout(20000);
log = await logOf(page, t);
const g2 = gapsOf(log, "s-tree-a");
const slowGap = g2.length ? Math.max(...g2) : Infinity;
console.log(`SLOW  b-delay=8000ms  a-gaps=${g2.map((x) => x + "ms").join(",")} requests=${log.length}`);
check("c1: a sibling's 8s read does not stretch another session's cadence", g2.length >= 2 && slowGap <= PACE + 2500, `a-gap max=${slowGap}ms (deployed: slowest+pace ≈ 11000ms)`);

// ------------------------------------------------------------------ P3: hung sibling
const armAt = Date.now();
await page.evaluate(() => { window.__pollGuard.delays["s-tree-b"] = -1; });
// A hung tick has begun once B's read starts (A's read of that tick already fired, with old data):
await page.waitForFunction((s) => window.__pollGuard.log.some((l) => l.id === "s-tree-b" && l.kind === "start" && l.at > s), armAt, { timeout: 15000 }).catch(() => {});
writeTree("s-tree-a", ["worker1", "worker2"]); // A's tree changes on disk while B hangs
t = Date.now();
await page.waitForTimeout(25000);
log = await logOf(page, t);
const g3 = gapsOf(log, "s-tree-a");
const nA = log.filter((l) => l.id === "s-tree-a").length;
console.log(`HUNG  b=never  a-requests=${nA} in 25s  a-gaps=${g3.map((x) => x + "ms").join(",")}`);
check("c2: a sibling's hung read does not stop another session's polling", nA >= 3, `a-requests=${nA} in 25000ms`);
check("c3: a changed tree reaches the sidebar while a sibling's read hangs", await bodyHas(page, "worker2"), `bodyHas(worker2)=${await bodyHas(page, "worker2")}`);
console.log(`HUNG  body=${(await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "))).slice(0, 220)}`);
console.log(`errors=${errors.length ? errors.slice(0, 3).join(" | ") : 0}`);
await page.close();

// ------------------------------------------------------------------ P4: hidden tab
const { page: hp } = await newGuardedPage(true);
t = Date.now();
await hp.waitForTimeout(25000);
const hiddenLog = await logOf(hp, t);
console.log(`HIDDEN  requests=${hiddenLog.length} in 25s (fakeHidden=true)`);
check("c4: a hidden tab does not poll", hiddenLog.length === 0, `requests=${hiddenLog.length} in 25000ms`);
// Becoming visible must poll at once: wait until a request starts, then unhide right after it.
// Unhide right after a hidden-tab request starts (only a tab that polls while hidden needs this
// stagger), and stamp the moment INSIDE the page: the immediate poll of a fixed build can start
// before Node sees the call return, and c5 must count it, not filter it out.
if (hiddenLog.length) {
  const n0 = await hp.evaluate(() => window.__pollGuard.log.filter((l) => l.kind === "start").length);
  await hp.waitForFunction((n) => window.__pollGuard.log.filter((l) => l.kind === "start").length > n, n0, { timeout: 30000 }).catch(() => {});
}
await hp.evaluate(() => {
  window.__pollGuard.visAt = Date.now();
  window.__pollGuard.fakeHidden = false;
  document.dispatchEvent(new Event("visibilitychange"));
});
const visAt = await hp.evaluate(() => window.__pollGuard.visAt);
await hp.waitForFunction((s) => window.__pollGuard.log.some((l) => l.kind === "start" && l.at >= s), visAt, { timeout: 20000 }).catch(() => {});
const after = await logOf(hp, visAt);
const first = after.length ? after[0].at - visAt : -1;
console.log(`VISIBLE  first request ${first}ms after visibilitychange`);
check("c5: becoming visible polls immediately", first >= 0 && first <= 2000, `first=${first}ms`);
await hp.close();

// ------------------------------------------------------------------ P5: what the answer costs (informational)
const raw = await (await fetch(`${base}/api/sessions/s-tree-a/agents`)).text();
const v = JSON.parse(raw);
console.log(`PAYLOAD  bytes=${raw.length} nodes=${v.nodes.length} events=${v.events.length} defs=${v.defs.length} (the sidebar keeps rows/live/total)`);

await browser.close();
server.kill("SIGTERM");
rmSync(dir, { recursive: true, force: true });
