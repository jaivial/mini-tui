// Geometry probe across devices and interface sizes: overflow, clipped controls, tap targets.
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
const root = join(import.meta.dir, "..", "..");
const dir = mkdtempSync(join(tmpdir(), "minitui-probe-"));
const { createSession, openDb, saveTranscript } = await import(join(root, "src/sessions.ts"));
const db = openDb(join(dir, "sessions.db"));
for (const [id, title] of [["s-a", "Refactor the upload retry logic in api/upload.ts"], ["s-b", "Beta task"]]) {
  createSession(db, { id, cwd: "/home/me/work/api", model: "deepseek/deepseek-chat", task: title, title });
  saveTranscript(db, id, [{ type: "task", text: title }, { type: "assistant", text: "Here is the plan:\n\n1. read the code\n2. `bun test`\n\n```ts\nconst x = await retry(upload, { times: 3 });\n```" }], { cost: 0.01, apiCalls: 1, exitStatus: "Submitted" }, [{ role: "user", content: title }]);
}
db.close();
const PORT = 5700 + Math.floor(Math.random() * 200);
const env = { ...process.env, MINITUI_EMBEDDED_AGENT: "0", MINITUI_MINI_BIN: "/bin/false", MINITUI_DB_PATH: join(dir, "sessions.db"), MINITUI_CONFIG_DIR: dir, MINITUI_RESUME_DIR: join(dir, "r"), MINITUI_RUNS_DIR: join(dir, "u"), MINITUI_LAST_MODEL_PATH: join(dir, "l.json"), MINITUI_CONNECTIONS_PATH: join(dir, "p.json"), MINITUI_SETTINGS_PATH: join(dir, "s.json"), MINITUI_SKILLS_DIR: join(dir, "sk") };
const server = spawn("bun", ["src/web/serve.ts", "--port", String(PORT)], { cwd: root, stdio: "ignore", env });
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await Bun.sleep(100); }
for (const id of ["s-a", "s-b"]) await fetch(`${base}/api/history/${id}`, { method: "POST" });
const r = `${homedir()}/.cache/ms-playwright`; let exe; for (const d of readdirSync(r).filter((d) => d.startsWith("chromium-")).sort().reverse()) { const b = `${r}/${d}/chrome-linux64/chrome`; if (existsSync(b)) { exe = b; break; } }
const browser = await chromium.launch({ executablePath: exe });
const only = process.argv[2];
const cases = [
  ["phone", 390, 844, true], ["phone-small", 320, 568, true], ["tablet-portrait", 820, 1180, true], ["tablet-landscape", 1180, 820, true], ["laptop", 1280, 800, false], ["desktop", 1920, 1080, false],
].filter((c) => !only || c[0] === only);
for (const [name, w, h, touch] of cases) {
  for (const scale of [0.85, 1, 1.4]) {
    for (const layout of ["single", "split+notes"]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch && w < 700, deviceScaleFactor: 2 });
      await ctx.addInitScript(([s]) => { localStorage.setItem("minitui.uiScale", String(s)); }, [scale]);
      const page = await ctx.newPage();
      await page.goto(base);
      await page.waitForTimeout(900);
      if (layout === "split+notes") {
        await page.keyboard.press("Control+Backslash");
        await page.waitForTimeout(300);
        if (process.env.DBG) console.log("DBG", name, scale, await page.evaluate(() => [innerWidth, document.querySelector("section[data-pane]")?.parentElement?.parentElement?.clientWidth, [...document.querySelectorAll("[role=status],[role=alert]")].map((e) => e.innerText).join("|").slice(0, 200)]));
        const panesNow = page.locator("section[data-pane]");
        await panesNow.first().getByRole("button", { name: "Show notes" }).click().catch(() => {});
        await page.waitForTimeout(400);
      }
      const m = await page.evaluate(() => {
        const vw = innerWidth, vh = innerHeight;
        const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && !el.closest("[aria-hidden=true]"); };
        const ctrls = [...document.querySelectorAll("button, [role=tab], textarea, select, input, [role=separator]")].filter(vis);
        // A control scrolled out of a scroller (the tab strip) is reachable by scrolling: only flag the unreachable.
        const inScroller = (el) => { for (let p = el.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if ((o === "auto" || o === "scroll") && p.scrollWidth > p.clientWidth) return true; } return false; };
        const off = ctrls.filter((el) => !inScroller(el)).filter((el) => { const r = el.getBoundingClientRect(); return r.right > vw + 1 || r.bottom > vh + 1 || r.left < -1 || r.top < -1; }).map((el) => (el.getAttribute("aria-label") || el.textContent.trim()).slice(0, 24));
        const coarse = matchMedia("(pointer: coarse)").matches;
        const small = coarse ? ctrls.filter((el) => el.getAttribute("role") !== "separator").filter((el) => { const r = el.getBoundingClientRect(); return r.width < 43.5 || r.height < 43.5; }).map((el) => `${(el.getAttribute("aria-label") || el.textContent.trim()).slice(0, 18)} ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`) : [];
        const panes = [...document.querySelectorAll("section[data-pane]")].map((e) => Math.round(e.getBoundingClientRect().width));
        const prompt = [...document.querySelectorAll('textarea[aria-label="Prompt"]')].map((e) => { const r = e.getBoundingClientRect(); return r.bottom <= vh + 1 && r.width >= 150; });
        const clipped = [...document.querySelectorAll("h1")].filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).textOverflow !== "ellipsis").length;
        return { sw: document.documentElement.scrollWidth - vw, sh: document.documentElement.scrollHeight - vh, off, small, panes, promptOk: prompt.every(Boolean) && prompt.length > 0, tabs: document.querySelectorAll("[role=tab]").length, notes: !!document.querySelector('aside[aria-labelledby] textarea, aside[aria-labelledby] p'), clipped };
      });
      const ok = m.sw <= 0 && m.sh <= 0 && m.off.length === 0 && m.small.length === 0 && m.promptOk && m.clipped === 0;
      console.log(`${ok ? "OK  " : "BAD "} ${name.padEnd(16)} ${String(scale).padEnd(4)} ${layout.padEnd(11)} panes=${JSON.stringify(m.panes)} tabs=${m.tabs} notes=${m.notes} ${ok ? "" : JSON.stringify({ sw: m.sw, sh: m.sh, off: m.off.slice(0, 5), small: m.small.slice(0, 5), promptOk: m.promptOk, clipped: m.clipped })}`);
      if (process.env.SHOTS) await page.screenshot({ path: `/tmp/shots-panes/${name}-${scale}-${layout}.png` });
      await ctx.close();
    }
  }
}
await browser.close();
server.kill();
rmSync(dir, { recursive: true, force: true });
