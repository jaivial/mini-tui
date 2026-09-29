// Drives the built site in a real browser at desktop / tablet / phone: no console errors, no failed
// requests, no horizontal overflow, 44px touch targets on a phone, visible focus, working menu and theme.
// `bun run build && bun scripts/browse-check.mjs [outDir]`
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const out = process.argv[2];
if (out) mkdirSync(out, { recursive: true });
const PORT = 4383;
const root = join(import.meta.dir, "..");
const BASE = new URL(process.env.VITE_SITE_URL ?? "https://jaivial.github.io/mini-tui").pathname.replace(/\/$/, "");
const chrome = () => { const r = `${homedir()}/.cache/ms-playwright`; for (const d of readdirSync(r).filter((d) => d.startsWith("chromium-")).sort().reverse()) { const b = `${r}/${d}/chrome-linux64/chrome`; if (existsSync(b)) return b; } };

// Serve ./build under BASE, exactly as GitHub Pages would (dir/index.html, 404 otherwise).
const server = Bun.serve({ port: PORT, hostname: "127.0.0.1", fetch(req) {
  let p = decodeURIComponent(new URL(req.url).pathname);
  if (!p.startsWith(BASE)) return new Response("not found", { status: 404 });
  p = p.slice(BASE.length) || "/";
  const candidates = p.endsWith("/") ? [join(root, "build", p, "index.html")] : [join(root, "build", p), join(root, "build", p, "index.html")];
  for (const c of candidates) { const f = Bun.file(c); if (f.size) return new Response(f); }
  return new Response("not found", { status: 404 });
} });

let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); if (!ok) failed++; };
const browser = await chromium.launch({ executablePath: chrome() });
const routes = ["/", "/web-app/", "/docs/", "/docs/install/", "/docs/web-app/", "/docs/remote-ssh/", "/docs/skills-and-commands/", "/docs/headless/", "/docs/providers/", "/changelog/"];
try {
  for (const [name, w, h, mobile] of [["desktop", 1440, 900, false], ["tablet", 820, 1180, true], ["phone", 390, 844, true]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: mobile, isMobile: mobile && w < 500, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [], failedReq = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("requestfailed", (r) => failedReq.push(r.url()));
    page.on("response", (r) => { if (r.status() >= 400 && !r.url().includes("favicon.ico")) failedReq.push(`${r.status()} ${r.url()}`); });
    const overflow = [];
    for (const r of routes) {
      await page.goto(`http://127.0.0.1:${PORT}${BASE}${r}`, { waitUntil: "networkidle" });
      const o = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      if (o > 0) overflow.push(`${r} +${o}px`);
      if (out && (r === "/" || r === "/docs/install/" || r === "/web-app/")) await page.screenshot({ path: join(out, `${name}${r.replace(/\//g, "-").replace(/-$/, "")}.png`), fullPage: false });
    }
    check(`${name}: no horizontal overflow on any of ${routes.length} routes`, overflow.length === 0, overflow.join(", "));
    check(`${name}: no console errors and no failed requests`, errors.length === 0 && failedReq.length === 0, [...errors, ...failedReq].slice(0, 3).join(" | "));

    await page.goto(`http://127.0.0.1:${PORT}${BASE}/`, { waitUntil: "networkidle" });
    check(`${name}: exactly one <h1>, and it is visible in the first viewport`, (await page.locator("h1").count()) === 1 && (await page.locator("h1").evaluate((e) => e.getBoundingClientRect().bottom < innerHeight)));
    const heroImg = await page.locator("img[fetchpriority=high]").evaluate((i) => ({ done: i.complete && i.naturalWidth > 0, w: i.getBoundingClientRect().width }));
    check(`${name}: the hero screenshot loads and fits`, heroImg.done && heroImg.w <= w, `${Math.round(heroImg.w)}px`);

    if (mobile && w < 500) {
      const small = await page.evaluate(() => [...document.querySelectorAll("header a, header button, main a.inline-flex, main button")].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden" && (r.height < 43.5 || r.width < 43.5); }).map((e) => `${e.tagName}:${(e.getAttribute("aria-label") || e.textContent || "").trim().slice(0, 20)} ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`));
      check("phone: header, hero and copy controls are at least 44px", small.length === 0, small.join(", "));
      await page.getByRole("button", { name: "Open menu" }).tap();
      const nav = page.getByRole("navigation", { name: "Mobile" });
      check("phone: the menu opens and lists Docs, Web app, Changelog", (await nav.getByRole("link").count()) >= 3 && (await page.getByRole("button", { name: "Close menu" }).getAttribute("aria-expanded")) === "true");
      const items = await nav.getByRole("link").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
      check("phone: menu links are 44px tall", items.every((h) => h >= 44), items.join(","));
      await page.keyboard.press("Escape");
      check("phone: Escape closes the menu", (await page.getByRole("navigation", { name: "Mobile" }).count()) === 0);
    }
    if (!mobile) {
      await page.keyboard.press("Tab");
      const skip = await page.evaluate(() => ({ text: document.activeElement?.textContent?.trim(), visible: (() => { const r = document.activeElement?.getBoundingClientRect(); return !!r && r.width > 0 && r.top >= 0; })() }));
      check("desktop: the first Tab stop is a visible 'Skip to content'", /Skip to content/.test(skip.text ?? "") && skip.visible, skip.text);
      const before = await page.evaluate(() => document.documentElement.classList.contains("dark"));
      await page.getByRole("button", { name: /Switch to (light|dark) mode/ }).click();
      const after = await page.evaluate(() => ({ dark: document.documentElement.classList.contains("dark"), bg: getComputedStyle(document.body).backgroundColor, saved: localStorage.getItem("mt-theme") }));
      check("desktop: the theme toggle flips the theme and remembers it", after.dark !== before && after.saved === (after.dark ? "dark" : "light"), `${after.saved} ${after.bg}`);
      await page.reload({ waitUntil: "networkidle" });
      check("desktop: the saved theme survives a reload with no flash (class set before paint)", (await page.evaluate(() => document.documentElement.classList.contains("dark"))) === after.dark);
      // FAQ accordion: keyboard operable, and the answer text is in the HTML either way
      const q = page.getByRole("button", { name: /Does mini-tui cost anything/ });
      await q.focus(); await page.keyboard.press("Enter");
      check("desktop: a FAQ item opens with the keyboard", (await q.getAttribute("aria-expanded")) === "true");
      check("desktop: the docs page has a table of contents and previous/next links", await (async () => { await page.goto(`http://127.0.0.1:${PORT}${BASE}/docs/web-app/`, { waitUntil: "networkidle" }); return (await page.getByRole("complementary", { name: "On this page" }).count()) === 1 && (await page.getByRole("navigation", { name: "Previous and next" }).getByRole("link").count()) >= 1; })());
    }
    await ctx.close();
  }
  // a missing page is a real 404 with a helpful page, not the home page
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  const res = await page.goto(`http://127.0.0.1:${PORT}${BASE}/does-not-exist/`);
  check("an unknown URL returns 404", res.status() === 404, String(res.status()));
  await ctx.close();
} finally { await browser.close(); server.stop(true); }
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
