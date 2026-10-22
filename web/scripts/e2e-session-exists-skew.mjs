// Real-browser end-to-end: **a bundle NEWER than its server must not wipe a live pane.**
//
// The bundle is served from disk (`web/dist`, gitignored) and the server is restarted separately, so
// there is always a window in which the client is NEWER than the server it talks to. The new client
// asks the read-only question `GET /api/sessions/:id/exists` (E56); a server that predates that
// route falls through to its catch-all and answers `404 {"error":"not found"}`.
//
// A client that read the VERDICT FROM THE STATUS would take that 404 for "this session is nowhere",
// drop the live session and turn its pane into a new chat -- the E52 symptom, resurrected through
// the other door, and in the deploy window where nobody is looking. The verdict therefore rides in
// the BODY, and every other outcome (a routing 404, a 503, the network) is a failure to ASK.
//
// WHAT THIS TEST DOES: it runs the OLD server (the base checkout, which has no `/exists` route) and
// points it at the NEW bundle, then refuses the session socket -- the only thing that makes the
// client ask the question -- and checks the pane KEEPS the live session.
//
// The checks FAIL on the build that reads the verdict from the status. Run after `bun run build`
// in web/:
//   cd web && bun scripts/e2e-session-exists-skew.mjs                   # new bundle, old server
//   MINITUI_E2E_SERVER_ROOT=/home/jaime/wt-loop-E56-base bun scripts/...
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";

const root = process.env.MINITUI_E2E_ROOT ?? join(import.meta.dir, "..", "..");
/** The checkout whose SERVER runs. It predates the `/exists` route: that is the skew. */
const serverRoot = process.env.MINITUI_E2E_SERVER_ROOT ?? join(root, "..", "wt-loop-E56-base");
const outDir = process.env.EVIDENCE_DIR ?? join(import.meta.dir, "..", "..", "..", ".e2e-session-exists-skew");
const dir = mkdtempSync(join(tmpdir(), "minitui-e2e-skew-"));
const dbPath = join(dir, "sessions.db");
const freePort = async (start) => {
  for (let p = start; p < start + 250; p++) {
    try {
      const l = Bun.listen({ hostname: "127.0.0.1", port: p, socket: { data() {}, error() {} } });
      l.stop(true);
      return p;
    } catch {
      /* taken: try the next */
    }
  }
  throw new Error("no free port found");
};
const PORT = Number(process.env.PORT ?? (await freePort(6700 + Math.floor(Math.random() * 250))));
const base = `http://127.0.0.1:${PORT}`;
const ID = "s-live";
const TITLE = "Live session";

const { createSession, openDb, saveTranscript } = await import(join(root, "src/sessions.ts"));
{
  const sdb = openDb(dbPath);
  createSession(sdb, { id: ID, cwd: "/work/web", model: "deepseek/deepseek-chat", task: "live task", title: TITLE });
  saveTranscript(sdb, ID, [{ type: "task", text: "live task" }, { type: "assistant", text: "the answer" }],
    { cost: 0.01, apiCalls: 1, exitStatus: "Submitted" },
    [{ role: "system", content: "system" }, { role: "user", content: "live task" }, { role: "assistant", content: "the answer" }]);
  sdb.close();
}
const { makeFakeAgent } = await import(join(root, "tests/helpers/fake-agent.ts"));
const fake = makeFakeAgent(join(dir, "bin"), { holdMs: 200 });
// THE SERVER SERVES ITS STATIC FILES FROM ITS OWN CHECKOUT (`web/dist`, resolved relative to the
// source file), so "old server, new bundle" is staged by putting the new bundle in the old
// checkout's `web/dist` -- exactly what a deploy does, since `web/dist` is gitignored and the
// bundle is built separately from the server restart. The old checkout's own bundle is put back
// afterwards, so nothing is left behind.
const serveDist = process.env.MINITUI_E2E_SERVE_DIST ?? join(root, "web", "dist");
const serverDist = join(serverRoot, "web", "dist");
const backupDist = join(dir, "dist-backup");
let restored = false;
if (resolve(serverDist) !== resolve(serveDist)) {
  cpSync(serverDist, backupDist, { recursive: true });
  rmSync(serverDist, { recursive: true, force: true });
  cpSync(serveDist, serverDist, { recursive: true });
  restored = true;
}
const restoreDist = () => {
  if (!restored) return;
  rmSync(serverDist, { recursive: true, force: true });
  cpSync(backupDist, serverDist, { recursive: true });
};

const server = spawn(process.execPath, [join(serverRoot, "src/web/serve.ts"), "--port", String(PORT)], {
  cwd: serverRoot,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, MINITUI_MINI_BIN: fake.script, MINITUI_EMBEDDED_AGENT: "0", MINITUI_LAST_MODEL_PATH: join(dir, "last-model.json"), MINITUI_CONNECTIONS_PATH: join(dir, "providers.json"), MINITUI_SETTINGS_PATH: join(dir, "settings.json"), MINITUI_SKILLS_DIR: join(dir, "skills"), MINITUI_DB_PATH: dbPath, MINITUI_CONFIG_DIR: dir, MINITUI_RESUME_DIR: join(dir, "resume"), MINITUI_RUNS_DIR: join(dir, "runs") },
});
server.stderr.on("data", (b) => process.env.E2E_VERBOSE && console.log("  [server]", String(b).trim()));
for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await Bun.sleep(100); }

mkdirSync(outDir, { recursive: true });
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); if (!ok) failed++; };
const liveIds = async () => (await (await fetch(`${base}/api/sessions`)).json()).map((s) => s.id);
const until = async (cond, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await Bun.sleep(100); } return await cond(); };

// THE SKEW IS REAL: the server predates the route the new client asks.
const routeAnswer = await fetch(`${base}/api/sessions/${ID}/exists`);
check("the server really is older than the client (no /exists route)", routeAnswer.status === 404, `status=${routeAnswer.status}`);

// The session is LIVE on that old server.
{
  const opened = await fetch(`${base}/api/history/${ID}`, { method: "POST" });
  check("the session is live on the old server", opened.status === 200, `status=${opened.status}`);
  check("the old server holds it", (await liveIds()).includes(ID), `live=${(await liveIds()).join(",")}`);
}

const browser = await chromium.launch({ executablePath: process.env.E2E_CHROME ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
// The 404 on the existence route is the SCENARIO (the old server has no such route), so the
// browser's own log of it is not an error. Everything else is.
page.on("console", (m) => {
  if (m.type() !== "error") return;
  if (/refused|WebSocket connection/.test(m.text())) return;
  const from = m.location?.()?.url ?? "";
  if (/\/exists\b/.test(from)) return;
  errors.push(`console: ${m.text().slice(0, 160)}`);
});

// The session socket is refused (the only thing that makes the client ask the question), and the
// metadata stream delivers nothing (so the app is not told anything and must ASK).
const DEAD = process.env.E2E_DEAD_PORT ?? 45998;
await page.addInitScript(`(() => {
  const DEAD = ${DEAD};
  const RealWS = window.WebSocket;
  window.WebSocket = class extends RealWS {
    constructor(url, protocols) {
      const u = String(url);
      if (/\\/api\\/sessions\\/[^/]+\\/socket/.test(u)) { super("ws://127.0.0.1:" + DEAD + "/refused", protocols); return; }
      super(url, protocols);
    }
  };
  window.EventSource = class {
    constructor(url) { this.url = String(url); this.readyState = 0; setTimeout(() => this.onopen?.(new Event("open")), 0); }
    close() { this.readyState = 2; }
    addEventListener() {}
    removeEventListener() {}
  };
  const RealFetch = window.fetch;
  window.__fetches = [];
  window.fetch = function (input, init) {
    try { window.__fetches.push(String(typeof input === "string" ? input : (input && input.url) ?? input)); } catch {}
    return RealFetch.call(this, input, init);
  };
})();`);

await page.goto(base);
const fetches = () => page.evaluate(() => window.__fetches ?? []);
await until(async () => (await fetches()).includes("/api/sessions"), 10000);
check("the app loaded the session list", (await fetches()).includes("/api/sessions"));

// The pane shows the live session BEFORE the question.
await until(async () => {
  const label = await page.locator("section[data-pane]").first().getAttribute("aria-label").catch(() => null);
  return !!label && label.includes("Live session");
}, 15000);
const labelBefore = await page.locator("section[data-pane]").first().getAttribute("aria-label").catch(() => null);
check("the pane shows the live session before the question", !!labelBefore && labelBefore.includes("Live session"), `label=${labelBefore}`);

// The client asks. The old server answers 404 (no such route) -- a failure to ASK, not a verdict.
const askedBefore = (await fetches()).filter((u) => u.includes(`/sessions/${ID}`)).length;
await until(async () => (await fetches()).filter((u) => u.includes(`/sessions/${ID}`)).length > askedBefore, 20000);
const asked = [...new Set((await fetches()).filter((u) => u.includes(`/sessions/${ID}`)))];
check("the app asked the read-only existence route", asked.some((u) => u.endsWith("/exists")), `asked=${asked.join(",")}`);

// Give the client time to ACT on the answer. A verdict would wipe the pane here.
await Bun.sleep(3000);
const labelAfter = await page.locator("section[data-pane]").first().getAttribute("aria-label").catch(() => null);
check("the pane KEPT the live session (a routing 404 is not a verdict)", !!labelAfter && labelAfter.includes("Live session"), `label=${labelAfter}`);
check("the session is still live on the server", (await liveIds()).includes(ID), `live=${(await liveIds()).join(",")}`);
check("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));

const shot = await page.locator("section[data-pane]").first().screenshot({ path: join(outDir, "pane.png") }).catch(() => null);
console.log(`  captura: ${shot ? shot.length : 0} bytes`);

await browser.close().catch(() => {});
server.kill("SIGTERM");
restoreDist();
try { rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(failed ? `${failed} check(s) FAILED` : "all checks passed");
process.exit(failed ? 1 : 0);
