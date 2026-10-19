// Real-browser end-to-end for one question: **is the time on screen a clock?** A real server (temp
// database, fake agent), real WebSockets, real Chrome — and every check below compares what a label
// CLAIMS against the wall clock, never against another copy of the code's rules.
//
//   sidebar:  three sessions with known `updated_at` (30 s / 90 s / 2 h before load). A label that
//             says "1m ago" is a claim: the real age must be inside that minute, at every sample.
//   notes:    a real save through the hub, sampled every 500 ms: "Saved 7s ago" must mean 7 seconds
//             (the deployed build refreshes its `now` every 15 s and understates the age).
//   skew:     the browser clock patched 10 min ahead / behind the server (a phone with a wrong
//             clock). Every timestamp on screen comes from the server, so a wrong device clock must
//             not turn into a wrong age.
//   elapsed:  a running turn's counter in the session header must advance with the wall clock.
//
// Run after `bun run build` in web/:
//   cd web && bun scripts/e2e-relative-clock.mjs                  # this checkout
//   MINITUI_E2E_ROOT=/home/jaime/mini-tui-wa bun scripts/...      # another checkout's build
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const root = process.env.MINITUI_E2E_ROOT ?? join(import.meta.dir, "..", "..");
const outDir = process.env.EVIDENCE_DIR ?? join(import.meta.dir, "..", "..", "..", ".e2e-relative-clock");
const dir = mkdtempSync(join(tmpdir(), "minitui-e2e-clock-"));
const dbPath = join(dir, "sessions.db");
const PORT = Number(process.env.PORT ?? 6300 + Math.floor(Math.random() * 280));
const base = `http://127.0.0.1:${PORT}`;
const TOL = 2.5; // seconds a claim may be off by (sample jitter only: the claims are 1 s fine)

const { createSession, openDb, saveTranscript } = await import(join(root, "src/sessions.ts"));
const db = openDb(dbPath);
const S = [
  ["s-clock30", "clock30 row", 30_000],
  ["s-clock2m", "clock2m row", 90_000],
  ["s-clock2h", "clock2h row", 7_200_000],
  ["s-clocknote", "clocknote row", 40_000],
  ["s-clockrun", "clockrun row", 60_000],
];
for (const [id, title, age] of S) {
  createSession(db, { id, cwd: "/tmp", model: "deepseek/deepseek-chat", task: title, title });
  saveTranscript(db, id, [{ type: "task", text: title }, { type: "assistant", text: `hello from ${id}` }], { cost: 0, apiCalls: 0 }, []);
  db.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(Date.now() - age, id);
}
db.close();

const { makeFakeAgent } = await import(join(root, "tests/helpers/fake-agent.ts"));
const fake = makeFakeAgent(join(dir, "bin"), { holdMs: 30_000 });
const server = spawn(process.execPath, [join(root, "src/web/serve.ts"), "--port", String(PORT)], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, MINITUI_MINI_BIN: fake.script, MINITUI_EMBEDDED_AGENT: "0", MINITUI_LAST_MODEL_PATH: join(dir, "last-model.json"), MINITUI_CONNECTIONS_PATH: join(dir, "providers.json"), MINITUI_SETTINGS_PATH: join(dir, "settings.json"), MINITUI_SKILLS_DIR: join(dir, "skills"), MINITUI_DB_PATH: dbPath, MINITUI_CONFIG_DIR: dir, MINITUI_RESUME_DIR: join(dir, "resume"), MINITUI_RUNS_DIR: join(dir, "runs") },
});
server.stderr.on("data", (b) => process.env.E2E_VERBOSE && console.log("  [server]", String(b).trim()));
for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await Bun.sleep(100); }

// Make the sessions live (what the sidebar lists), then re-apply their ages: resuming touches rows.
for (const [id] of S) await fetch(`${base}/api/history/${id}`, { method: "POST" });
{
  const db2 = openDb(dbPath);
  for (const [id, , age] of S) db2.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(Date.now() - age, id);
  db2.close();
}

const browser = await chromium.launch({ executablePath: process.env.E2E_CHROME ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
mkdirSync(outDir, { recursive: true });
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); if (!ok) failed++; };
const showTimeline = (name, seen) => {
  console.log(`  linea de tiempo (${name}):`);
  for (const [ms, line] of seen) console.log(`    t+${(ms / 1000).toFixed(1)}s  ${line}`);
};

/** What a label claims: the age window it names, in seconds. A claim is checked against the clock. */
function claimWindow(label) {
  if (label === "just now" || label === "Saved" || label === "hace un momento") return [0, 60];
  if (label === "nunca") return null;
  let m = /^Saved (\d+)s ago$/.exec(label);
  if (m) return [Number(m[1]), Number(m[1]) + 1];
  m = /^Saved (\d+)m ago$/.exec(label);
  if (m) return [Number(m[1]) * 60, (Number(m[1]) + 1) * 60];
  m = /^(\d+)s ago$/.exec(label);
  if (m) return [Number(m[1]), Number(m[1]) + 1];
  m = /^(\d+)m ago$/.exec(label);
  if (m) return [Number(m[1]) * 60, (Number(m[1]) + 1) * 60];
  m = /^(\d+)h ago$/.exec(label);
  if (m) return [Number(m[1]) * 3600, (Number(m[1]) + 1) * 3600];
  m = /^(\d+)d ago$/.exec(label);
  if (m) return [Number(m[1]) * 86_400, (Number(m[1]) + 1) * 86_400];
  m = /^(\d+)s$/.exec(label);
  if (m) return [Number(m[1]), Number(m[1]) + 1];
  m = /^(\d+)m (\d+)s$/.exec(label);
  if (m) return [Number(m[1]) * 60 + Number(m[2]), Number(m[1]) * 60 + Number(m[2]) + 1];
  m = /^(\d+)h (\d+)m$/.exec(label);
  if (m) return [Number(m[1]) * 3600 + Number(m[2]) * 60, Number(m[1]) * 3600 + (Number(m[2]) + 1) * 60];
  return null;
}
/** The claim is honest when the real age falls in the window it names (± tolerance). */
const honest = (label, realAgeSecs) => {
  const w = claimWindow(label);
  return w === null ? true : realAgeSecs >= w[0] - TOL && realAgeSecs < w[1] + TOL;
};

const updatedAt = (id) => new Database(dbPath, { readonly: true }).query("SELECT updated_at FROM sessions WHERE id = ?").get(id)?.updated_at ?? 0;
const stored = (id) => new Database(dbPath, { readonly: true }).query("SELECT body FROM notes WHERE session_id = ?").get(id)?.body ?? "";

const sidebarLabels = (page) => page.evaluate(() => {
  const out = {};
  for (const el of document.querySelectorAll("span")) {
    const t = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (/^(just now|\d+[smhd] ago)$/.test(t)) {
      const row = el.closest("button") ?? el.closest("[data-row]") ?? el.parentElement?.parentElement;
      out[(row?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40)] = t;
    }
  }
  return out;
});
const rowLabel = async (page, title) => {
  const rows = await sidebarLabels(page);
  for (const [row, label] of Object.entries(rows)) if (row.includes(title)) return label;
  return null;
};
const paneOf = (page, title) => page.locator("section[data-pane]").filter({ hasText: title }).first();
const statusOf = (pane) => pane.locator("aside.notes footer [role=status]").innerText().then((s) => s.replace(/\s+/g, " ").trim());
async function openNotes(page, pane) {
  if (await pane.locator("aside.notes textarea").count()) return;
  await pane.getByRole("button", { name: "Bot menu" }).click();
  await page.getByRole("menuitem", { name: /^Notes/ }).first().click();
  await pane.locator("aside.notes textarea").waitFor({ timeout: 8000 });
}

try {
  // ---------- sidebar: the labels are claims about the clock -------------------------------
  {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
    await page.goto(base);
    await page.waitForTimeout(2500);
    const t0 = Date.now();
    const timeline = { "clock30 row": [], "clock2m row": [] };
    const lies = [];
    const u30Start = updatedAt("s-clock30");
    for (let i = 0; i < 33; i++) {
      for (const [id, title] of S.slice(0, 3)) {
        const label = await rowLabel(page, title);
        const realAge = (Date.now() - updatedAt(id)) / 1000;
        if (label === null) { if (i === 0) lies.push(`${title}: no aparece en la barra lateral`); continue; }
        if (!honest(label, realAge)) lies.push(`t+${((Date.now() - t0) / 1000).toFixed(1)}s ${title}: dice "${label}" con edad real ${realAge.toFixed(1)}s`);
        if (timeline[title] && timeline[title][timeline[title].length - 1]?.[1] !== label) timeline[title].push([Date.now() - t0, label]);
      }
      await page.waitForTimeout(2000);
    }
    const u30End = updatedAt("s-clock30");
    for (const [k, v] of Object.entries(timeline)) showTimeline(k, v);
    console.log(`  updated_at s-clock30 al principio/final: ${updatedAt("s-clock30")} / ${u30End}  (drift=${u30End - updatedAt("s-clock30") + 0})`);
    check("sidebar: every age claim is honest at every sample (3 sessions, 66 s)", lies.length === 0, lies.slice(0, 4).join(" | "));
    check("sidebar: labels MOVE with the clock (clock30 crosses its minute)", (timeline["clock30 row"]?.length ?? 0) >= 2, `cambios=${timeline["clock30 row"]?.length ?? 0}`);
    check("sidebar: labels MOVE with the clock (clock2m crosses its minute)", (timeline["clock2m row"]?.length ?? 0) >= 2, `cambios=${timeline["clock2m row"]?.length ?? 0}`);
    await page.screenshot({ path: join(outDir, "sidebar.png") }).catch(() => {});
    await ctx.close();
  }

  // ---------- notes: the "Saved Ns ago" line is a claim about the clock --------------------
  {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
    await page.goto(base);
    await page.waitForTimeout(1500);
    await page.locator("section[data-pane]").first().click({ position: { x: 150, y: 150 } });
    await page.waitForTimeout(250);
    await page.locator("aside").first().getByRole("button", { name: /clocknote row/ }).first().click();
    await page.waitForTimeout(900);
    const p = paneOf(page, "clocknote row");
    await openNotes(page, p);
    await p.locator("aside.notes textarea").fill("a real save, watched against the wall clock");
    const landed = Date.now();
    for (let i = 0; i < 80 && stored("s-clocknote") === ""; i++) await Bun.sleep(100);
    const savedAt = Date.now();
    const seen = [];
    let last = null;
    const lies = [];
    for (let i = 0; i < 80; i++) {
      const line = await statusOf(p).catch(() => "");
      const realAge = (Date.now() - savedAt) / 1000;
      if (line !== last) { last = line; seen.push([Date.now() - landed, line]); }
      if (/^(Saved|Saved \d+[sm] ago)$/.test(line) && !honest(line, realAge)) lies.push(`t+${((Date.now() - landed) / 1000).toFixed(1)}s dice "${line}" con edad real ${realAge.toFixed(1)}s`);
      await page.waitForTimeout(500);
    }
    showTimeline("notes", seen);
    check("notes: every \"Saved …\" claim is honest at every sample (40 s)", lies.length === 0, lies.slice(0, 4).join(" | "));
    check("notes: the line MOVES with the clock (no 15 s steps)", seen.length >= 8, `cambios=${seen.length} en 40s`);
    await p.screenshot({ path: join(outDir, "notes.png") }).catch(() => {});
    await ctx.close();
  }

  // ---------- skew: a wrong device clock must not become a wrong age -----------------------
  for (const [name, off] of [["ahead", 10 * 60_000], ["behind", -10 * 60_000]]) {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.addInitScript(`(() => { const real = Date.now.bind(Date); Date.now = () => real() + ${off}; })();`);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
    await page.goto(base);
    await page.waitForTimeout(1500);
    await page.locator("section[data-pane]").first().click({ position: { x: 150, y: 150 } });
    await page.waitForTimeout(250);
    await page.locator("aside").first().getByRole("button", { name: /clocknote row/ }).first().click();
    await page.waitForTimeout(900);
    const p = paneOf(page, "clocknote row");
    await openNotes(page, p);
    await p.locator("aside.notes textarea").fill(`saved with the device clock ${name} by 10 min`);
    for (let i = 0; i < 80 && !(stored("s-clocknote") ?? "").includes(name); i++) await Bun.sleep(100);
    const savedAt = Date.now();
    const lies = [];
    for (let i = 0; i < 16; i++) {
      const line = await statusOf(p).catch(() => "");
      const realAge = (Date.now() - savedAt) / 1000;
      if (/^(Saved|Saved \d+[sm] ago)$/.test(line) && !honest(line, realAge)) lies.push(`t+${((Date.now() - savedAt) / 1000).toFixed(1)}s "${line}" con edad real ${realAge.toFixed(1)}s`);
      const label = await rowLabel(page, "clock30 row");
      const rowAge = (Date.now() - updatedAt("s-clock30")) / 1000;
      if (label && !honest(label, rowAge)) lies.push(`barra lateral: "${label}" con edad real ${rowAge.toFixed(1)}s`);
      await page.waitForTimeout(500);
    }
    check(`skew (reloj del navegador 10 min ${name}): las edades siguen siendo ciertas`, lies.length === 0, lies.slice(0, 3).join(" | "));
    await ctx.close();
  }

  // ---------- elapsed: a running turn's counter advances ----------------------------------
  {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
    await page.goto(base);
    await page.waitForTimeout(1500);
    await page.locator("section[data-pane]").first().click({ position: { x: 150, y: 150 } });
    await page.waitForTimeout(250);
    // A turn that really runs (the fake agent holds for 30 s): created through the same route the
    // UI's "new chat" uses, named so its row can be clicked open and its header read.
    const created = await (await fetch(`${base}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: "/tmp", model: "deepseek/deepseek-chat", task: "run for a while" }) })).json();
    await fetch(`${base}/api/sessions/${created.id}/title`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "clockrun live" }) });
    await page.waitForTimeout(1500);
    await page.locator("aside").first().getByRole("button", { name: /clockrun live/ }).first().click();
    await page.waitForTimeout(600);
    const p = paneOf(page, "clockrun live");
    const readElapsed = () => p.locator("header span.tnum").allInnerTexts().then((xs) => xs.map((x) => x.trim()).find((x) => /^\d+(h \d+)?m( \d+s)?$|^\d+s$/.test(x)) ?? null);
    const until = async (cond, ms = 10_000) => { const end = Date.now() + ms; while (!(await cond()) && Date.now() < end) await Bun.sleep(200); return cond(); };
    await until(async () => (await readElapsed()) !== null, 12_000);
    const samples = [];
    for (let i = 0; i < 12; i++) { samples.push([Date.now(), await readElapsed()]); await page.waitForTimeout(1000); }
    const parsed = samples.map(([t, s]) => [t, s === null ? null : (claimWindow(s)?.[0] ?? null)]);
    const withVals = parsed.filter(([, v]) => v !== null);
    console.log(`  elapsed en carrera: ${withVals.map(([, v]) => `${v}s`).join(" -> ")}`);
    // Honesty: the counter names an age; the turn's start came back from the server when it began.
    const startedAt = created.startedAt || created.createdAt;
    const lies = [];
    for (const [t, label] of samples) {
      if (label === null) continue;
      const realAge = (t - startedAt) / 1000;
      if (!honest(label, realAge)) lies.push(`"${label}" con edad real ${realAge.toFixed(1)}s`);
    }
    check("elapsed: every claim of the running counter is honest", lies.length === 0, lies.slice(0, 3).join(" | "));
    // Movement: the counter must advance with the wall clock, not sit where it first landed.
    let drift = 0;
    if (withVals.length >= 2) {
      const dt = (withVals[withVals.length - 1][0] - withVals[0][0]) / 1000;
      const dv = withVals[withVals.length - 1][1] - withVals[0][1];
      drift = Math.abs(dv - dt);
    }
    check("elapsed: el contador de un turno en carrera avanza con el reloj", withVals.length >= 4 && drift <= TOL, `muestras=${withVals.length}, deriva total=${drift.toFixed(1)}s`);
    await p.screenshot({ path: join(outDir, "elapsed.png") }).catch(() => {});
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
