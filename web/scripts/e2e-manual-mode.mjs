// Real-browser end-to-end for manual chat mode: Settings -> Manual, a workspace added through the
// "New workspace" dialog (its folder chosen in the folder browser), a session started in it, a reply
// on screen, the session listed under its workspace, a reload that lands on it, a session in a
// subfolder that stays listed after it is closed, a second tab that
// follows a mode switch live, and the switch back to the dispatcher layout.
//
// Everything runs against a throwaway server (temp config, database and settings; a port in 7900-7999)
// with a fake agent standing in for the model (tests/helpers/fake-agent.ts), so nothing is spent and
// nothing of the developer's own setup is read or written. Run after `bun run build` in web/:
//   cd web && bun scripts/e2e-manual-mode.mjs
// Screenshots go to /tmp/minitui-manual-*.png (MANUAL_SHOTS_DIR to change).
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.env.MINITUI_E2E_ROOT ?? join(import.meta.dir, "..", "..");
const shots = process.env.MANUAL_SHOTS_DIR ?? "/tmp";
const dir = mkdtempSync(join(tmpdir(), "minitui-e2e-manual-"));
const projects = join(dir, "projects");
const folder = join(projects, "project-alpha");
mkdirSync(join(folder, ".git"), { recursive: true });
mkdirSync(join(folder, "api"), { recursive: true });
mkdirSync(join(projects, "project-beta"), { recursive: true });

const freePort = async () => {
  const start = 7900 + Math.floor(Math.random() * 80);
  for (let i = 0; i < 100; i++) {
    const p = 7900 + ((start - 7900 + i) % 100);
    try {
      const l = Bun.listen({ hostname: "127.0.0.1", port: p, socket: { data() {}, error() {} } });
      l.stop(true);
      return p;
    } catch {
      /* taken */
    }
  }
  throw new Error("no free port in 7900-7999");
};
const PORT = Number(process.env.PORT ?? (await freePort()));
if (PORT === 4317) throw new Error("refusing to drive the live server's port");
const base = `http://127.0.0.1:${PORT}`;

const { makeFakeAgent } = await import(join(root, "tests/helpers/fake-agent.ts"));
const fake = makeFakeAgent(join(dir, "bin"), { holdMs: 300 });
const server = spawn(process.execPath, [join(root, "src/web/serve.ts"), "--port", String(PORT)], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    MINITUI_MINI_BIN: fake.script,
    MINITUI_EMBEDDED_AGENT: "0",
    MINITUI_WEB_TERMINAL: "0",
    MINITUI_LAST_MODEL_PATH: join(dir, "last-model.json"),
    MINITUI_CONNECTIONS_PATH: join(dir, "providers.json"),
    MINITUI_SETTINGS_PATH: join(dir, "settings.json"),
    MINITUI_SKILLS_DIR: join(dir, "skills"),
    MINITUI_DB_PATH: join(dir, "sessions.db"),
    MINITUI_CONFIG_DIR: dir,
    MINITUI_RESUME_DIR: join(dir, "resume"),
    MINITUI_RUNS_DIR: join(dir, "runs"),
  },
});
server.stderr.on("data", (b) => process.env.E2E_VERBOSE && console.log("  [server]", String(b).trim()));
server.stdout.on("data", (b) => process.env.E2E_VERBOSE && console.log("  [server]", String(b).trim()));
let up = false;
for (let i = 0; i < 100 && !up; i++) {
  try {
    up = (await fetch(`${base}/api/health`)).ok;
  } catch {}
  if (!up) await Bun.sleep(100);
}
if (!up) throw new Error(`server did not start on ${PORT}`);

let failed = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failed++;
};
const api = async (path, init) => (await fetch(`${base}/api${path}`, init)).json();

const browser = await chromium.launch({ executablePath: process.env.E2E_CHROME ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const errors = [];
const watch = (page) => {
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource|WebSocket/.test(m.text())) errors.push(`console: ${m.text().slice(0, 200)}`);
  });
};
const page = await ctx.newPage();
watch(page);
const visible = async (locator, ms = 8000) => {
  try {
    await locator.first().waitFor({ state: "visible", timeout: ms });
    return true;
  } catch {
    return false;
  }
};

try {
  await page.goto(base);
  check("boots in the dispatcher layout", await visible(page.getByText("Main conversation")));
  check("dispatcher shows the Tasks toggle", await visible(page.getByRole("button", { name: "Toggle tasks" })));

  // ---- Settings -> Manual
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const manualRadio = page.getByRole("radio", { name: /Manual/ });
  await manualRadio.waitFor();
  await manualRadio.click();
  await page.waitForFunction(() => document.querySelector('[role="radio"][aria-checked="true"]')?.textContent?.includes("Manual"));
  check("the Work queue fieldset is hidden in manual mode", !(await page.getByText("Work queue", { exact: true }).isVisible()));
  const settings = await api("/settings");
  check("the server saved chatMode=manual", settings.chatMode === "manual", JSON.stringify(settings.chatMode));
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, "minitui-manual-settings.png") });
  await page.keyboard.press("Escape");
  check("manual sidebar: empty state", await visible(page.getByText("Add a workspace to start")));
  check("manual mode hides the Tasks toggle", !(await page.getByRole("button", { name: "Toggle tasks" }).isVisible()));
  await page.screenshot({ path: join(shots, "minitui-manual-empty.png") });

  // ---- a second tab, to see a mode switch arrive live later
  const page2 = await ctx.newPage();
  watch(page2);
  await page2.goto(base);
  check("a second tab opens in manual mode too", await visible(page2.getByText("Add a workspace to start")));

  // ---- New workspace through the dialog and its folder browser
  await page.getByRole("button", { name: "New workspace" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New workspace" });
  await dialog.waitFor();
  const pathField = dialog.getByLabel("Folder", { exact: true });
  await pathField.fill(projects);
  await pathField.press("Enter");
  const entry = dialog.getByRole("option", { name: /project-alpha/ });
  check("the folder browser lists the folder", await visible(entry));
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(shots, "minitui-manual-dialog-browse.png") });
  await entry.click();
  await page.waitForFunction((want) => [...document.querySelectorAll("dialog[open] input")].some((i) => i.value === want), folder);
  check("browsing into a folder fills the path", (await pathField.inputValue()) === folder, await pathField.inputValue());
  await dialog.getByPlaceholder(/project-alpha/).waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, "minitui-manual-dialog.png") });
  // A folder that does not exist: the server's refusal is shown in the dialog.
  await pathField.fill(join(projects, "missing"));
  await dialog.getByRole("button", { name: "Create workspace" }).click();
  check("a bad folder is refused inline", await visible(dialog.getByRole("alert")), (await dialog.getByRole("alert").textContent().catch(() => ""))?.trim());
  await pathField.fill(folder);
  await dialog.getByRole("button", { name: "Create workspace" }).click();
  await dialog.waitFor({ state: "hidden" });
  const section = page.locator('section[aria-label="project-alpha"]');
  check("the workspace is in the sidebar", await visible(section));
  const saved = await api("/workspaces");
  check("the server saved the workspace", saved.workspaces?.length === 1 && saved.workspaces[0].path === folder, JSON.stringify(saved.workspaces?.map((w) => w.path)));
  check("a new-session draft in it", await visible(page.getByRole("heading", { name: "New session in project-alpha" })));
  check("the second tab sees the workspace live", await visible(page2.locator('section[aria-label="project-alpha"]')));

  // ---- start a session and read the reply
  const prompt = page.getByRole("combobox", { name: "Prompt" });
  await prompt.fill("hello manual mode");
  await prompt.press("Enter");
  check("the reply is in the transcript", await visible(page.getByText("fake reply to: hello manual mode"), 15000));
  const live = await api("/sessions");
  const created = live.find((s) => s.cwd === folder);
  check("the session runs in the workspace folder", !!created, JSON.stringify(live.map((s) => s.cwd)));
  check("the agent ran in that folder", fake.calls().some((c) => c.cwd === folder), JSON.stringify(fake.calls().map((c) => c.cwd)));
  const row = section.locator('ul button[aria-current="page"]');
  check("the session is listed under its workspace, current", await visible(row));
  await page.waitForFunction(() => !document.querySelector(".pulse-live"), null, { timeout: 10000 }).catch(() => {});
  await page.screenshot({ path: join(shots, "minitui-manual-session.png") });
  await page.locator("aside").first().screenshot({ path: join(shots, "minitui-manual-sidebar.png") });

  // ---- a follow-up goes to the same session
  await page.waitForFunction(() => !document.querySelector('[aria-label="Stop"]'), null, { timeout: 10000 }).catch(() => {});
  await prompt.fill("second message");
  await prompt.press("Enter");
  check("the follow-up's reply is in the same transcript", await visible(page.getByText("fake reply to: second message"), 15000));
  check("still one session in the workspace", (await api("/sessions")).filter((s) => s.cwd === folder).length === 1);

  // ---- New session (Ctrl/Cmd K) is a draft in the same workspace
  await page.keyboard.press("Control+k");
  check("Ctrl+K starts a draft in the current workspace", await visible(page.getByRole("heading", { name: "New session in project-alpha" })));
  await row.waitFor({ state: "detached", timeout: 3000 }).catch(() => {});
  await section.locator("ul button").first().click();
  check("clicking the row opens the session again", await visible(page.getByText("fake reply to: second message")));

  // ---- reload lands on the same session
  await page.reload();
  check("after a reload: the same session is on screen", await visible(page.getByText("fake reply to: second message"), 10000));
  check("after a reload: its row is current", await visible(page.locator('section[aria-label="project-alpha"] ul button[aria-current="page"]')));

  // ---- a phone: the sidebar is a drawer, and opening a session closes it
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  check("phone: the session is on screen", await visible(page.getByText("fake reply to: second message"), 10000));
  await page.getByRole("button", { name: "Toggle workspaces" }).click();
  const drawer = page.getByRole("dialog", { name: "Workspaces and sessions" });
  check("phone: the workspaces drawer opens", await visible(drawer.locator('section[aria-label="project-alpha"]')));
  // The drawer fades in; a screenshot taken mid-fade shows nothing.
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".workspace-panel")).opacity === "1", null, { timeout: 3000 }).catch(() => {});
  await page.screenshot({ path: join(shots, "minitui-manual-mobile.png") });
  await drawer.locator('section[aria-label="project-alpha"] ul button').first().click();
  check("phone: opening a session closes the drawer", await drawer.waitFor({ state: "hidden", timeout: 3000 }).then(() => true, () => false));
  await page.setViewportSize({ width: 1440, height: 900 });

  // ---- a session in a subfolder of the workspace is listed under it, also once it is closed
  const subfolder = join(folder, "api");
  const subSession = await api("/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "subfolder work", cwd: subfolder, target: "local" }) });
  const subRow = section.locator("ul button", { hasText: "subfolder work" });
  check("subfolder: the live session is under the workspace", await visible(subRow));
  for (let i = 0; i < 100; i++) {
    const s = (await api("/sessions")).find((x) => x.id === subSession.id);
    if (!s || s.status !== "running") break;
    await Bun.sleep(100);
  }
  await fetch(`${base}/api/sessions/${subSession.id}`, { method: "DELETE" });
  check("subfolder: the session is closed", !(await api("/sessions")).some((s) => s.id === subSession.id));
  const byWorkspace = await api("/workspaces/sessions?limit=30");
  check("subfolder: the server lists it under the workspace", (byWorkspace[saved.workspaces[0].id] ?? []).some((h) => h.id === subSession.id), JSON.stringify(Object.values(byWorkspace).flat().map((h) => h.cwd)));
  await page.waitForTimeout(600);
  check("subfolder: still under the workspace once closed", await visible(subRow));
  await page.reload();
  check("subfolder: still under the workspace after a reload", await visible(page.locator('section[aria-label="project-alpha"] ul button', { hasText: "subfolder work" }), 10000));

  // ---- rename, then remove the workspace (its sessions stay)
  await page.getByRole("button", { name: "Options for project-alpha" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const nameField = page.getByRole("textbox", { name: "Workspace name" });
  await nameField.fill("Alpha app");
  await nameField.press("Enter");
  check("rename: the sidebar shows the new name", await visible(page.locator('section[aria-label="Alpha app"]')));
  check("rename: the server saved it", (await api("/workspaces")).workspaces?.[0]?.name === "Alpha app");
  await page.getByRole("button", { name: "Options for Alpha app" }).click();
  await page.getByRole("menuitem", { name: "Remove workspace" }).click();
  await page.getByRole("menu").getByRole("button", { name: "Remove", exact: true }).click();
  check("remove: back to the empty state", await visible(page.getByText("Add a workspace to start")));
  check("remove: the server forgot it", (await api("/workspaces")).workspaces?.length === 0);
  check("remove: the session is kept", (await api(`/history?limit=10`)).some((h) => h.cwd === folder));

  // ---- back to the dispatcher
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("radio", { name: /Dispatcher/ }).click();
  await page.waitForFunction(() => document.querySelector('[role="radio"][aria-checked="true"]')?.textContent?.includes("Dispatcher"));
  check("the Work queue fieldset is back", await visible(page.getByText("Work queue", { exact: true })));
  await page.keyboard.press("Escape");
  check("dispatcher layout: Main conversation", await visible(page.getByText("Main conversation")));
  check("dispatcher layout: Tasks toggle", await visible(page.getByRole("button", { name: "Toggle tasks" })));
  check("dispatcher layout: the dispatcher's empty chat", await visible(page.getByText("What should get done?")));
  check("the second tab followed the switch without a reload", await visible(page2.getByText("Main conversation"), 8000));
  await page.screenshot({ path: join(shots, "minitui-manual-back-to-dispatcher.png") });
} catch (error) {
  failed++;
  console.log("FAIL  unexpected:", error?.message ?? error);
  await page.screenshot({ path: join(shots, "minitui-manual-failure.png") }).catch(() => {});
} finally {
  check("no page errors", errors.length === 0, errors.slice(0, 5).join(" | "));
  await browser.close();
  server.kill();
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
