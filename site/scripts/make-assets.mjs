// Generates static/og.png (1200x630) and static/apple-touch-icon.png from the site's own fonts.
// Run with `bun run assets`; the outputs are committed so a build needs no browser.
import { chromium } from "playwright-core";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const fonts = join(root, "node_modules/@fontsource-variable");
const b64 = (p) => readFileSync(p).toString("base64");
const geist = b64(join(fonts, "geist/files/geist-latin-wght-normal.woff2"));
const mono = b64(join(fonts, "jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2"));

const css = `
@font-face{font-family:G;src:url(data:font/woff2;base64,${geist}) format("woff2");font-weight:100 900}
@font-face{font-family:M;src:url(data:font/woff2;base64,${mono}) format("woff2");font-weight:100 800}
*{margin:0;padding:0;box-sizing:border-box}
body{width:1200px;height:630px;overflow:hidden;background:#0b0c0f;color:#eceef2;font-family:G,system-ui,sans-serif;letter-spacing:-.02em;position:relative}
.glow{position:absolute;inset:0;background:radial-gradient(65% 80% at 80% 25%,rgba(45,212,191,.13),transparent 70%),radial-gradient(45% 70% at 15% 90%,rgba(255,122,61,.13),transparent 70%)}
.left{position:absolute;left:66px;top:0;bottom:0;width:510px;display:flex;flex-direction:column;justify-content:center;gap:22px}
.brand{display:flex;align-items:center;gap:14px;font-size:29px;font-weight:600}.mark{width:44px;height:44px;border-radius:11px;background:#ff7a3d;display:grid;place-items:center}
h1{font-size:59px;line-height:1.04;font-weight:600;letter-spacing:-.045em}h1 em{font-style:normal;color:#2dd4bf}
p{font-size:23px;line-height:1.38;color:#a3a8b2}.tag{font-family:M,monospace;font-size:19px;color:#8d929d}
.frame{position:absolute;left:640px;top:82px;width:900px;height:586px;border:1px solid #343943;border-radius:18px;overflow:hidden;background:#121419;box-shadow:0 30px 80px rgba(0,0,0,.55);font-size:17px}
.qhead{height:48px;display:flex;align-items:center;justify-content:space-between;padding:0 22px;border-bottom:1px solid #2a2e37;color:#a3a8b2;font-family:M,monospace;font-size:15px}.qhead b{color:#7ddc8a;font-weight:500}
.qbody{display:grid;grid-template-columns:1.05fr 1fr;height:538px}.chat{padding:20px;border-right:1px solid #2a2e37}.eyebrow{font-family:M,monospace;font-size:12px;color:#8d929d;text-transform:uppercase;letter-spacing:.08em;margin-bottom:14px}
.msg{padding:12px 14px;border:1px solid #2c313b;border-radius:12px;margin-bottom:12px;line-height:1.4}.msg span{display:block;color:#8d929d;font-size:12px;text-transform:uppercase;margin-bottom:4px}.user{background:#1d2027}.result{border-color:#2f9e55;color:#a3a8b2}.result b{color:#7ddc8a}
.tasks{padding:20px}.task{padding:12px 14px;border:1px solid #2c313b;border-radius:12px;margin-bottom:10px}.task strong{display:block;font-weight:550}.task small{display:block;color:#8d929d;margin-top:3px;font-size:14px}.task.done small{color:#7ddc8a}.speed{margin-top:18px;padding:16px;border-radius:12px;background:#1d2027;display:grid;grid-template-columns:1fr auto;align-items:end}.speed span{color:#8d929d;font-size:12px;text-transform:uppercase}.speed strong{grid-row:span 2;color:#2dd4bf;font-family:M,monospace;font-size:42px;letter-spacing:-.06em}.speed small{color:#a3a8b2;font-size:13px}
`;
const svgMark = `<svg width="26" height="26" viewBox="0 0 32 32" fill="none"><path d="M9 11l5 5-5 5" stroke="#1a0f08" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M17 21h6" stroke="#1a0f08" stroke-width="3" stroke-linecap="round"/></svg>`;
const task = (id, title, note, done = false) => `<div class="task ${done ? "done" : ""}"><strong>${id} · ${title}</strong><small>${note}</small></div>`;
const html = `<!doctype html><meta charset=utf-8><style>${css}</style><body><div class=glow></div>
<div class=left><div class=brand><span class=mark>${svgMark}</span>mini-tui</div>
<h1>Assign work. Get proof, <em>2.43× faster.</em></h1>
<p>One chat. A durable work queue. Eager verification with an independent PASS.</p>
<div class=tag>v0.45.0 · eager verification + MCP<br>github.com/jaivial/mini-tui</div></div>
<div class=frame><div class=qhead><span>mini.local / work-queue</span><b>2 workers running</b></div><div class=qbody>
<div class=chat><p class=eyebrow>One chat</p><div class="msg user">Fix the parser and the async limiter, then verify everything.</div><div class="msg user"><span>Dispatcher</span>Created 4 tasks. Independent parts have disjoint directories.</div><div class="msg result"><span>Result card</span><b>4/4 checks passed.</b> Closing eager — no final summary turn.</div></div>
<div class=tasks><p class=eyebrow>Work queue</p>${task("t1", "Refactor utils.js", "worker 1 · editing")}${task("t2", "Analyze 4 logs", "worker 2 · computing")}${task("t3", "Fix async limiter", "verify.sh → PASS", true)}${task("t4", "Reconcile CSV", "verify.sh → PASS", true)}${task("t5", "Release v0.45", "queued")}
<div class=speed><span>final strict run</span><strong>2.43×</strong><small>worker · 10/10 PASS both</small></div></div></div></div></body>`;

const icon = `<!doctype html><meta charset=utf-8><style>*{margin:0}body{width:180px;height:180px;background:#0b0c0f;display:grid;place-items:center}.m{width:132px;height:132px;border-radius:32px;background:#ff7a3d;display:grid;place-items:center}</style>
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
