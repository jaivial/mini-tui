// Real-browser end-to-end for ONE question: **does asking "does this session exist?" OPEN it?**
//
// The client asks that question whenever a socket handshake is refused and never delivered a
// snapshot ("was that handshake refused because the session is gone, or is the network down?"). The
// route that used to answer it (`GET /api/sessions/:id`) answers by OPENING the session: it
// restores the saved row into a live session, puts the id back on the DURABLE open list
// (`web_open_sessions`, durable since #345) and announces it to every tab. So a client that merely
// wondered whether a session was still there brought a CLOSED session back to life -- and the next
// deploy kept it open for good.
//
// What this test drives: a real server (temp database, fake agent), a real Chrome and the app's own
// code. The only things touched from outside are the page's network (its session socket is made to
// fail, the way a dropped connection fails it) -- the app code is untouched and the server is
// healthy throughout.
//
// The checks name the symptom (the closed session is back in the live list, on the durable open list
// and announced to every tab) and the writer (which route the app actually asked). They FAIL on the
// build that reverts. Run after `bun run build` in web/:
//   cd web && bun scripts/e2e-session-exists.mjs                      # this checkout
//   MINITUI_E2E_ROOT=/home/jaime/wt-loop-E56-base bun scripts/...     # another checkout's build
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const root = process.env.MINITUI_E2E_ROOT ?? join(import.meta.dir, "..", "..");
const outDir = process.env.EVIDENCE_DIR ?? join(import.meta.dir, "..", "..", "..", ".e2e-session-exists");
const dir = mkdtempSync(join(tmpdir(), "minitui-e2e-exists-"));
const dbPath = join(dir, "sessions.db");
/** A port nothing is listening on: the run must never drive a foreign mini-tui by accident. */
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
const PORT = Number(process.env.PORT ?? (await freePort(6450 + Math.floor(Math.random() * 250))));
const base = `http://127.0.0.1:${PORT}`;
const ID = "s-closed";
const TITLE = "Closed session";

const { createSession, openDb, saveTranscript } = await import(join(root, "src/sessions.ts"));
{
  const sdb = openDb(dbPath);
  // A session saved and closed: the row is there (that is how "Resume" finds it), but it is not
  // open and it is not on the durable open list. Exactly the state a closed session is in.
  createSession(sdb, { id: ID, cwd: "/work/web", model: "deepseek/deepseek-chat", task: "closed task", title: TITLE });
  saveTranscript(sdb, ID, [{ type: "task", text: "closed task" }, { type: "assistant", text: "the answer" }],
    { cost: 0.01, apiCalls: 1, exitStatus: "Submitted" },
    [{ role: "system", content: "system" }, { role: "user", content: "closed task" }, { role: "assistant", content: "the answer" }]);
  sdb.close();
}
const { makeFakeAgent } = await import(join(root, "tests/helpers/fake-agent.ts"));
const fake = makeFakeAgent(join(dir, "bin"), { holdMs: 200 });
const server = spawn(process.execPath, [join(root, "src/web/serve.ts"), "--port", String(PORT)], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, MINITUI_MINI_BIN: fake.script, MINITUI_EMBEDDED_AGENT: "0", MINITUI_LAST_MODEL_PATH: join(dir, "last-model.json"), MINITUI_CONNECTIONS_PATH: join(dir, "providers.json"), MINITUI_SETTINGS_PATH: join(dir, "settings.json"), MINITUI_SKILLS_DIR: join(dir, "skills"), MINITUI_DB_PATH: dbPath, MINITUI_CONFIG_DIR: dir, MINITUI_RESUME_DIR: join(dir, "resume"), MINITUI_RUNS_DIR: join(dir, "runs") },
});
server.stderr.on("data", (b) => process.env.E2E_VERBOSE && console.log("  [server]", String(b).trim()));
for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await Bun.sleep(100); }

mkdirSync(outDir, { recursive: true });
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); if (!ok) failed++; };
/** The durable open list, read straight from the file the server writes. */
const openMarkers = () => {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query("SELECT session_id FROM web_open_sessions").all().map((r) => r.session_id);
  } finally {
    db.close();
  }
};
const liveIds = async () => (await (await fetch(`${base}/api/sessions`)).json()).map((s) => s.id);
const until = async (cond, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await Bun.sleep(100); } return await cond(); };

// The server's own announcements, watched from outside: this is how a session is "announced to every
// tab" (the SSE `/api/stream` the app listens to).
const announced = [];
{
  const res = await fetch(`${base}/api/stream`, { headers: { accept: "text/event-stream" } });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          try { announced.push(JSON.parse(line.slice(6))); } catch {}
        }
      }
    } catch {}
  })();
  await Bun.sleep(300);
}

const browser = await chromium.launch({ executablePath: process.env.E2E_CHROME ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
// The refused socket is this harness's own doing, not the app's: it is not an app error.
page.on("console", (m) => { if (m.type() === "error" && !/refused|WebSocket connection/.test(m.text())) errors.push(`console: ${m.text().slice(0, 160)}`); });

// The outside controls, both of them the page's network failing the way a dropped connection fails
// it: the session socket never gets a handshake, and the metadata stream delivers nothing (so the
// app is not told "this session is gone" and keeps asking). The app's own code decides what to ask
// and how to read the answer; no app code is touched.
const DEAD = process.env.E2E_DEAD_PORT ?? 45999;
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

// The session starts LIVE, so the app lists it and opens a socket for it (the pane shows the latest
// session on a first visit). It is closed afterwards, and the app -- which never hears about it --
// keeps asking whether it is still there.
if ((await fetch(`${base}/api/history/${ID}`, { method: "POST" })).status !== 200) throw new Error("could not open the session");
check("the session is live before the app loads", (await liveIds()).includes(ID), `live=${(await liveIds()).join(",")}`);

await page.goto(base);
const fetches = () => page.evaluate(() => window.__fetches ?? []);
await until(async () => (await fetches()).includes("/api/sessions"), 10000);
check("the app loaded the session list", (await fetches()).includes("/api/sessions"));
const probe = (u) => u === `/api/sessions/${ID}` || u === `/api/sessions/${ID}/exists`;
await until(async () => (await fetches()).some(probe), 15000);
check("the app asked the server about that session (the probe)", (await fetches()).some(probe), `asked=${[...new Set((await fetches()).filter(probe))].join(",")}`);

// Now the session is closed on the server. The app is not told (its metadata stream is healthy, but
// the client only learns of a close from the server's "session-gone" announcement, which comes with
// the socket that this test is breaking), so the only thing that can bring the session back is the
// app asking whether it is still there.
await fetch(`${base}/api/sessions/${ID}`, { method: "DELETE" });
check("the session is closed on the server", !(await liveIds()).includes(ID), `live=${(await liveIds()).join(",")}`);
check("closing it left no durable open marker", !openMarkers().includes(ID), `markers=${openMarkers().join(",")}`);

// The client keeps asking (its socket cannot connect): wait for the next question.
const askedBefore = (await fetches()).filter(probe).length;
await until(async () => (await fetches()).filter(probe).length > askedBefore, 25000);
await Bun.sleep(500);

// What the question did to the server: the closed session must still be closed.
const liveAfter = await liveIds();
check("asking did not bring the closed session back to life", !liveAfter.includes(ID), `live=${liveAfter.join(",")}`);
check("asking wrote no durable open marker", !openMarkers().includes(ID), `markers=${openMarkers().join(",")}`);
check("asking did not announce the session to any tab", !announced.some((e) => e.type === "session" && e.session?.id === ID), `announced=${announced.filter((e) => e.type === "session").map((e) => e.session?.id).join(",")}`);

// The writer: which route the app asked. The restoring read (`GET /api/sessions/:id`) is the one
// that opens; the read-only question (`/exists`) is the one that does not.
const asked = (await fetches()).filter((u) => u === `/api/sessions/${ID}` || u === `/api/sessions/${ID}/exists`);
check("the app asked the read-only existence route", asked.every((u) => u.endsWith("/exists")), `asked=${[...new Set(asked)].join(",")}`);
check("the app never used the restoring read", !asked.some((u) => u === `/api/sessions/${ID}`), `asked=${[...new Set(asked)].join(",")}`);
check("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));

const shot = await page.locator("section[data-pane]").first().screenshot({ path: join(outDir, "pane.png") }).catch(() => null);
console.log(`  captura: ${shot ? shot.length : 0} bytes`);

await browser.close().catch(() => {});
server.kill("SIGTERM");
try { rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(failed ? `${failed} check(s) FAILED` : "all checks passed");
process.exit(failed ? 1 : 0);
