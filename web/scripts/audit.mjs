// Layout audit at the three review sizes: small tap targets, clipped/overflowing
// elements, fixed widths that break. `bun scripts/audit.mjs`
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
const PORT = 4398;
const now = Date.now();
const ev = [{ type: "task", text: "Fix sidebar" }, { type: "tool_call", id: "c1", name: "bash", command: "rg -n 'EventSource' web/src/lib/stores/sessions.svelte.ts web/src/lib/components" }, { type: "observation", toolCallId: "c1", returncode: 0, output: "x".repeat(200), exceptionInfo: "" }, { type: "assistant", text: "Done. `code` here" }];
const mk = (id, title, status, target = "local") => ({ id, title, cwd: "/home/user/mini-tui", model: "claude-sonnet-5.5", task: title, createdAt: now, updatedAt: now, apiCalls: 1, cost: 0.1, exitStatus: "", target, hostId: target === "remote" ? "h1" : undefined, status, startedAt: now, info: { cost: 0.1, apiCalls: 1 }, messages: [], events: ev });
const sessions = [mk("s1", "Fix the sidebar overflow on narrow screens", "running", "remote"), mk("s2", "Add remote host probe", "done")];
function chrome() { const root = `${homedir()}/.cache/ms-playwright`; for (const d of readdirSync(root).filter((d) => d.startsWith("chromium-")).sort().reverse()) { const b = `${root}/${d}/chrome-linux64/chrome`; if (existsSync(b)) return b; } }
const server = spawn("bunx", ["vite", "preview", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { stdio: "ignore" });
for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }
const browser = await chromium.launch({ executablePath: chrome() });
const sizes = { desktop: [1440, 900, false], tablet: [820, 1180, true], phone: [390, 844, true] };
let bad = 0;
try {
  for (const [name, [w, h, touch]] of Object.entries(sizes)) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: name === "phone" });
    const page = await ctx.newPage();
    await page.route("**/api/**", (route) => {
      const p = new URL(route.request().url()).pathname; const j = (b) => route.fulfill({ contentType: "application/json", body: JSON.stringify(b) });
      if (p === "/api/stream") return route.fulfill({ contentType: "text/event-stream", body: ": ok\n\n" });
      if (p === "/api/sessions") return j(sessions);
      if (p === "/api/hosts") return j([{ id: "h1", label: "build-box", host: "x", port: 22, user: "j", workdir: "~", online: true }]);
      return j([]);
    });
    await page.goto(`http://127.0.0.1:${PORT}/`); await page.waitForTimeout(800);
    const report = await page.evaluate((min) => {
      const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
      const small = [...document.querySelectorAll("button, a[href], input, textarea, select, [role=button], [role=menuitem]")].filter(vis).map((el) => { const r = el.getBoundingClientRect(); return { tag: el.tagName.toLowerCase(), label: (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "").trim().slice(0, 28), w: Math.round(r.width), h: Math.round(r.height) }; }).filter((x) => x.w < min || x.h < min);
      const off = [...document.querySelectorAll("body *")].filter(vis).filter((el) => { const r = el.getBoundingClientRect(); return r.right > innerWidth + 1 || r.left < -1; }).slice(0, 6).map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} ${Math.round(el.getBoundingClientRect().left)}..${Math.round(el.getBoundingClientRect().right)}`);
      const vp = document.querySelector('meta[name=viewport]')?.content;
      const composer = document.querySelector("textarea")?.getBoundingClientRect();
      return { small, off, vp, composerBottom: composer && Math.round(composer.bottom), innerHeight, hover: matchMedia("(hover: hover)").matches };
    }, 44);
    console.log(`\n== ${name} ${w}x${h}  viewport-meta="${report.vp}"  composer.bottom=${report.composerBottom}/${report.innerHeight}`);
    console.log(`   targets < 44px: ${report.small.length}`);
    for (const s of report.small) console.log(`     ${s.tag} "${s.label}" ${s.w}x${s.h}`);
    console.log(`   off-screen: ${report.off.length ? report.off.join(" | ") : "none"}`);
    bad += report.small.length + report.off.length;
    await ctx.close();
  }
} finally { await browser.close(); server.kill(); }
console.log(`\nissues: ${bad}`);
