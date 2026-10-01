// Width audit of the built site: every route at 320, 390, 430, 820 and 1440 px. Fails on sideways
// scroll, on any block wider than the viewport (outside something that scrolls on purpose), and on a
// main column that leaves a fifth or more of a phone or tablet width unused.
// `bun run build && bun run layout`
import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = 4400 + Math.floor(Math.random() * 500);
const root = join(import.meta.dir, "..");
const BASE = new URL(process.env.VITE_SITE_URL ?? "https://jaivial.github.io/mini-tui").pathname.replace(/\/$/, "");
const chrome = () => { const r = `${homedir()}/.cache/ms-playwright`; for (const d of readdirSync(r).filter((d) => d.startsWith("chromium-")).sort().reverse()) { const b = `${r}/${d}/chrome-linux64/chrome`; if (existsSync(b)) return b; } };
const server = Bun.serve({ port: PORT, hostname: "127.0.0.1", fetch(req) {
  let p = decodeURIComponent(new URL(req.url).pathname);
  if (!p.startsWith(BASE)) return new Response("not found", { status: 404 });
  p = p.slice(BASE.length) || "/";
  const candidates = p.endsWith("/") ? [join(root, "build", p, "index.html")] : [join(root, "build", p), join(root, "build", p, "index.html")];
  for (const c of candidates) { const f = Bun.file(c); if (f.size) return new Response(f); }
  return new Response("not found", { status: 404 });
} });

const routes = (process.env.ROUTES ?? "/,/web-app/,/docs/,/docs/install/,/docs/rust-agent/,/docs/web-app/,/docs/remote-ssh/,/docs/skills-and-commands/,/docs/headless/,/docs/providers/,/changelog/").split(",");
const sizes = [["phone-320", 320, 640], ["phone", 390, 844], ["phone-lg", 430, 932], ["tablet", 820, 1180], ["desktop", 1440, 900]];
const browser = await chromium.launch({ executablePath: chrome() });
let problems = 0;
const report = [];
try {
  for (const [name, w, h] of sizes) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: w < 900, isMobile: w < 500 });
    const page = await ctx.newPage();
    for (const r of routes) {
      const res = await page.goto(`http://127.0.0.1:${PORT}${BASE}${r}`);
      if (!res || res.status() !== 200) { report.push(`${name} ${r}: HTTP ${res?.status()}`); continue; }
      // Reveal animations hide content until it scrolls in: show everything before measuring.
      await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 400) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 15)); } window.scrollTo(0, 0); });
      await page.waitForTimeout(250);
      const out = await page.evaluate((vw) => {
        const issues = [];
        const doc = document.documentElement;
        if (doc.scrollWidth > vw + 1) issues.push(`sideways scroll: page is ${doc.scrollWidth}px wide`);
        // Elements that stick out of the viewport (not inside something that scrolls on purpose).
        const scrolls = (el) => { for (let p = el.parentElement; p; p = p.parentElement) { const s = getComputedStyle(p); if (/(auto|scroll)/.test(s.overflowX) && p.scrollWidth > p.clientWidth) return true; } return false; };
        for (const el of document.querySelectorAll("main *")) {
          const b = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          if (!b.width || cs.visibility === "hidden") continue;
          // An inline box that wraps reports the union of its lines: judge its block container instead.
          if (cs.display === "inline") continue;
          if ((b.right > vw + 1 || b.left < -1) && !scrolls(el) && !el.closest("[aria-hidden=true]")) {
            issues.push(`overflows: <${el.tagName.toLowerCase()} class="${(el.className?.baseVal ?? el.className ?? "").toString().slice(0, 60)}"> ${Math.round(b.left)}..${Math.round(b.right)}`);
            if (issues.length > 6) break;
          }
        }
        // The main text column: how much of the viewport it uses (minus the page gutters).
        const main = document.querySelector("main");
        const blocks = [...main.querySelectorAll("article, section, .prose, pre, table, figure")].filter((el) => el.getBoundingClientRect().height > 40);
        const widest = Math.max(0, ...blocks.map((el) => el.getBoundingClientRect().width));
        const usable = Math.min(vw, 1280) - 32;
        const sidebar = document.querySelector("[data-docs-nav], nav[aria-label*='Docs' i]");
        const sideW = sidebar && getComputedStyle(sidebar).display !== "none" ? sidebar.getBoundingClientRect().width : 0;
        if (vw < 900 && widest && widest < (usable - sideW) * 0.8) issues.push(`narrow column: widest block ${Math.round(widest)}px of ${Math.round(usable - sideW)}px available`);
        // Code blocks that make their own column scroll on a phone although they could wrap: only report
        // when the page itself is affected (handled above). Tables wider than their container:
        for (const t of main.querySelectorAll("table")) { const p = t.parentElement.getBoundingClientRect(); if (t.getBoundingClientRect().width > p.width + 1 && !/(auto|scroll)/.test(getComputedStyle(t.parentElement).overflowX)) issues.push(`table wider than its column (${Math.round(t.getBoundingClientRect().width)} > ${Math.round(p.width)})`); }
        return { issues, widest: Math.round(widest), mainW: Math.round(main.getBoundingClientRect().width) };
      }, w);
      if (out.issues.length) { problems += out.issues.length; report.push(`${name} ${r}:\n    ${out.issues.join("\n    ")}`); }
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  server.stop();
}
console.log(report.join("\n") || "no layout problems");
console.log(`${problems} problem(s)`);
process.exit(problems ? 1 : 0);
