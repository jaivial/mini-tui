// Generates static/og.png (1200x630) and static/apple-touch-icon.png from the site's own fonts and the
// real product screenshot. Run with `bun run assets`; the outputs are committed so a build needs no browser.
import { chromium } from "playwright-core";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const fonts = join(root, "node_modules/@fontsource-variable");
const b64 = (p) => readFileSync(p).toString("base64");
const geist = b64(join(fonts, "geist/files/geist-latin-wght-normal.woff2"));
const mono = b64(join(fonts, "jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2"));
const shot = b64(join(root, "static/screens/web-chat.webp"));

const css = `
@font-face{font-family:G;src:url(data:font/woff2;base64,${geist}) format("woff2");font-weight:100 900}
@font-face{font-family:M;src:url(data:font/woff2;base64,${mono}) format("woff2");font-weight:100 800}
*{margin:0;padding:0;box-sizing:border-box}
body{width:1200px;height:630px;overflow:hidden;background:#161612;color:#f2f1ec;font-family:G,system-ui,sans-serif;letter-spacing:-.02em;position:relative}
.glow{position:absolute;inset:0;background:radial-gradient(60% 70% at 78% 30%,rgba(255,122,61,.18),transparent 70%)}
.left{position:absolute;left:72px;top:0;bottom:0;width:520px;display:flex;flex-direction:column;justify-content:center;gap:26px}
.brand{display:flex;align-items:center;gap:14px;font-size:30px;font-weight:600}
.mark{width:44px;height:44px;border-radius:11px;background:#ff7a3d;display:grid;place-items:center}
h1{font-size:62px;line-height:1.04;font-weight:600;letter-spacing:-.04em}
h1 em{font-style:normal;color:#ff7a3d}
p{font-size:24px;line-height:1.4;color:#a8a59a}
.tag{font-family:M,monospace;font-size:20px;color:#96927f}
.frame{position:absolute;left:640px;top:96px;width:900px;height:562px;border-radius:18px;overflow:hidden;border:2px solid #46443b;box-shadow:0 30px 80px rgba(0,0,0,.5)}
.frame img{width:100%;height:100%;object-fit:cover;object-position:top left;display:block}`;
const svgMark = `<svg width="26" height="26" viewBox="0 0 32 32" fill="none"><path d="M9 11l5 5-5 5" stroke="#1a0f08" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M17 21h6" stroke="#1a0f08" stroke-width="3" stroke-linecap="round"/></svg>`;
const html = `<!doctype html><meta charset=utf-8><style>${css}</style><body><div class=glow></div>
<div class=left><div class=brand><span class=mark>${svgMark}</span>mini-tui</div>
<h1>The coding agent that runs <em>where you work.</em></h1>
<p>Terminal and web UI. Many sessions, one WebSocket each, headless over SSH.</p>
<div class=tag>github.com/jaivial/mini-tui</div></div>
<div class=frame><img src="data:image/webp;base64,${shot}"></div></body>`;

const icon = `<!doctype html><meta charset=utf-8><style>*{margin:0}body{width:180px;height:180px;background:#161612;display:grid;place-items:center}
.m{width:132px;height:132px;border-radius:32px;background:#ff7a3d;display:grid;place-items:center}</style>
<body><div class=m><svg width="80" height="80" viewBox="0 0 32 32" fill="none"><path d="M9 11l5 5-5 5" stroke="#1a0f08" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M17 21h6" stroke="#1a0f08" stroke-width="2.6" stroke-linecap="round"/></svg></div></body>`;

function chrome() {
  const r = `${homedir()}/.cache/ms-playwright`;
  for (const d of readdirSync(r).filter((d) => d.startsWith("chromium-")).sort().reverse()) {
    const bin = `${r}/${d}/chrome-linux64/chrome`;
    if (existsSync(bin)) return bin;
  }
}
const browser = await chromium.launch({ executablePath: chrome() });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.setContent(html); await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(200);
  await page.screenshot({ path: join(root, "static/og.png") });
  await page.setViewportSize({ width: 180, height: 180 });
  await page.setContent(icon); await page.waitForTimeout(100);
  await page.screenshot({ path: join(root, "static/apple-touch-icon.png") });
} finally { await browser.close(); }
console.log("wrote static/og.png, static/apple-touch-icon.png");
