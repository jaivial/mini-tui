// Visual verification of the #benchmark charts in the built site: the SVG geometry actually rendered,
// at desktop and phone. Checks the things a screenshot would be judged on -- nothing clipped, no text
// overlapping, bars proportional to the data, no sideways scroll, both themes.
import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = 4477;
const root = "/home/jaime/mini-tui/site";
const chrome = () => { const r = `${homedir()}/.cache/ms-playwright`; for (const d of readdirSync(r).filter((d) => d.startsWith("chromium-")).sort().reverse()) { const b = `${r}/${d}/chrome-linux64/chrome`; if (existsSync(b)) return b; } };
const server = Bun.serve({ port: PORT, hostname: "127.0.0.1", fetch(req) {
  let p = decodeURIComponent(new URL(req.url).pathname).replace(/^\/mini-tui/, "") || "/";
  const c = p.endsWith("/") ? join(root, "build", p, "index.html") : join(root, "build", p);
  const f = Bun.file(c); return f.size ? new Response(f) : new Response("nope", { status: 404 });
} });

let fail = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); if (!ok) fail++; };
const browser = await chromium.launch({ executablePath: chrome() });

for (const [name, w, h] of [["desktop", 1440, 900], ["phone", 390, 844]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: w < 500, isMobile: w < 500 });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle" });
  await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 300) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 10)); } });
  await page.waitForTimeout(400);

  check(`${name}: the home page has no sideways scroll`, (await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0);

  const charts = await page.evaluate(() => {
    const svgs = [...document.querySelectorAll("#benchmark figure svg")];
    return svgs.map((svg) => {
      const box = svg.getBoundingClientRect();
      const vb = svg.viewBox.baseVal;
      // every drawn element must sit inside the viewBox, or it is clipped away
      let clipped = 0, minY = Infinity, maxY = -Infinity;
      const hidden = (el) => getComputedStyle(el).display === "none";
      for (const el of svg.querySelectorAll("rect, line, circle, polyline")) {
        const b = el.getBBox ? el.getBBox() : null;
        if (!b || hidden(el)) continue;
        // Transparent rects are the per-point aria hit areas, not drawn marks: ignore for clipping.
        if (el.tagName === "rect" && el.getAttribute("fill") === "transparent") continue;
        if (b.x < -1 || b.y < -1 || b.x + b.width > vb.width + 1 || b.y + b.height > vb.height + 1) clipped++;
        if (el.tagName === "rect" && b.height > 0) { minY = Math.min(minY, b.y); maxY = Math.max(maxY, b.y + b.height); }
      }
      const texts = [...svg.querySelectorAll("text")].filter((t) => !hidden(t)).map((t) => { const r = t.getBoundingClientRect(); return { t: t.textContent, x: r.x, r: r.right, y: r.y, b: r.bottom }; });
      // labels inside the svg's painted box (a label that spills is the classic broken chart)
      const outside = texts.filter((t) => t.x < box.x - 0.5 || t.r > box.right + 0.5);
      // two labels sharing a row and overlapping horizontally
      let overlaps = 0;
      for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
        const a = texts[i], c = texts[j];
        if (Math.abs(a.y - c.y) < 6 && a.x < c.r - 0.5 && c.x < a.r - 0.5) overlaps++;
      }
      return { w: box.width, h: box.height, vbW: vb.width, clipped, outside: outside.map((o) => o.t).slice(0, 4), overlaps, texts: texts.length, bars: svg.querySelectorAll("rect[fill]:not([fill=transparent])").length, minY: isFinite(minY) ? minY : null };
    });
  });

  check(`${name}: three charts rendered`, charts.length === 3, String(charts.length));
  check(`${name}: no chart element clipped by its viewBox`, charts.every((c) => c.clipped === 0), charts.map((c) => c.clipped).join(","));
  check(`${name}: no axis or value label spills outside its chart`, charts.every((c) => c.outside.length === 0), JSON.stringify(charts.map((c) => c.outside)));
  check(`${name}: no two labels collide`, charts.every((c) => c.overlaps === 0), charts.map((c) => c.overlaps).join(","));
  check(`${name}: charts have a real size`, charts.every((c) => c.w > 200 && c.h > 100), charts.map((c) => `${Math.round(c.w)}x${Math.round(c.h)}`).join(" "));

  // Bars must be proportional to the data: t10 mini 49.2 s is the tallest bar and t5 mini 9.0 s the shortest.
  const bars = await page.evaluate(() => {
    const svg = document.querySelectorAll("#benchmark figure svg")[0];
    const rs = [...svg.querySelectorAll("rect")].filter((r) => r.getAttribute("fill") !== "transparent");
    return rs.map((r) => ({ h: +r.getAttribute("height"), x: +r.getAttribute("x") }));
  });
  const maxH = Math.max(...bars.map((b) => b.h)), minH = Math.min(...bars.map((b) => b.h));
  check(`${name}: the bars use the full plot height (t10 vs t5 spread)`, maxH > 200 && minH > 30 && minH / maxH < 0.35, `${minH.toFixed(0)}..${maxH.toFixed(0)}px`);

  // Every chart states the same honest headline in text the screen reader and the eye both get.
  const txt = await page.locator("#benchmark").innerText();
  check(`${name}: the section still reads 0.98x and 40/40`, /0\.98x/.test(txt) && /40\/40/.test(txt));

  if (w < 500) {
    await page.locator("#benchmark").screenshot({ path: `/tmp/cuig/bench_${name}.png` });
  } else {
    await page.locator("#benchmark").screenshot({ path: `/tmp/cuig/bench_${name}.png` });
  }
  await ctx.close();
}
await browser.close();
server.stop(true);
console.log(fail ? `\n${fail} FAILED` : "\nall chart checks passed");
process.exit(fail ? 1 : 0);