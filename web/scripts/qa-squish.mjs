// Squishmoji QA: client-side rendering, live expression changes, seed stability. Run: bun scripts/qa-squish.mjs
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const dir = mkdtempSync(join(tmpdir(), "minitui-squish-"));
const PORT = 4700 + Math.floor(Math.random() * 200);
const SHOTS = "/tmp/qa-sq";
const { makeFakeAgent } = await import(join(root, "tests/helpers/fake-agent.ts"));
const fake = makeFakeAgent(join(dir, "bin"), { holdMs: 2500 });

const server = spawn("bun", ["src/web/serve.ts", "--port", String(PORT)], {
  cwd: root, stdio: "ignore",
  env: { ...process.env, MINITUI_MINI_BIN: fake.script, MINITUI_EMBEDDED_AGENT: "0", MINITUI_LAST_MODEL_PATH: join(dir, "last-model.json"), MINITUI_CONNECTIONS_PATH: join(dir, "providers.json"), MINITUI_SETTINGS_PATH: join(dir, "settings.json"), MINITUI_SKILLS_DIR: join(dir, "skills"), MINITUI_DB_PATH: join(dir, "sessions.db"), MINITUI_CONFIG_DIR: dir, MINITUI_RESUME_DIR: join(dir, "resume"), MINITUI_RUNS_DIR: join(dir, "runs") },
});
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await Bun.sleep(100); }

function chrome() { const r = `${homedir()}/.cache/ms-playwright`; for (const d of readdirSync(r).filter((d) => d.startsWith("chromium-")).sort().reverse()) { const b = `${r}/${d}/chrome-linux64/chrome`; if (existsSync(b)) return b; } }

const norm = (html) => html.replace(/sq\d+-/g, "");
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); if (!ok) failed++; };

const browser = await chromium.launch({ executablePath: chrome() });
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(base);
  await page.waitForTimeout(1200);

  // 1. Faces are client-side svg, not images.
  const faces = await page.$$eval("[data-mascot-state]", (els) => els.map((e) => ({ state: e.dataset.mascotState, svg: !!e.querySelector("svg"), img: !!e.querySelector("img"), html: e.innerHTML })));
  check("mascots render as inline svg from specs", faces.length > 0 && faces.every((f) => f.svg && !f.img), `${faces.length} faces`);
  const webp = await page.$$eval("img[src*='mascots']", (els) => els.length);
  check("no bizbots webp mascots anywhere", webp === 0);

  // Seed the sidebar with a bot row: expand the agent's accordion, then read its bot mascot.
  const botFaceBefore = await page.$eval('[data-drop^="bot:"] [data-mascot-state]', (e) => e.innerHTML).catch((e) => { console.log("DBG", String(e).slice(0,120)); return null; }).then((h) => (h ? norm(h) : null));
  check("bot row has a mascot face", !!botFaceBefore);
  await page.screenshot({ path: `${SHOTS}/sq-idle-desktop.png` });

  // 2. Live expression change: send a turn, the face flips idle→thinking(curious)→success(happy).
  const bar = page.locator("textarea[aria-label=Prompt]");
  await bar.fill("hello squishmoji");
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-mascot-state="thinking"]', { timeout: 8000 });
  const thinkingHtml = await page.$eval('[data-drop^="bot:"] [data-mascot-state]', (e) => e.innerHTML).catch((e) => { console.log("DBG", String(e).slice(0,120)); return null; }).then((h) => (h ? norm(h) : null));
  check("running turn: bot face state=thinking", !!thinkingHtml);
  check("thinking face differs from idle face (curious, live)", !!thinkingHtml && !!botFaceBefore && thinkingHtml !== botFaceBefore);
  await page.screenshot({ path: `${SHOTS}/sq-thinking-desktop.png` });

  await page.waitForSelector('[data-mascot-state="success"]', { timeout: 10000 });
  const successHtml = await page.$eval('[data-drop^="bot:"] [data-mascot-state]', (e) => e.innerHTML).catch((e) => { console.log("DBG", String(e).slice(0,120)); return null; }).then((h) => (h ? norm(h) : null));
  check("turn done: bot face state=success (happy)", !!successHtml);
  check("success face differs from thinking face", !!successHtml && successHtml !== thinkingHtml);
  await page.screenshot({ path: `${SHOTS}/sq-success-desktop.png` });

  // 3. Seed stability: reload keeps the exact same face per bot.
  await page.reload();
  await page.waitForTimeout(1200);
  const botFaceAfter = await page.$eval('[data-drop^="bot:"] [data-mascot-state]', (e) => e.innerHTML).catch((e) => { console.log("DBG", String(e).slice(0,120)); return null; }).then((h) => (h ? norm(h) : null));
  // Compare against the same state's face before the reload (the bot stays "success" after its turn).
  const stable = !!botFaceAfter && botFaceAfter === successHtml;
  if (!stable) { console.log("DBG before:", (successHtml || "").slice(0, 240)); console.log("DBG after :", (botFaceAfter || "").slice(0, 240)); }
  check("seed stable after reload: same svg (ids scoped)", stable);
  check("reload keeps the finished state (success, not a reset to idle)", await page.locator('[data-mascot-state="success"]').count() > 0);

  // 4. Mobile 390px.
  const mob = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mp = await mob.newPage();
  mp.on("pageerror", (e) => errors.push(String(e)));
  await mp.goto(base);
  await mp.waitForTimeout(1200);
  const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("390px: no horizontal overflow", overflow <= 0, `overflow=${overflow}px`);
  await mp.screenshot({ path: `${SHOTS}/sq-mobile-390.png` });

  check("0 console/page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} finally {
  await browser.close();
  server.kill();
}
console.log(failed ? `FAILED ${failed}` : "ALL PASS");
process.exit(failed ? 1 : 0);
