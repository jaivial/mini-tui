// v5-C QA round: one harness that drives the real app in a real browser and asserts on the live
// DOM, area by area — attachments and lightbox, the WhatsApp mirror, generative UI, collapsible
// tool cards (state, args, output, copy, auto-expand on error, huge-output trimming), both colour
// modes, session renaming, the bots sidebar, the prompt bar, the voice recorder, and the palette.
//
//   cd web && bun run build && bun run e2e-qa-v5
//
// It starts its own server on a private port with a temp database and a stub agent (no model, no
// network), seeds transcripts for each area, and takes a screenshot per state. Every screenshot
// DECLARES its own mode + viewport in the filename and each context is created with that viewport,
// so nothing is silently re-laid-out by the capture step. Screenshots land in
// $QA_SHOTS (default web/qa-shots); the port is $QA_PORT (default 4319).
//
// Browser: $CHROME_BIN, else /opt/google/chrome/chrome when present (the snap chromium exits 21 on
// some boxes), else the Playwright download the other e2e scripts use.
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import { existsSync as fileExists, readdirSync } from "node:fs";
import { homedir } from "node:os";
function chromePath() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  if (fileExists("/opt/google/chrome/chrome")) return "/opt/google/chrome/chrome";
  const dir = join(homedir(), ".cache", "ms-playwright");
  if (!fileExists(dir)) return undefined;
  for (const d of readdirSync(dir).filter((x) => x.startsWith("chromium-")).sort().reverse()) {
    const b = join(dir, d, "chrome-linux64", "chrome");
    if (fileExists(b)) return b;
  }
  return undefined;
}
const CHROME = chromePath();
const root = join(import.meta.dir, "..", "..");
const dir = mkdtempSync(join(tmpdir(), "v5qa-"));
const dbPath = join(dir, "sessions.db");
// A stub "agent": it records what it was asked and journals a canned reply, exactly like the
// project's own test helper (tests/helpers/fake-agent.ts). Nothing here needs a model or a network.
const { makeFakeAgent } = await import(join(root, "tests/helpers/fake-agent.ts"));
const stubPath = makeFakeAgent(join(dir, "bin"), { holdMs: 200 }).script;
const shots = process.env.QA_SHOTS ?? join(root, "web", "qa-shots");
mkdirSync(shots, { recursive: true });
mkdirSync(join(dir, "att"), { recursive: true });
mkdirSync(join(dir, "skills"), { recursive: true });
const PORT = Number(process.env.QA_PORT ?? 4319);
const base = `http://127.0.0.1:${PORT}`;

// ---------------------------------------------------------------- real bytes, built by hand
function crc32(buf) {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3);
    raw[row] = 0;
    for (let x = 0; x < w; x++) { raw[row + 1 + x * 3] = r; raw[row + 2 + x * 3] = g; raw[row + 3 + x * 3] = b; }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function wav(seconds = 0.4) {
  const rate = 8000, n = Math.floor(rate * seconds);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(2000 * Math.sin((i / rate) * 2 * Math.PI * 440)), i * 2);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVE", 8);
  head.write("fmt ", 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write("data", 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

const env = {
  ...process.env,
  MINITUI_DB_PATH: dbPath, MINITUI_CONFIG_DIR: dir, MINITUI_ATTACHMENTS_DIR: join(dir, "att"),
  MINITUI_LAST_MODEL_PATH: join(dir, "last-model.json"), MINITUI_CONNECTIONS_PATH: join(dir, "providers.json"),
  MINITUI_SETTINGS_PATH: join(dir, "settings.json"), MINITUI_SKILLS_DIR: join(dir, "skills"),
  MINITUI_RESUME_DIR: join(dir, "resume"), MINITUI_RUNS_DIR: join(dir, "runs"),
  MINITUI_WEB_SYNC_MS: "300", MINITUI_EMBEDDED_AGENT: "0", MINITUI_MINI_BIN: stubPath,
};
const server = spawn("bun", ["src/web/serve.ts", "--port", String(PORT)], { cwd: root, stdio: ["ignore", "pipe", "pipe"], env });
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
let up = false;
for (let i = 0; i < 80 && !up; i++) {
  // The health answer must be THIS app: mini-tui's carries a numeric `sessions`.
  // (Port 4321 on this box answers with evo-weai's health JSON, so a bare .ok check would pass.)
  try { const h = await (await fetch(`${base}/api/health`)).json(); up = typeof h.sessions === "number"; } catch {}
  if (!up) await Bun.sleep(100);
}
if (!up) { console.log("FAIL the QA server never came up\n" + serverLog.slice(-2000)); server.kill(); process.exit(1); }

async function upload(name, bytes) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: name.endsWith(".png") ? "image/png" : "audio/wav" }), name);
  const res = await fetch(`${base}/api/attachments`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`upload ${name}: ${res.status} ${await res.text()}`);
  return res.json();
}
const pngA = await upload("grafico-plata.png", png(160, 120, [203, 208, 212]));
const pngB = await upload("segundo.png", png(120, 120, [17, 20, 25]));
const voice = await upload("nota-de-voz-qa.wav", wav());

const { createSession, openDb, saveTranscript } = await import(join(root, "src/sessions.ts"));
const db = openDb(dbPath);
const seed = (id, title, events, info = { cost: 0.01, apiCalls: 1, exitStatus: "Submitted" }) => {
  createSession(db, { id, cwd: "/home/jaime", model: "opencode-go/deepseek-v4.1-flash", task: title, title });
  // A saved conversation too, so the session is resumable: sending a message continues it through
  // the stub agent instead of being refused with "no saved conversation" (which the form-submit
  // check needs, and which is what a real session always has).
  saveTranscript(db, id, events, info, [
    { role: "system", content: "system" },
    { role: "user", content: title },
    { role: "assistant", content: "ok" },
  ]);
};

seed("s-att", "Attachments and lightbox", [
  { type: "task", text: "mira estas imágenes", attachments: [
    { id: pngA.id, kind: "image", mime: pngA.mime, url: pngA.url, name: pngA.name },
    { id: voice.id, kind: "audio", mime: voice.mime, url: voice.url, name: voice.name },
  ] },
  { type: "assistant", text: `Aquí están:\n\n![grafico plata](${pngA.url})\n\n![segundo](${pngB.url})\n` },
  { type: "exit", exitStatus: "Submitted", submission: "ok" },
]);
seed("s-tool", "Tool cards", [
  { type: "task", text: "arregla el bug de login" },
  { type: "tool_call", id: "c1", name: "bash", command: "rg -n 'login' src/ | head -20" },
  { type: "observation", toolCallId: "c1", returncode: 0, output: "src/auth.ts:42: export function login() {}\nsrc/auth.ts:88: const login = ...\n", exceptionInfo: "" },
  { type: "tool_call", id: "c2", name: "bash", command: "bun test src/auth.test.ts" },
  { type: "observation", toolCallId: "c2", returncode: 1, output: "1 pass\n2 fail\n\nFAIL src/auth.test.ts > rejects a bad token\n  Expected: 401\n  Received: 500\n", exceptionInfo: "" },
  { type: "assistant", text: "El test viejo ya no aplica, lo reescribo." },
  { type: "exit", exitStatus: "Submitted", submission: "done" },
]);
seed("s-ui", "Generative UI", [
  { type: "task", text: "dame el informe" },
  { type: "ui-component", template: "card", props: { title: "Informe de la semana", body: "3 sesiones, 12 tareas.", tone: "info" } },
  { type: "ui-component", template: "table", props: { columns: ["Sesión", "Coste", "Estado"], rows: [["s-alpha", "0.01", "ok"], ["s-beta", "0.42", "lento"]] } },
  { type: "ui-component", template: "chart", props: { kind: "bar", title: "Coste por día", labels: ["lun", "mar", "mié"], values: [0.1, 0.4, 0.25], unit: "$" } },
  // A chart with no `kind`: validateChart says no, and the component must show its quiet notice.
  { type: "ui-component", template: "chart", props: { title: "Roto", labels: ["a", "b"], values: [1, 2] } },
  { type: "ui-component", template: "form", props: { title: "Alta", submitLabel: "Crear", fields: [
    { name: "nombre", label: "Nombre", type: "text", required: true },
    { name: "plan", label: "Plan", type: "select", required: false, options: ["free", "pro"] },
  ] } },
  { type: "ui-component", template: "gallery", props: { title: "Capturas", images: [
    { src: pngA.url, alt: "grafico plata" },
    { src: pngB.url, alt: "segundo" },
  ] } },
  { type: "exit", exitStatus: "Submitted", submission: "ok" },
]);
seed("s-mirror", "Espejo WhatsApp", [
  { type: "task", text: "hola bot" },
  { type: "assistant", text: "Hola, dime." },
  { type: "channel", channel: "whatsapp", origin: "whatsapp", sender: "34600111222@s.whatsapp.net", text: "¿cómo va el deploy?", ts: Date.now(), mirrorId: 7, attachments: [] },
  { type: "exit", exitStatus: "Submitted", submission: "ok" },
]);
seed("s-big", "Long tools", [
  { type: "task", text: "inspecciona el repo" },
  { type: "tool_call", id: "b1", name: "bash", command: "cat huge.log" },
  { type: "observation", toolCallId: "b1", returncode: 0, output: Array.from({ length: 4000 }, (_, i) => `linea ${i} del registro enorme`).join("\n"), exceptionInfo: "" },
  { type: "exit", exitStatus: "Submitted", submission: "ok" },
]);
seed("s-side-a", "Rename me please", [{ type: "task", text: "trabajo A" }, { type: "assistant", text: "vale" }]);
seed("s-side-b", "Un título razonablemente largo para probar la elipsis de la fila del bot", [{ type: "task", text: "trabajo B" }, { type: "assistant", text: "vale" }]);
db.close();
for (const id of ["s-att", "s-tool", "s-ui", "s-mirror", "s-big", "s-side-a", "s-side-b"]) {
  const r = await fetch(`${base}/api/history/${id}`, { method: "POST" });
  if (!r.ok) console.log(`  [warn] open ${id}: ${r.status}`);
}

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
let failed = 0, passed = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
  if (ok) passed++; else failed++;
};
const until = async (fn, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await Bun.sleep(80); } return false; };
const CONSOLES = [];
// The app's own default is LIGHT (UiStore: dark only on an explicit saved "dark"), and it ignores
// prefers-color-scheme, so a "dark" context must save the choice and reload — otherwise the page is
// light and every dark check silently measures the light palette.
async function open(mode, viewport) {
  const ctx = await browser.newContext({ viewport, colorScheme: mode, reducedMotion: "reduce", permissions: ["microphone", "clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") CONSOLES.push(`[${mode} ${viewport.width}x${viewport.height}] ${m.text().slice(0, 160)}`); });
  page.on("pageerror", (e) => CONSOLES.push(`[${mode} ${viewport.width}x${viewport.height}] pageerror: ${e.message.split("\n")[0].slice(0, 160)}`));
  await page.goto(base);
  await page.waitForTimeout(1200);
  if (mode === "dark") {
    await page.evaluate(() => localStorage.setItem("minitui.theme", "dark"));
    await page.reload();
    await page.waitForTimeout(1400);
  }
  return { ctx, page };
}
const shot = (page, name, mode, viewport) =>
  page.screenshot({ path: join(shots, `${name}__${mode}__${viewport.width}x${viewport.height}.png`) });
async function openBot(page, title) {
  const row = page.locator("aside [role=listitem] button[data-nav]", { hasText: title }).first();
  await row.waitFor({ timeout: 15000 });
  await row.click();
  await page.waitForTimeout(1000);
}
const transcript = (page) => page.locator("main").first();

// robust colour parsing → WCAG contrast, so the audit measures real rendered colours
function parseColor(css) {
  const s = String(css).trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return [0, 1, 2].map((i) => parseInt(m[1][i] + m[1][i], 16));
  m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) { const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) return m[1].split(/[,\s/]+/).filter(Boolean).map(Number).slice(0, 3);
  return null;
}
const lum = ([r, g, b]) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
const contrastOf = async (page, sel) => page.evaluate((s) => {
  let el = document.querySelector(s);
  if (!el) return null;
  const color = getComputedStyle(el).color;
  let bgEl = el;
  while (bgEl) {
    const bg = getComputedStyle(bgEl).backgroundColor;
    if (bg && !/^rgba\(0, 0, 0, 0\)$|transparent/.test(bg)) return { color, bg };
    bgEl = bgEl.parentElement;
  }
  return { color, bg: getComputedStyle(document.body).backgroundColor };
}, sel);

try {
  // ============================================================ A. desktop DARK
  const dview = { width: 1440, height: 900 };
  const { ctx: dctx, page } = await open("dark", dview);

  // ---- (10) palette: silver ramp, never violet
  const tokens = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const g = (n) => cs.getPropertyValue(n).trim();
    return { dark: document.documentElement.classList.contains("dark"), brand: g("--color-brand"), accent: g("--color-accent"), live: g("--color-live"), canvas: g("--color-canvas"), silver300: g("--color-silver-300") };
  });
  const hueOf = ([r, g, b]) => {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (!d) return 0;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return ((h * 60) % 360 + 360) % 360;
  };
  // "Violet" means a hue in the violet band AND enough chroma to actually read as violet: the theme
  // accents keep a whisper of their old hue on purpose (oklch chroma ~0.02 = near-neutral grey).
  const isViolet = (c) => {
    const p = parseColor(c);
    if (!p) return false;
    const h = hueOf(p), chroma = Math.max(...p) - Math.min(...p);
    return h >= 250 && h <= 320 && chroma > 40;
  };
  console.log(`  dark: brand=${tokens.brand} accent=${tokens.accent} live=${tokens.live}`);
  check("(10) dark: brand accent is not violet", !isViolet(tokens.brand), `${tokens.brand} hue ${hueOf(parseColor(tokens.brand))?.toFixed(0)}`);
  check("(10) dark: brand accent IS the silver ramp step", tokens.brand === tokens.silver300, `brand=${tokens.brand} silver-300=${tokens.silver300}`);
  check("(10) dark: no violet left in accent or live", !isViolet(tokens.accent) && !isViolet(tokens.live), `accent=${tokens.accent} live=${tokens.live}`);
  // Every shipped palette, both modes: the violet family is gone (or is a near-neutral grey).
  const paletteAccents = await page.evaluate(async () => {
    const out = [];
    const root = document.documentElement;
    for (const mode of ["light", "dark"]) {
      root.classList.toggle("dark", mode === "dark");
      root.classList.toggle("light", mode === "light");
      for (const name of ["shadcn", "nord", "gruvbox", "dracula", "tokyo", "catppuccin"]) {
        root.dataset.theme = name;
        await new Promise((r) => requestAnimationFrame(r));
        out.push({ mode, name, accent: getComputedStyle(root).getPropertyValue("--color-accent").trim(), brand: getComputedStyle(root).getPropertyValue("--color-brand").trim() });
      }
    }
    root.dataset.theme = "shadcn";
    return out;
  });
  const violets = paletteAccents.filter((p) => isViolet(p.accent) || isViolet(p.brand));
  check("(10) no shipped palette carries a real violet accent, in either mode", violets.length === 0, violets.length ? JSON.stringify(violets) : `${paletteAccents.length} palettes checked (${[...new Set(paletteAccents.map((p) => p.accent))].join(" ")})`);
  const lightBlue = paletteAccents.find((p) => p.mode === "light" && p.name === "shadcn");
  console.log(`  light default accent: ${lightBlue?.brand} (v6-E keeps the light-mode blue on purpose; dark is the silver ramp)`);

  // ---- (7) sidebar: search + bots only
  const aside = page.locator("aside");
  check("(7) sidebar has a Search box and lists bots", (await aside.getByLabel("Search bots").count()) === 1 && (await aside.locator("[role=listitem]").count()) === 7, `${await aside.locator("[role=listitem]").count()} rows`);
  check("(7) no 'Windows' concept anywhere in the sidebar", !/windows/i.test(await aside.innerText()));
  const geom = await page.evaluate(() => {
    const b = document.querySelector("aside [role=listitem] button[data-nav]");
    const card = b?.parentElement;
    return { radius: card ? getComputedStyle(card).borderRadius : "", h: b?.getBoundingClientRect().height, searchRadius: getComputedStyle(document.querySelector("aside input")).borderRadius };
  });
  check("(7) bot rows use 18px radii and a >=44px target", geom.radius === "18px" && geom.h >= 44, JSON.stringify(geom));
  const overflow = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth, bad = [];
    for (const el of document.querySelectorAll("aside *, main *")) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const cs = getComputedStyle(el);
      if (cs.position !== "static" || cs.overflowX === "auto" || cs.overflowX === "scroll") continue;
      if (r.right > vw + 1.5 || r.left < -1.5) bad.push(`${el.tagName}.${String(el.className).slice(0, 40)} ${r.left.toFixed(0)}..${r.right.toFixed(0)} vw=${vw}`);
    }
    return bad.slice(0, 8);
  });
  check("no horizontal clipping of the shell at 1440px", overflow.length === 0, overflow.join(" ;; "));
  // ---- (7) the header's actions live in ONE three-dots menu
  const menuTrigger = page.getByRole("button", { name: "Bot menu" });
  check("(7) the pane header's actions are one three-dots menu button", (await menuTrigger.count()) === 1 && (await menuTrigger.getAttribute("aria-haspopup")) === "menu");
  await menuTrigger.click();
  const menu = page.getByRole("menu");
  check("(7) the menu opens with the workspace rows", await until(async () => (await menu.count()) > 0) && /workspace/i.test(await menu.innerText()), (await menu.innerText().catch(() => "")).replace(/\n/g, "/").slice(0, 160));
  await shot(page, "01-sidebar-and-menu", "dark", dview);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // ---- (5)(10) contrast audit on real rendered colours, dark
  for (const [label, sel] of [["sidebar state line", "aside [role=listitem] .text-ink-muted"], ["sidebar quiet text", "aside [role=listitem] .text-ink-faint"]]) {
    const c = await contrastOf(page, sel);
    const r = c && parseColor(c.color) && parseColor(c.bg) ? ratio(parseColor(c.color), parseColor(c.bg)) : null;
    check(`(5) dark contrast: ${label} reaches AA (>=4.5:1)`, r !== null && r >= 4.5, `${c?.color} on ${c?.bg} = ${r?.toFixed(2)}:1`);
  }

  // ---- (1) attachments + lightbox
  await openBot(page, "Attachments and lightbox");
  const imgs = transcript(page).locator("img.chat-img");
  check("(1) a served image in a bot message renders with the lightbox class", (await imgs.count()) === 2, `${await imgs.count()} images`);
  check("(1) the prompt's audio attachment renders a real player", (await transcript(page).locator("button[aria-label^='Reproducir']").count()) >= 1);
  await shot(page, "02-attachments-inline", "dark", dview);
  await imgs.first().click();
  check("(1) clicking an inline image opens the lightbox", await until(async () => (await page.evaluate(() => document.querySelectorAll("[role=dialog]").length)) > 0));
  await page.waitForTimeout(500);
  const lb = await page.evaluate(() => {
    const d = document.querySelector("[role=dialog]");
    const img = d?.querySelector("img");
    return { label: d?.getAttribute("aria-label"), src: img?.getAttribute("src"), alt: img?.getAttribute("alt"), natural: img ? [img.naturalWidth, img.naturalHeight] : null, buttons: [...(d?.querySelectorAll("button") ?? [])].map((b) => b.getAttribute("aria-label") || b.textContent?.trim()) };
  });
  check("(1) the lightbox shows the SAME image, loaded (naturalWidth > 0)", /\/api\/attachments\//.test(lb.src ?? "") && lb.natural?.[0] > 0, JSON.stringify(lb).slice(0, 260));
  check("(1) the lightbox has a labelled close control", lb.buttons.some((b) => /cerrar|close/i.test(b ?? "")) || !!lb.label, JSON.stringify(lb.buttons));
  await shot(page, "03-lightbox", "dark", dview);
  await page.keyboard.press("Escape");
  check("(1) Escape closes the lightbox", await until(async () => (await page.evaluate(() => document.querySelectorAll("[role=dialog]").length)) === 0));
  const bodyAfter = await page.evaluate(() => getComputedStyle(document.body).overflow);
  check("(1) the page is not left scroll-locked after closing", bodyAfter !== "hidden", `body overflow=${bodyAfter}`);

  // ---- (4) tool cards
  await openBot(page, "Tool cards");
  const cards = await page.evaluate(() => [...document.querySelectorAll("main button[aria-expanded]")].map((b) => ({
    expanded: b.getAttribute("aria-expanded") === "true",
    text: (b.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 90),
    state: b.querySelector("svg[aria-label]")?.getAttribute("aria-label") ?? "",
  })));
  console.log(`  tool cards: ${JSON.stringify(cards)}`);
  check("(4) both tool calls render one card each", cards.length === 2, `${cards.length} cards`);
  check("(4) each card states its result (OK / Failed)", cards.some((c) => c.state === "OK") && cards.some((c) => c.state === "Failed"), cards.map((c) => c.state).join(","));
  check("(4) the FAILED card auto-expands", cards.some((c) => c.state === "Failed" && c.expanded));
  check("(4) the successful card stays collapsed", cards.filter((c) => c.state === "OK").every((c) => !c.expanded));
  const failedIdx = cards.findIndex((c) => c.state === "Failed");
  const body = await page.evaluate((i) => {
    const b = [...document.querySelectorAll("main button[aria-expanded]")][i];
    const wrap = b.parentElement.parentElement;
    const txt = (wrap?.textContent ?? "").replace(/\s+/g, " ");
    return { text: txt.slice(0, 400), buttons: wrap ? [...wrap.querySelectorAll("button")].map((x) => (x.textContent ?? "").trim()) : [], hasArgs: /Args/i.test(txt), hasExit: /exit 1/.test(txt) };
  }, failedIdx);
  check("(4) the failed card's body carries arguments, output and exit code", body.hasArgs && /Expected: 401/.test(body.text) && body.hasExit, body.text.slice(0, 200));
  check("(4) the body offers a copy button for args and output", body.buttons.filter((b) => /Copy|Copied/.test(b)).length >= 2, JSON.stringify(body.buttons));
  const copyBtn = transcript(page).locator("button:has-text('Copy')").first();
  if (await copyBtn.count()) {
    await copyBtn.click({ force: true });
    check("(4) a tool card's Copy button flips to Copied", await until(async () => /Copied/.test(await transcript(page).innerText()), 2500));
  } else check("(4) a tool card's Copy button exists", false, "none found");
  await shot(page, "04-toolcards", "dark", dview);

  // ---- (4b) a long output is bounded, with its tail and a line count
  await openBot(page, "Long tools");
  // The card is collapsed (rc=0): open it the way a person does, then measure.
  await transcript(page).locator("button[aria-expanded='false']").first().click();
  await page.waitForTimeout(900);
  const big = await page.evaluate(() => {
    // The card's body holds TWO pres (the command under "Args", the result under "Output"); the one
    // to measure is the output, which is the one carrying the last line of the log.
    const pres = [...document.querySelectorAll("main pre")];
    const pre = pres.find((p) => /linea 3999/.test(p.textContent ?? "")) ?? pres[pres.length - 1];
    const card = pre?.closest("div.overflow-hidden") ?? document.querySelector("main");
    return { all: pres.length, lines: (pre?.textContent ?? "").split("\n").length, head: (card?.textContent ?? "").replace(/\s+/g, " ").slice(0, 200), overflow: pre ? getComputedStyle(pre).overflowY : "", truncated: /lines hidden|output truncated/.test(document.querySelector("main")?.textContent ?? "") };
  });
  // A 4000-line log is bounded TWICE on purpose: the server keeps at most OUTPUT_MAX_CHARS of it
  // (src/traj/slim.ts, the 2026-10-05 OOM fix) and says how much it dropped, and the card shows the
  // last 200 lines of what it has. Both halves are asserted: the trim, and that it is not silent.
  check("(4) a huge output is bounded and the reader is told what was dropped", big.truncated, JSON.stringify(big).slice(0, 200));
  check("(4) the card shows only the last 200 lines, and says the real total", big.lines === 200 && /last 200 of \d+ lines/.test(big.head), JSON.stringify(big).slice(0, 240));
  check("(4) the trimmed output scrolls instead of growing the row", big.overflow === "auto", big.overflow);
  await shot(page, "05-long-output", "dark", dview);

  // ---- (4c) the turn copy button (regression: copiedId was a plain `let`, never reactive)
  await openBot(page, "Espejo WhatsApp");
  const turnCopy = transcript(page).locator("button[aria-label='Copiar respuesta']").first();
  await turnCopy.scrollIntoViewIfNeeded();
  await turnCopy.click({ force: true });
  const reacted = await until(async () => {
    const svg = await page.evaluate(() => document.querySelector("button[aria-label='Copiar respuesta'] svg")?.outerHTML ?? "");
    return !/lucide-copy/.test(svg);
  }, 2500);
  check("(4) a turn's copy button shows its copied state (check icon)", reacted, reacted ? "" : "the icon never left the copy glyph");
  if (reacted) {
    const reverted = await until(async () => /lucide-copy/.test(await page.evaluate(() => document.querySelector("button[aria-label='Copiar respuesta'] svg")?.outerHTML ?? "")), 3000);
    check("(4) ...and the copied state clears after ~1.5s", reverted);
  }

  // ---- (2) the WhatsApp mirror renders as its own bubble
  const mirrorText = await transcript(page).innerText();
  check("(2) a mirrored WhatsApp message renders with its sender", /¿cómo va el deploy\?/.test(mirrorText) && /34600111222/.test(mirrorText), mirrorText.replace(/\n/g, " / ").slice(0, 160));
  check("(2) the mirrored bubble carries its origin marker (.wa-mirror)", await page.evaluate(() => !!document.querySelector(".wa-mirror")));
  await shot(page, "06-mirror-bubble", "dark", dview);

  // ---- (6) rename from the sidebar, and the server agrees
  await openBot(page, "Rename me please");
  const renameRow = page.locator("aside [role=listitem]", { hasText: "Rename me please" }).first();
  await renameRow.locator("button[aria-label^='Rename']").click();
  const titleInput = page.getByLabel("Bot title");
  await titleInput.waitFor();
  await titleInput.fill("Renombrado por QA");
  await titleInput.press("Enter");
  await page.waitForTimeout(800);
  const serverTitle = (await (await fetch(`${base}/api/history`)).json()).find((r) => r.id === "s-side-a")?.title;
  check("(6) the sidebar rename reaches the server", serverTitle === "Renombrado por QA", `server title=${JSON.stringify(serverTitle)}`);
  check("(6) the sidebar row shows the new name at once", (await aside.innerText()).includes("Renombrado por QA"));
  await shot(page, "07-renamed", "dark", dview);

  // ---- (3) generative UI
  await openBot(page, "Generative UI");
  const ui = await transcript(page).innerText();
  check("(3) a generative form renders its fields and submit", (await transcript(page).locator("input, select").count()) >= 2 && /Crear/.test(ui), `${await transcript(page).locator("input, select").count()} controls`);
  check("(3) a generative table renders its columns and rows", /Sesión/.test(ui) && /s-alpha/.test(ui));
  check("(3) a generative chart renders as an svg plot", (await transcript(page).locator("svg[role=img]").count()) >= 1);
  check("(3) an INVALID chart shows its quiet notice with a reason (never 'undefined')", /Gr[áa]fico no renderizado: chart kind debe ser bar\|line/.test(ui) && !/no renderizado: undefined/.test(ui), ui.split("\n").find((l) => /Gr[áa]fico/.test(l)) ?? "no notice");
  check("(3) a generative gallery renders clickable thumbnails", (await transcript(page).locator("button:has(img)").count()) >= 2);
  await shot(page, "08-genui", "dark", dview);
  const form = transcript(page).locator("form").first();
  if (await form.count()) {
    const before = await transcript(page).locator("div.msg-user").count();
    await form.locator("input[type=text]").fill("Ana");
    await form.locator("button[type=submit], button:has-text('Crear')").first().click();
    const sent = await until(async () => (await page.locator("main").innerText()).includes("Ana"), 3000);
    check("(3) submitting a generated form puts its answer in the chat", sent && (await transcript(page).locator("div.msg-user").count()) > before, `user bubbles ${before} → ${await transcript(page).locator("div.msg-user").count()}`);
  } else check("(3) the generated form is a real form element", false, "no <form>");

  await dctx.close();

  // ============================================================ B. desktop LIGHT
  const { ctx: lctx, page: lp } = await open("light", dview);
  const lt = await lp.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const g = (n) => cs.getPropertyValue(n).trim();
    return { dark: document.documentElement.classList.contains("dark"), brand: g("--color-brand"), silver: g("--color-silver"), silver700: g("--color-silver-700"), canvas: g("--color-canvas"), ink: g("--color-ink"), inkFaint: g("--color-ink-faint") };
  });
  console.log(`  light: brand=${lt.brand} silver=${lt.silver} silver700=${lt.silver700} inkFaint=${lt.inkFaint}`);
  check("(5) light mode is actually light (no .dark class)", !lt.dark, `dark=${lt.dark} canvas=${lt.canvas}`);
  // v6-E keeps the light-mode blue on purpose (its own commit message says so) while the dark
  // accent is the silver ramp. What the checklist asks for is that VIOLET is gone — checked above
  // for every palette in both modes.
  check("(10) light: the default accent is the documented blue, never violet", !isViolet(lt.brand), `brand=${lt.brand} silver-700=${lt.silver700} silver=${lt.silver}`);
  const lc = await contrastOf(lp, "aside [role=listitem] .text-ink-faint");
  check("(5) light contrast: faint sidebar text reaches AA (>=4.5:1)", lc && parseColor(lc.color) && parseColor(lc.bg) ? ratio(parseColor(lc.color), parseColor(lc.bg)) >= 4.5 : false, `${lc?.color} on ${lc?.bg} = ${(lc && parseColor(lc.color) && parseColor(lc.bg)) ? ratio(parseColor(lc.color), parseColor(lc.bg)).toFixed(2) : "?"}:1`);
  await openBot(lp, "Generative UI");
  await shot(lp, "09-genui-light", "light", dview);
  await openBot(lp, "Attachments and lightbox");
  await shot(lp, "10-attachments-light", "light", dview);
  const lightBoxImg = lp.locator("img.chat-img").first();
  if (await lightBoxImg.count()) {
    await lightBoxImg.click();
    await lp.waitForTimeout(500);
    await shot(lp, "11-lightbox-light", "light", dview);
    await lp.keyboard.press("Escape");
  }
  await lctx.close();

  // ============================================================ C. phone (area 7: full screen)
  const pview = { width: 390, height: 844 };
  const { ctx: pctx, page: pp } = await open("dark", pview);
  const pState = await pp.evaluate(() => {
    const a = document.querySelector("aside"), r = a?.getBoundingClientRect();
    return { present: !!a, w: r?.width, h: r?.height, vw: innerWidth, vh: innerHeight };
  });
  console.log(`  phone: ${JSON.stringify(pState)}`);
  const pOverflow = await pp.evaluate(() => {
    const vw = document.documentElement.clientWidth, bad = [];
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const cs = getComputedStyle(el);
      if (cs.position !== "static" || cs.overflowX === "auto" || cs.overflowX === "scroll") continue;
      if (r.right > vw + 1.5) bad.push(`${el.tagName}.${String(el.className).slice(0, 50)} right=${r.right.toFixed(0)} vw=${vw}`);
    }
    return bad.slice(0, 10);
  });
  check("(7) nothing overflows horizontally at 390px", pOverflow.length === 0, pOverflow.join(" ;; "));
  await shot(pp, "12-phone-chat", "dark", pview);
  const toggle = pp.getByRole("button", { name: "Toggle bots list" });
  check("(7) a phone header still offers the bots-list toggle", (await toggle.count()) === 1);
  await toggle.click();
  await pp.waitForTimeout(800);
  const fullAside = await pp.evaluate(() => {
    const a = document.querySelector("aside"), r = a?.getBoundingClientRect();
    return { w: Math.round(r?.width ?? 0), h: Math.round(r?.height ?? 0), vw: innerWidth, vh: innerHeight };
  });
  check("(7) on a phone the sidebar takes the WHOLE screen", fullAside.w === fullAside.vw && fullAside.h >= fullAside.vh - 2, JSON.stringify(fullAside));
  check("(7) the full-screen sidebar has its own close control", (await pp.getByRole("button", { name: "Close the bots list" }).count()) === 1);
  await shot(pp, "13-phone-sidebar-fullscreen", "dark", pview);
  const small = await pp.evaluate(() => {
    const out = [];
    for (const b of document.querySelectorAll("aside button, main button")) {
      const r = b.getBoundingClientRect();
      if (r.width && r.height && (r.width < 24 || r.height < 24)) {
        const cs = getComputedStyle(b);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        out.push(`${(b.getAttribute("aria-label") || b.title || b.textContent || "").trim().slice(0, 24)} ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    return out.slice(0, 8);
  });
  check("(7)(9) every visible control on the phone is at least 24px", small.length === 0, small.join(", "));
  // ---- (8)(9) prompt bar on a phone
  await pp.getByRole("button", { name: "Close the bots list" }).click();
  await pp.waitForTimeout(700);
  const phoneBar = await pp.evaluate(() => ({
    audio: !!document.querySelector("button[aria-label='Grabar nota de voz']"),
    attach: !!document.querySelector("button[aria-label='Adjuntar archivos']"),
    folder: !!document.querySelector("[aria-label*='arpeta' i], [aria-label*='folder' i], [aria-label*='working directory' i], button[title*='arpeta' i]"),
  }));
  check("(8) the prompt bar offers send-audio and send-attachment", phoneBar.audio && phoneBar.attach, JSON.stringify(phoneBar));
  check("(8) the prompt bar has NO working-folder selector", !phoneBar.folder, JSON.stringify(phoneBar));
  await pp.getByRole("button", { name: "Adjuntar archivos" }).click();
  await pp.waitForTimeout(400);
  await shot(pp, "14-phone-attach-menu", "dark", pview);
  await pp.keyboard.press("Escape").catch(() => {});
  // ---- (9) record a note (fake media device), send it, and play it back
  // Two different controls share the name "Grabar nota de voz": the prompt bar's button opens the
  // recorder panel, the recorder's own trigger starts the take. They are told apart by the
  // Control-UI anatomy attributes.
  const openRecorder = pp.locator("button[aria-label='Grabar nota de voz']:not([data-slot='trigger'])").first();
  await openRecorder.click();
  const trigger = pp.locator("[data-control-family=audio-recorder] button[data-slot=trigger]");
  await trigger.waitFor({ timeout: 5000 });
  await trigger.click();
  // The fake device still goes through "requesting" while the permission settles, so wait for the
  // state machine to actually reach `recording` instead of sampling once.
  const started = await until(async () => (await pp.getAttribute("[data-control-family=audio-recorder]", "data-state")) === "recording", 8000);
  const recState = await pp.evaluate(() => {
    const root = document.querySelector("[data-control-family=audio-recorder]");
    return { state: root?.getAttribute("data-state"), txt: (root?.textContent ?? "").replace(/\s+/g, " ").slice(0, 80) };
  });
  check("(9) pressing record starts the recorder (it reaches 'recording')", started && recState.state === "recording", JSON.stringify(recState));
  await shot(pp, "15-phone-recording", "dark", pview);
  await pp.waitForTimeout(1400); // let the take grow so its duration is non-zero
  const grew = await pp.evaluate(() => (document.querySelector("[data-slot=duration]")?.textContent ?? "").trim());
  check("(9) the recorder counts the take up as it records", /0:0[1-9]/.test(grew), `duration=${grew}`);
  await pp.getByRole("button", { name: "Enviar la nota de voz" }).click();
  const chip = await until(async () => (await pp.locator("ul[aria-label='Archivos adjuntos'] li").count()) > 0, 8000);
  const chipText = await pp.locator("ul[aria-label='Archivos adjuntos'] li").first().innerText().catch(() => "");
  check("(9) the finished take lands in the prompt bar as a real attachment chip", chip && /nota-de-voz/i.test(chipText), chipText.replace(/\n/g, " "));
  await shot(pp, "16-phone-voice-chip", "dark", pview);
  // send it: the server must receive an audio attachment and the bubble must offer a player
  await pp.getByLabel("Prompt").fill("escucha esto");
  const posted = [];
  pp.on("request", (r) => { if (r.url().includes("/api/sessions") && r.method() === "POST") posted.push(r.postData() ?? ""); });
  await pp.getByRole("button", { name: "Send message" }).click();
  const played = await until(async () => (await pp.locator("main button[aria-label^='Reproducir']").count()) > 0, 12000);
  check("(9) the sent voice note renders a player in the bubble", played, `${await pp.locator("main button[aria-label^='Reproducir']").count()} players`);
  // The request carries the uploaded file by id (the recorded take is a .webm container, so its
  // stored mime is video/webm: the server tells audio from video by the `nota-de-voz-*` name, and
  // the fact that a PLAYER rendered above is what proves it was classified as audio).
  check("(9) the prompt carried the recorded take as an attachment", posted.some((p) => /nota-de-voz/.test(p) && /"attachments"/.test(p) && /"id":"[0-9a-f]{16}"/.test(p)), posted[0]?.slice(0, 200) ?? "no POST seen");
  await shot(pp, "17-phone-voice-sent", "dark", pview);
  await pctx.close();
} catch (e) {
  console.log("FAIL  the run threw:", (e?.stack ?? String(e)).split("\n").slice(0, 4).join("\n"));
  failed++;
} finally {
  await browser.close().catch(() => {});
  server.kill();
  const distinct = [...new Set(CONSOLES)];
  // Nothing is allowed to be noisy here: the Svelte effect loop that used to fire on every voice
  // note (AudioVisualizer's `previousSample`) is fixed on main (#232), and with it in place this
  // harness must see a completely clean console in every mode and viewport.
  if (distinct.length) {
    console.log("\nconsole/page errors:");
    for (const c of distinct) console.log("  " + c);
  }
  check("no console or page errors anywhere in the run", distinct.length === 0, distinct.length ? `${distinct.length} distinct` : "clean");
  console.log(`\nshots in ${shots}`);
  console.log(`\n${failed ? `${failed} check(s) FAILED` : "all checks passed"} (${passed} passed)`);
  console.log(`server log tail: ${serverLog.split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 300)}`);
  process.exit(failed ? 1 : 0);
}
