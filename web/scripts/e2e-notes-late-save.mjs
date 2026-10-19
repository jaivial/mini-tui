// Real-browser end-to-end for one question: **does the notes panel tell the truth about a save it
// could not watch land?** A real server (temp database, fake agent), real WebSockets, real Chrome —
// and the only thing the test touches is the *timing of the hub socket*, from the outside:
//
//   - `late`:       the server's `note.saved` answer is DELAYED past the save's deadline. The write
//                   lands (the database says so) while the panel has already given up on it.
//   - `reconnect`:  the answer is DROPPED and the socket dies right after the save went out. The
//                   write lands; the hub reconnects and the server hands the note back as the catch
//                   up it does for every watch.
//
// In both, the lie before the fix is the same: the panel says "Not saved" (or "Changed somewhere
// else") while its own text is in the server's database. The checks below assert the panel agrees
// with the database, so they FAIL on the build that lies. Every run prints the status timeline it
// saw either way. Run after `bun run build` in web/:
//   cd web && bun scripts/e2e-notes-late-save.mjs                 # this checkout
//   MINITUI_E2E_ROOT=/home/jaime/mini-tui-wa bun scripts/...      # another checkout's build
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const root = process.env.MINITUI_E2E_ROOT ?? join(import.meta.dir, "..", "..");
const outDir = process.env.EVIDENCE_DIR ?? join(import.meta.dir, "..", "..", "..", ".e2e-notes-late-save");
const dir = mkdtempSync(join(tmpdir(), "minitui-e2e-noteslate-"));
const dbPath = join(dir, "sessions.db");
const PORT = Number(process.env.PORT ?? 6100 + Math.floor(Math.random() * 280));
const base = `http://127.0.0.1:${PORT}`;
const { createSession, openDb, saveTranscript } = await import(join(root, "src/sessions.ts"));
const db = openDb(dbPath);
for (const [id, title] of [["s-late", "Late answer"], ["s-recon", "Dropped answer"]]) {
  createSession(db, { id, cwd: "/tmp", model: "deepseek/deepseek-chat", task: title, title });
  saveTranscript(db, id, [{ type: "task", text: title }, { type: "assistant", text: `hello from ${id}` }], { cost: 0.01, apiCalls: 1 }, []);
}
db.close();

const { makeFakeAgent } = await import(join(root, "tests/helpers/fake-agent.ts"));
const fake = makeFakeAgent(join(dir, "bin"), { holdMs: 200 });
const server = spawn(process.execPath, [join(root, "src/web/serve.ts"), "--port", String(PORT)], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, MINITUI_MINI_BIN: fake.script, MINITUI_EMBEDDED_AGENT: "0", MINITUI_LAST_MODEL_PATH: join(dir, "last-model.json"), MINITUI_CONNECTIONS_PATH: join(dir, "providers.json"), MINITUI_SETTINGS_PATH: join(dir, "settings.json"), MINITUI_SKILLS_DIR: join(dir, "skills"), MINITUI_DB_PATH: dbPath, MINITUI_CONFIG_DIR: dir, MINITUI_RESUME_DIR: join(dir, "resume"), MINITUI_RUNS_DIR: join(dir, "runs") },
});
server.stderr.on("data", (b) => process.env.E2E_VERBOSE && console.log("  [server]", String(b).trim()));
for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await Bun.sleep(100); }
for (const id of ["s-late", "s-recon"]) await fetch(`${base}/api/history/${id}`, { method: "POST" });

const browser = await chromium.launch({ executablePath: process.env.E2E_CHROME ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
mkdirSync(outDir, { recursive: true });
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); if (!ok) failed++; };
const until = async (cond, ms = 8000) => { const end = Date.now() + ms; while (!(await cond()) && Date.now() < end) await Bun.sleep(100); return cond(); };

/** What the server actually holds, straight from its own database. */
const stored = (id) => new Database(dbPath, { readonly: true }).query("SELECT body FROM notes WHERE session_id = ?").get(id)?.body ?? "";
const version = (id) => new Database(dbPath, { readonly: true }).query("SELECT updated_at FROM notes WHERE session_id = ?").get(id)?.updated_at ?? 0;

const paneOf = (page, title) => page.locator("section[data-pane]").filter({ hasText: title }).first();
const statusOf = (pane) => pane.locator("aside.notes footer [role=status]").innerText().then((s) => s.replace(/\s+/g, " ").trim());
const bannerOf = (pane) => pane.locator("aside.notes [role=alert]").count();

async function openNotes(page, pane) {
  // The pane's menu holds the notes toggle ("Notes" / "Hide notes"), the only surface that opens it.
  if (await pane.locator("aside.notes textarea").count()) return;
  await pane.getByRole("button", { name: "Bot menu" }).click();
  await page.getByRole("menuitem", { name: /^Notes/ }).first().click();
  await pane.locator("aside.notes textarea").waitFor({ timeout: 8000 });
}

/** Install the socket guard before any app script runs. Only the hub's frames are touched. */
async function guard(context, mode) {
  await context.addInitScript(`(() => {
    const g = (window.__notesGuard = { mode: ${JSON.stringify(mode)}, lateMs: 18000, closeAfterMs: 300, saves: [], delayed: [], dropped: [], sockets: 0 });
    const Real = window.WebSocket;
    const onmessageDesc = Object.getOwnPropertyDescriptor(Real.prototype, "onmessage");
    const origSend = Real.prototype.send;
    class Guarded extends Real {
      constructor(url, ...rest) {
        super(url, ...rest);
        if (typeof url === "string" && url.includes("/api/hub")) {
          g.sockets++;
          Object.defineProperty(this, "onmessage", {
            configurable: true,
            get() { return this.__fn ?? null; },
            set(fn) {
              const wrapped = fn ? (ev) => {
                const data = ev.data;
                const isSaved = typeof data === "string" && data.includes('"t":"note.saved"');
                if (isSaved && g.mode === "late") { g.delayed.push(data); setTimeout(() => fn(ev), g.lateMs); return; }
                if (isSaved && g.mode === "reconnect") { g.dropped.push(data); return; }
                fn(ev);
              } : fn;
              this.__fn = wrapped;
              onmessageDesc.set.call(this, wrapped);
            },
          });
          this.send = (data) => {
            if (typeof data === "string" && data.includes('"t":"note.save"')) {
              g.saves.push(data);
              if (g.mode === "reconnect") setTimeout(() => { try { this.close(); } catch {} }, g.closeAfterMs);
            }
            return origSend.call(this, data);
          };
        }
      }
    }
    window.WebSocket = Guarded;
  })();`);
}

/** Sample the panel's verdict every 500 ms and record every change, with the elapsed time. */
function timeline(pane, t0) {
  const seen = [];
  let last = null;
  const t = setInterval(async () => {
    try {
      const status = await statusOf(pane);
      const alert = (await bannerOf(pane)) > 0;
      const line = `${status}${alert ? "  [+alerta 'guardado desde otra pestana']" : ""}`;
      if (line !== last) { last = line; seen.push([Date.now() - t0, line]); }
    } catch {}
  }, 500);
  return { seen, stop: () => clearInterval(t) };
}
const showTimeline = (name, seen) => {
  console.log(`  linea de tiempo (${name}):`);
  for (const [ms, line] of seen) console.log(`    t+${(ms / 1000).toFixed(1)}s  ${line}`);
};

async function scenario(page, { mode, sessionId, title, text }) {
  const ctx = page.context();
  await guard(ctx, mode);
  await page.goto(base);
  await page.waitForTimeout(1500);
  const pane = paneOf(page, title);
  // What a user does: open the session from the sidebar, then its notes.
  await page.locator("section[data-pane]").first().click({ position: { x: 150, y: 150 } });
  await page.waitForTimeout(250);
  await page.locator("aside").first().getByRole("button", { name: new RegExp(title) }).first().click();
  await page.waitForTimeout(900);
  const p = paneOf(page, title);
  await openNotes(page, p);
  await p.locator("aside.notes textarea").fill(text);
  const t0 = Date.now();
  const tl = timeline(p, t0);
  // The write is on the server a moment after typing (the database, not the log).
  check(`[${mode}] the save reached the server's database`, await until(() => stored(sessionId) === text, 6000), JSON.stringify(stored(sessionId)));
  await Bun.sleep(21000);
  tl.stop();
  showTimeline(mode, tl.seen);
  const guardState = await page.evaluate(() => ({ saves: window.__notesGuard.saves.length, delayed: window.__notesGuard.delayed.length, dropped: window.__notesGuard.dropped.length, sockets: window.__notesGuard.sockets }));
  console.log(`  guardia: ${JSON.stringify(guardState)}  version en el servidor: ${version(sessionId)}`);
  const final = await statusOf(p);
  const sawBanner = tl.seen.some(([, line]) => line.includes("+alerta"));
  check(`[${mode}] the panel agrees with the database once the dust settles (status "${final}")`, /^Saved/.test(final), `estado="${final}"`);
  check(`[${mode}] no false "saved from another tab or device" banner ever appeared`, !sawBanner, sawBanner ? "aparecio en la linea de tiempo" : "");
  check(`[${mode}] the server still holds the typed text`, stored(sessionId) === text);
  await p.screenshot({ path: join(outDir, `panel-${mode}.png`) }).catch(() => {});
  return { final, timeline: tl.seen };
}

const want = process.env.SCENARIO ?? "both";
try {
  if (want === "both" || want === "late") {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
    await scenario(page, { mode: "late", sessionId: "s-late", title: "Late answer", text: "the answer arrives after the panel gave up" });
    await ctx.close();
  }
  if (want === "both" || want === "reconnect") {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
    await scenario(page, { mode: "reconnect", sessionId: "s-recon", title: "Dropped answer", text: "the answer is lost and the socket dies" });
    await ctx.close();
  }
} catch (e) {
  console.log("FAIL  the run threw:", (e?.message ?? String(e)).split("\n")[0]);
  failed++;
} finally {
  await browser.close().catch(() => {});
  server.kill();
  rmSync(dir, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
