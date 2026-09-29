// Screenshot-driven UI review: `bun run shots [outDir]`.
// Serves the built app (vite preview) and mocks /api with fixtures, so no agent
// runs and nothing touches ~/.config/mini-tui. Captures desktop, tablet, phone.
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";

const out = process.argv[2] ?? "/tmp/minitui-shots";
const PORT = 4399;
mkdirSync(out, { recursive: true });

const now = Date.now();
const long = "Refactored the session store so every mounted session stays live over one SSE stream, then verified the transcript survives tab switches.";
const session = (id, title, status, extra = {}) => ({
  id, title, cwd: "/home/user/mini-tui", model: "claude-sonnet-5.5", task: title,
  createdAt: now - 3600e3, updatedAt: now - 60e3, apiCalls: 12, cost: 0.184, exitStatus: "",
  target: "local", status, startedAt: now - 3600e3, info: { cost: 0.184, apiCalls: 12, model: "claude-sonnet-5.5" },
  messages: [], events: [
    { type: "task", text: title },
    { type: "thinking", text: "I should read the store first, then check how the SSE handler updates sessions.", seconds: 4 },
    { type: "tool_call", id: "c1", name: "bash", command: "rg -n 'EventSource' web/src" },
    { type: "observation", toolCallId: "c1", returncode: 0, output: "web/src/lib/stores/sessions.svelte.ts:46:    const source = new EventSource(\"/api/stream\");", exceptionInfo: "" },
    { type: "assistant", text: `${long}\n\n- keeps **one** stream\n- reconnects with backoff\n\n\`\`\`ts\nconst source = new EventSource("/api/stream");\n\`\`\`` },
    { type: "tool_call", id: "c2", name: "bash", command: "bun test tests/web-sessions.test.ts" },
    { type: "observation", toolCallId: "c2", returncode: 1, output: "1 fail\nexpected 3, received 2", exceptionInfo: "" },
  ], ...extra,
});
const sessions = [
  session("s1", "Fix the sidebar overflow on narrow screens", "running"),
  session("s2", "Add remote host probe", "done"),
  session("s3", "Investigate flaky journal watcher test", "error", { error: "exit 1" }),
];
const hosts = [{ id: "h1", label: "build-box", host: "10.0.0.12", port: 22, user: "jaime", workdir: "~/work", online: true }];

const server = spawn("bunx", ["vite", "preview", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch {} await sleep(250); }

const sizes = { desktop: [1440, 900], tablet: [820, 1180], phone: [390, 844] };
// Use MINITUI_CHROME, or the newest Chromium in the Playwright cache when the
// bundled revision was never downloaded.
import { readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
function findChrome() {
  if (process.env.MINITUI_CHROME) return process.env.MINITUI_CHROME;
  const root = `${homedir()}/.cache/ms-playwright`;
  if (!existsSync(root)) return undefined;
  const dirs = readdirSync(root).filter((d) => d.startsWith("chromium-")).sort().reverse();
  for (const d of dirs) { const bin = `${root}/${d}/chrome-linux64/chrome`; if (existsSync(bin)) return bin; }
}
const browser = await chromium.launch({ executablePath: findChrome() });
try {
  for (const [name, [width, height]] of Object.entries(sizes)) {
    for (const scheme of ["dark", "light"]) {
      const ctx = await browser.newContext({
        viewport: { width, height }, deviceScaleFactor: 2, hasTouch: name !== "desktop", isMobile: name === "phone",
        colorScheme: scheme,
      });
      await ctx.addInitScript((s) => localStorage.setItem("minitui.theme", s), scheme);
      const page = await ctx.newPage();
      const mock = (empty) => page.route("**/api/**", (route) => {
        const url = new URL(route.request().url());
        const p = url.pathname;
        const json = (b) => route.fulfill({ contentType: "application/json", body: JSON.stringify(b) });
        if (p === "/api/stream") return route.fulfill({ contentType: "text/event-stream", body: ": ok\n\n" });
        if (p === "/api/sessions") return json(empty ? [] : sessions);
        if (p === "/api/hosts") return json(hosts);
        if (p === "/api/models") return json([{ id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5", description: "Fast, capable" }]);
        if (p === "/api/history") return json([]);
        return json({ ok: true });
      });
      await mock(false);
      await page.goto(`http://127.0.0.1:${PORT}/`);
      await page.waitForTimeout(900);
      await page.screenshot({ path: `${out}/${name}-${scheme}-session.png` });
      if (scheme === "dark") {
        // Open the sidebar drawer on narrow screens; open the new-session modal everywhere.
        const menu = page.getByRole("button", { name: /sidebar|menu/i }).first();
        if (name !== "desktop" && (await menu.count())) { await menu.click(); await page.waitForTimeout(500); await page.screenshot({ path: `${out}/${name}-dark-drawer.png` }); await page.keyboard.press("Escape"); await page.mouse.click(width - 5, height / 2); await page.waitForTimeout(300); }
        await page.keyboard.press("Control+k");
        await page.waitForTimeout(500);
        await page.screenshot({ path: `${out}/${name}-dark-modal.png` });
        await page.keyboard.press("Escape");
        await page.unroute("**/api/**");
        await mock(true);
        await page.reload();
        await page.waitForTimeout(900);
        await page.screenshot({ path: `${out}/${name}-dark-empty.png` });
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      console.log(`${name}/${scheme}: horizontal overflow ${overflow}px`);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  server.kill();
}
console.log("screenshots in", out);
