/**
 * The TUI with the real agent (deterministic model: no network, no key). After a finished or an
 * interrupted turn, `/model` must only change the model: the status line stays put and the agent gets
 * no work. And after a double-Esc interrupt the prompt keeps focus, so ↑ recalls the last prompt.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
const dir = mkdtempSync(join(tmpdir(), "mt-tui-real-"));
Object.assign(process.env, { MINITUI_RUNS_DIR: join(dir, "runs"), MINITUI_DB_PATH: join(dir, "s.db"), MINITUI_RESUME_DIR: join(dir, "r"), MINITUI_CONNECTIONS_PATH: "/dev/null/x.json", MINITUI_LAST_MODEL_PATH: "/dev/null/y.json", MINITUI_NO_TITLE: "1" });
const savedEnv = { bin: process.env.MINITUI_MINI_BIN, embedded: process.env.MINITUI_EMBEDDED_AGENT };
delete process.env.MINITUI_MINI_BIN;
delete process.env.MINITUI_EMBEDDED_AGENT;
/** Stop any agent a test started (they live under this test's own temp dir, nowhere else). */
function stopAgents() {
  const out = Bun.spawnSync({ cmd: ["ps", "-eo", "pid=,args="] }).stdout.toString();
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && m[2]!.includes("minisweagent") && m[2]!.includes(dir)) {
      try {
        process.kill(Number(m[1]), "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
}
afterAll(() => {
  stopAgents();
  if (savedEnv.bin !== undefined) process.env.MINITUI_MINI_BIN = savedEnv.bin;
  if (savedEnv.embedded !== undefined) process.env.MINITUI_EMBEDDED_AGENT = savedEnv.embedded;
  rmSync(dir, { recursive: true, force: true });
});
const { App } = await import("../src/ui/App");
const { detectRunner } = await import("../src/mini/spawn");
const agentOk = detectRunner() !== "cli";
const FIX = join(import.meta.dir, "fixtures", "headless");
const journals = () => { const out: string[] = []; const walk = (d: string) => { if (!existsSync(d)) return; for (const f of readdirSync(d, { withFileTypes: true })) f.isDirectory() ? walk(join(d, f.name)) : f.name.endsWith(".jsonl") && out.push(join(d, f.name)); }; walk(join(dir, "runs")); return out; };
const msgs = () => journals().flatMap((j) => readFileSync(j, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.t === "msg").map((l) => l.m.role));
describe.skipIf(!agentOk)("TUI: /model after a turn only changes the model", () => {
test("TUI + real agent: after the answer, /model only changes the model", async () => {
  const setup = await testRender(<App cwd={dir} runSpec={{ task: "what is the answer", specs: ["mini", join(FIX, "answer.yaml")], cwd: dir }} persistSettings={false} onQuit={() => {}} />, { width: 100, height: 24 });
  const frame = async () => { await setup.renderOnce(); return setup.captureCharFrame(); };
  for (let i = 0; i < 100 && !(await frame()).includes("● done"); i++) await Bun.sleep(100);
  const n = msgs().length;
  await setup.mockInput.typeText("/model deterministic");
  await Bun.sleep(30);
  await act(async () => setup.mockInput.pressEnter());
  await act(async () => setup.mockInput.pressEnter());
  await Bun.sleep(2500);
  const f = await frame();
  expect(f).toContain("● done");
  expect(msgs().length).toBe(n);
  setup.renderer.destroy();
  stopAgents();
}, 25000);
test("TUI + real agent: interrupt, then /model: stays interrupted, arrows recall, nothing restarts", async () => {
  const setup = await testRender(<App cwd={dir} runSpec={{ task: "sleepy task", specs: ["mini", join(FIX, "sleep.yaml")], cwd: dir }} persistSettings={false} onQuit={() => {}} />, { width: 100, height: 24 });
  const frame = async () => { await setup.renderOnce(); return setup.captureCharFrame(); };
  await Bun.sleep(2500);
  setup.mockInput.pressEscape(); await Bun.sleep(100); setup.mockInput.pressEscape(); await Bun.sleep(100);
  for (let i = 0; i < 60 && !(await frame()).includes("interrupted"); i++) await Bun.sleep(100);
  const n = msgs().length;
  await setup.mockInput.typeText("/model deterministic");
  await Bun.sleep(30);
  await act(async () => setup.mockInput.pressEnter());
  await act(async () => setup.mockInput.pressEnter());
  await Bun.sleep(2000);
  const f = await frame();
  await act(async () => setup.mockInput.pressArrow("up"));
  await Bun.sleep(40);
  const g = await frame();
  expect(f).toContain("interrupted");
  expect(g).toContain("/model deterministic");
  expect(msgs().length).toBe(n);
  setup.renderer.destroy();
  stopAgents();
}, 25000);
});
