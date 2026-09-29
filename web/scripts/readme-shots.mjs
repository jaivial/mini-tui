// Screenshots for the README and the landing page: `bun scripts/readme-shots.mjs [outDir]`.
// Serves the built app and mocks /api with invented, public-safe data (no real paths, hosts, keys or
// sessions ever reach an image). Run `bun run build` first.
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";

const out = process.argv[2] ?? "docs/screenshots";
const PORT = 4384;
mkdirSync(out, { recursive: true });
const now = Date.now();

const events = [
  { type: "task", text: "Add a retry with backoff to the upload client and cover it with a test" },
  { type: "thinking", text: "The client calls fetch directly. I should wrap it, keep the signature, and inject the clock so the test is fast.", seconds: 6 },
  { type: "tool_call", id: "c1", name: "bash", command: "rg -n 'fetch\\(' src/upload.ts" },
  { type: "observation", toolCallId: "c1", returncode: 0, output: "src/upload.ts:41:  const res = await fetch(url, init);", exceptionInfo: "" },
  { type: "tool_call", id: "c2", name: "bash", command: "bun test tests/upload.test.ts" },
  { type: "observation", toolCallId: "c2", returncode: 0, output: "4 pass\n0 fail", exceptionInfo: "" },
  { type: "assistant", text: "Done. `upload()` now retries up to **3 times** with exponential backoff and jitter.\n\n- the clock is injectable, so the test runs in milliseconds\n- a 4xx is never retried\n\n```ts\nawait upload(file, { retries: 3 });\n```" },
];
const base = (id, title, status, extra = {}) => ({
  id, title, cwd: "~/projects/upload-client", model: "cliproxy/claude-sonnet-5-5", task: title, createdAt: now - 7200e3,
  updatedAt: now - 30e3, apiCalls: 9, cost: 0.142, exitStatus: "", target: "local", status, startedAt: now - 42e3,
  info: { cost: 0.142, apiCalls: 9 }, messages: [], ...extra,
});
const meta = [
  base("s1", "Add retry with backoff to the upload client", "running"),
  base("s2", "Migrate the settings page to the new form components", "done", { updatedAt: now - 3600e3, target: "remote", hostId: "h1" }),
  base("s3", "Investigate the flaky reconnect test", "error", { updatedAt: now - 7200e3 }),
];
const hosts = [{ id: "h1", label: "build-box", host: "build.example.com", port: 22, user: "dev", workdir: "~/work", online: true }];
const commands = [
  { name: "new", insert: "/new", detail: "Start a new chat", kind: "client" },
  { name: "model", insert: "/model", detail: "Switch the model for this chat", args: "[id]", kind: "client" },
  { name: "compact", insert: "/compact", detail: "Summarize the conversation to free context", kind: "client" },
  { name: "connect", insert: "/connect", detail: "Connect a provider with your API key", kind: "client" },
  { name: "settings", insert: "/settings", detail: "Open settings", kind: "client" },
  { name: "skills", insert: "/skills", detail: "Browse skills you can reference with $name", kind: "client" },
];
const skills = [
  { name: "better-ui", description: "Polishes and improves the UI: concentric radius, optical alignment, hit areas." },
  { name: "shadcn", description: "Adds, fixes and composes shadcn components." },
  { name: "pr-body", description: "Writes a pull request description from the diff." },
];
const models = ["cliproxy/claude-opus-5-5", "cliproxy/claude-sonnet-5-5", "deepseek/deepseek-chat", "deepseek/deepseek-flash", "xiaomi/mimo-v2.6-pro", "openai/gpt-6-astra"]
  .map((id) => ({ id, name: id, description: { "cliproxy/claude-opus-5-5": "Claude Opus 5.5", "cliproxy/claude-sonnet-5-5": "Claude Sonnet 5.5", "deepseek/deepseek-chat": "DeepSeek chat", "deepseek/deepseek-flash": "DeepSeek flash (fast)", "xiaomi/mimo-v2.6-pro": "Xiaomi MiMo V2.6 Pro", "openai/gpt-6-astra": "OpenAI GPT-6 Astra" }[id] }));
const providers = {
  connected: [
    { id: "deepseek", name: "DeepSeek", description: "deepseek-v4 / deepseek-chat", route: "native", baseUrl: "x", connected: true, keyHint: "sk-…a1b2", models: Array(6).fill("m"), defaultModel: "m", addedAt: now - 86400e3 },
    { id: "opencode-go", name: "OpenCode Go", description: "subscription models", route: "native", baseUrl: "x", connected: true, keyHint: "oc_…zCGz", models: Array(30).fill("m"), defaultModel: "m", addedAt: now - 3 * 86400e3 },
  ],
  catalog: ["Xiaomi MiMo|MiMo V2.x (token plan)", "Z.AI|GLM coding models", "MiniMax|MiniMax M-series", "Moonshot|Kimi models", "Groq|Fast inference", "OpenRouter|One key, many models"].map((s, i) => ({ id: `p${i}`, name: s.split("|")[0], description: s.split("|")[1], route: "native", baseUrl: "x", staticModels: [] })),
};
const settings = { outputMode: "collapsed", theme: "shadcn", lastModel: "cliproxy/claude-sonnet-5-5", outputModes: [
  { value: "collapsed", name: "collapsed", description: "just a tool-call count line, expandable per block" },
  { value: "trim", name: "trimmed (2 lines)", description: "two lines of output, expandable per block" },
  { value: "expanded", name: "expanded", description: "show every output in full" }] };

function chrome() { const r = `${homedir()}/.cache/ms-playwright`; for (const d of readdirSync(r).filter((d) => d.startsWith("chromium-")).sort().reverse()) { const b = `${r}/${d}/chrome-linux64/chrome`; if (existsSync(b)) return b; } }
const server = spawn("bunx", ["vite", "preview", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { stdio: "ignore", cwd: import.meta.dir + "/.." });
for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }
const browser = await chromium.launch({ executablePath: chrome() });

async function open(w, h, scheme, mobile) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, hasTouch: mobile, isMobile: mobile, colorScheme: scheme });
  await ctx.addInitScript((t) => localStorage.setItem("minitui.theme", t), scheme);
  const page = await ctx.newPage();
  await page.route("**/api/**", (route) => {
    const p = new URL(route.request().url()).pathname; const j = (b) => route.fulfill({ contentType: "application/json", body: JSON.stringify(b) });
    if (p === "/api/stream") return route.fulfill({ contentType: "text/event-stream", body: ": ok\n\n" });
    if (p === "/api/sessions") return j(meta);
    if (p === "/api/hosts") return j(hosts); if (p === "/api/models") return j(models); if (p === "/api/commands") return j(commands);
    if (p === "/api/skills") return j(skills); if (p === "/api/settings") return j(settings); if (p === "/api/providers") return j(providers);
    return j([]);
  });
  await page.routeWebSocket(/socket/, (ws) => ws.send(JSON.stringify({ t: "snapshot", id: "s1", session: { ...meta[0], events } })));
  await page.goto(`http://127.0.0.1:${PORT}/`); await page.waitForTimeout(1100);
  return { ctx, page };
}
// An image is only written when the page shows what it claims to show: a blank page, an error
// toast or a missing panel fails the run instead of being published.
async function shot(page, name, expect = []) {
  const text = await page.evaluate(() => document.body.innerText);
  for (const needle of expect) if (!text.includes(needle)) throw new Error(`${name}: expected "${needle}" on screen`);
  if (/Could not|Error|undefined|NaN/.test(text)) throw new Error(`${name}: an error string is on screen: ${text.match(/Could not[^\n]*|Error[^\n]*|undefined|NaN/)?.[0]}`);
  await page.screenshot({ path: `${out}/${name}.png` });
}

try {
  // desktop, dark: the chat, the model picker, the slash menu, settings
  let { ctx, page } = await open(1440, 900, "dark", false);
  await shot(page, "web-chat", ["Add retry with backoff", "retries up to", "Thought for 6s"]);
  await page.getByRole("button", { name: /^Model:/ }).click(); await page.waitForTimeout(500); await shot(page, "web-model-picker", ["CLIPROXY", "DEEPSEEK", "Claude Sonnet 5.5"]); await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "New chat" }).click(); await page.waitForTimeout(500); await shot(page, "web-new-chat", ["What should we work on?", "Commands", "Skills"]);
  await page.getByLabel("Prompt").fill("/"); await page.waitForTimeout(350); await shot(page, "web-commands", ["/new", "/model [id]", "/compact"]);
  await page.getByLabel("Prompt").fill("polish this with $bet"); await page.waitForTimeout(200); await page.keyboard.press("Tab"); await page.getByLabel("Prompt").fill("polish the settings page"); await page.waitForTimeout(300); if ((await page.getByRole("list", { name: "Added to this message" }).getByRole("group").count()) !== 1) throw new Error("web-chips: the chip is not in the bar");
  await shot(page, "web-chips", ["better-ui"]);
  await page.getByLabel("Prompt").fill("");
  await page.keyboard.press("Escape"); await page.waitForTimeout(200);
  await page.getByRole("button", { name: "Settings", exact: true }).first().click(); await page.waitForTimeout(600);
  const dlg = page.getByRole("dialog", { name: "Settings" });
  await dlg.getByRole("tab", { name: "Providers" }).click(); await page.waitForTimeout(500); await shot(page, "web-settings-providers", ["Connected", "sk-…a1b2", "Add a provider"]);
  await ctx.close();
  // desktop, light
  ({ ctx, page } = await open(1440, 900, "light", false)); await shot(page, "web-chat-light", ["Add retry with backoff"]); await ctx.close();
  // phone
  ({ ctx, page } = await open(390, 844, "dark", true)); await shot(page, "web-phone-chat", ["retries up to"]);
  await page.getByRole("button", { name: "Toggle sidebar" }).tap(); await page.waitForTimeout(500); await shot(page, "web-phone-sessions", ["Add retry with backoff", "New chat"]); await ctx.close();
} finally { await browser.close(); server.kill(); }
console.log("wrote", out);
