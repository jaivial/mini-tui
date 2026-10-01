// Screenshots of panes and windows for the README and the landing page:
//   bun run build && bun scripts/windows-shots.mjs [outDir]
// Serves the built app and mocks /api, the session sockets and the hub socket with invented,
// public-safe data. No real path, host, key or session ever reaches an image. The shared workspace
// (windows and panes) is the mock hub's answer to `ws.watch`, the same message the real server sends.
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";

const out = process.argv[2] ?? "docs/screenshots";
const PORT = 4385 + Math.floor(Math.random() * 300);
mkdirSync(out, { recursive: true });
const now = Date.now();

// Six invented sessions, each with a short, believable transcript.
const S = (id, title, cwd, status, task, steps, answer, extra = {}) => ({
  meta: { id, title, cwd, model: "cliproxy/claude-sonnet-5-5", task, createdAt: now - 5400e3, updatedAt: now - 20e3, apiCalls: 6, cost: 0.08, exitStatus: status === "done" ? "Submitted" : "", target: "local", status, startedAt: status === "running" ? now - 41e3 : now - 900e3, info: { cost: 0.08, apiCalls: 6 }, messages: [], ...extra },
  events: [
    { type: "task", text: task },
    ...steps.flatMap(([cmd, outp], i) => [
      { type: "tool_call", id: `${id}c${i}`, name: "bash", command: cmd },
      { type: "observation", toolCallId: `${id}c${i}`, returncode: 0, output: outp, exceptionInfo: "" },
    ]),
    ...(answer ? [{ type: "assistant", text: answer }] : []),
  ],
});
const sessions = [
  S("s1", "Add retry with backoff to the upload client", "~/projects/upload-client", "running", "Add a retry with backoff to the upload client and cover it with a test",
    [["rg -n 'fetch\\(' src/upload.ts", "src/upload.ts:41:  const res = await fetch(url, init);"], ["bun test tests/upload.test.ts", "4 pass\n0 fail"]], ""),
  S("s2", "Migrate the settings page to the new form", "~/projects/dashboard", "done", "Migrate the settings page to the new form components",
    [["rg -l 'LegacyForm' src", "src/routes/settings/+page.svelte"], ["bun run check", "0 errors and 0 warnings"]], "Done. The settings page uses `Field` and `FieldGroup` now, and the old form is gone.\n\n- validation messages moved to `FieldDescription`\n- `bun run check` is clean"),
  S("s3", "Profile the slow search endpoint", "~/projects/api", "running", "The search endpoint takes 2s on large accounts. Find out why.",
    [["psql -c 'EXPLAIN ANALYZE SELECT …'", "Seq Scan on documents  (cost=0.00..48211.20)\nExecution Time: 1874.3 ms"]], ""),
  S("s4", "Write the release notes for 2.4", "~/projects/api", "done", "Write the release notes for 2.4 from the merged pull requests",
    [["gh pr list --state merged --limit 30", "#412 Faster search on large accounts\n#409 Webhook retries\n#405 Audit log export"]], "Release notes written to `CHANGELOG.md`: three features, two fixes, one breaking change called out at the top."),
  S("s5", "Fix the flaky reconnect test", "~/projects/realtime", "running", "tests/reconnect.test.ts fails one run in ten. Make it deterministic.",
    [["bun test tests/reconnect.test.ts --rerun-each 20", "19 pass\n1 fail: timed out after 5000ms"]], ""),
  S("s6", "Add dark mode to the marketing site", "~/projects/site", "idle", "Add a dark mode toggle to the marketing site",
    [["rg -n 'prefers-color-scheme' src", "src/app.css:12:@media (prefers-color-scheme: dark) {"]], "The site follows the system theme now, and a toggle in the header overrides it."),
];
const meta = sessions.map((s) => s.meta);
const byId = Object.fromEntries(sessions.map((s) => [s.meta.id, s]));

// The shared workspace: three windows. "Backend" is on screen with four panes.
const pane = (sessionId, extra = {}) => ({ sessionId, notesOpen: false, sideTab: "notes", liveTurn: null, seenTurn: null, ...extra });
const split = (id, dir, a, b, ratio = 0.5) => ({ kind: "split", id, dir, ratio, a, b });
const leaf = (id) => ({ kind: "pane", id });
const workspace = {
  version: 7,
  updatedAt: now,
  doc: {
    windows: { v: 1, list: [{ id: "wa", name: "Backend" }, { id: "wb", name: "Frontend" }, { id: "wc", name: "Release" }], active: "wa" },
    panes: {
      v: 2,
      byWindow: {
        // Backend: 2x2. The finished one is "done" (its turn ended and the pane was not clicked since).
        wa: { tree: split("a0", "row", split("a1", "col", leaf("pa1"), leaf("pa2")), split("a2", "col", leaf("pa3"), leaf("pa4"))), panes: { pa1: pane("s1"), pa2: pane("s3"), pa3: pane("s4", { liveTurn: byId.s4.meta.startedAt }), pa4: pane("s5") }, focused: "pa1" },
        wb: { tree: split("b0", "row", leaf("pb1"), leaf("pb2"), 0.55), panes: { pb1: pane("s2", { liveTurn: byId.s2.meta.startedAt }), pb2: pane("s6") }, focused: "pb1" },
        wc: { tree: leaf("pc1"), panes: { pc1: pane(null) }, focused: "pc1" },
      },
    },
    sidebar: { view: "recent", pinned: [], expanded: {} },
  },
};

function chrome() { const r = `${homedir()}/.cache/ms-playwright`; for (const d of readdirSync(r).filter((d) => d.startsWith("chromium-")).sort().reverse()) { const b = `${r}/${d}/chrome-linux64/chrome`; if (existsSync(b)) return b; } }
const server = spawn("bunx", ["vite", "preview", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { stdio: "ignore", cwd: import.meta.dir + "/.." });
for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }
const browser = await chromium.launch({ executablePath: chrome() });

async function open(w, h, scheme, mobile) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, hasTouch: mobile, isMobile: mobile, colorScheme: scheme });
  await ctx.addInitScript((t) => { localStorage.clear(); localStorage.setItem("minitui.theme", t); }, scheme);
  const page = await ctx.newPage();
  await page.route("**/api/**", (route) => {
    const p = new URL(route.request().url()).pathname; const j = (b) => route.fulfill({ contentType: "application/json", body: JSON.stringify(b) });
    if (p === "/api/stream") return route.fulfill({ contentType: "text/event-stream", body: ": ok\n\n" });
    if (p === "/api/sessions") return j(meta);
    const one = p.match(/^\/api\/sessions\/([^/]+)$/); if (one && byId[one[1]]) return j({ ...byId[one[1]].meta, events: byId[one[1]].events });
    if (p === "/api/settings") return j({ outputMode: "collapsed", theme: "shadcn", lastModel: "cliproxy/claude-sonnet-5-5", outputModes: [] });
    return j([]);
  });
  // Each session's own socket: its snapshot.
  await page.routeWebSocket(/\/api\/sessions\/[^/]+\/socket/, (ws) => {
    const id = ws.url().match(/sessions\/([^/]+)\/socket/)[1];
    const s = byId[id]; if (s) ws.send(JSON.stringify({ t: "snapshot", id, session: { ...s.meta, events: s.events } }));
  });
  // The hub: answers ws.watch with the workspace, and every note watch with an empty note.
  await page.routeWebSocket(/\/api\/hub/, (ws) => {
    ws.send(JSON.stringify({ t: "hello", limits: { noteMax: 100000 } }));
    ws.onMessage((raw) => {
      const m = JSON.parse(String(raw));
      if (m.t === "ws.watch") ws.send(JSON.stringify({ t: "ws", workspace }));
      else if (m.t === "ws.save") ws.send(JSON.stringify({ t: "ws.saved", req: m.req, version: workspace.version + 1 }));
      else if (m.t === "note.watch") ws.send(JSON.stringify({ t: "note", note: { id: m.id, body: "", updatedAt: 0 } }));
      else if (m.t === "ping") ws.send(JSON.stringify({ t: "pong" }));
    });
  });
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForTimeout(1600);
  return { ctx, page };
}
async function shot(page, name, expect = []) {
  const text = await page.evaluate(() => document.body.innerText);
  for (const needle of expect) if (!text.toLowerCase().includes(needle.toLowerCase())) throw new Error(`${name}: expected "${needle}" on screen`);
  if (/Could not|Error|undefined|NaN/.test(text)) throw new Error(`${name}: an error string is on screen: ${text.match(/Could not[^\n]*|Error[^\n]*|undefined|NaN/)?.[0]}`);
  // What was on screen, as text, so a run can be checked without opening the image.
  const layout = await page.evaluate(() => ({
    panes: [...document.querySelectorAll("section[data-pane]")].map((e) => { const b = e.getBoundingClientRect(); return `${e.getAttribute("aria-label")} @${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}`; }),
    windows: [...document.querySelectorAll('aside [role="radiogroup"][aria-label="Window to show"] [role="radio"]')].map((e) => `${e.innerText.split("\n")[0]}${e.getAttribute("aria-checked") === "true" ? "*" : ""} [${[...e.querySelectorAll(".dot")].map((d) => d.dataset.status).join(",")}]`),
    menu: [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((e) => e.innerText.split("\n")[0]),
  }));
  console.log(name, JSON.stringify(layout));
  await page.screenshot({ path: `${out}/${name}.png` });
}

try {
  // A wide screen: four panes in the "Backend" window, three windows in the sidebar with their dots.
  let { ctx, page } = await open(1680, 1000, "dark", false);
  const panes = await page.locator("section[data-pane]").count();
  if (panes !== 4) throw new Error(`web-panes: expected 4 panes on screen, got ${panes}`);
  await shot(page, "web-panes", ["Backend", "Frontend", "Release", "Profile the slow search endpoint", "Write the release notes"]);
  // The pane menu: move a pane to another window.
  await page.locator("section[data-pane]").nth(3).getByRole("button", { name: "Pane menu" }).click();
  await page.waitForTimeout(400);
  await shot(page, "web-move-pane", ["Move to window", "Frontend", "New window"]);
  await ctx.close();
  // A phone: the same workspace (shared), the panes as tabs and the window list in the drawer.
  ({ ctx, page } = await open(390, 844, "dark", true));
  await page.getByRole("button", { name: "Toggle sidebar" }).first().tap();
  await page.waitForTimeout(500);
  await shot(page, "web-phone-windows", ["Backend", "Frontend", "Release"]);
  await ctx.close();
} finally { await browser.close(); server.kill(); }
console.log("wrote", out);
