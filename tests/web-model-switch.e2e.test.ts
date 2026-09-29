/**
 * The web server with the real agent (deterministic model: no network, no key): a model change after a
 * finished or interrupted turn only changes the model. The agent really holds its process open at exit
 * waiting for a follow-up, which is exactly the state in which a switch used to read as "running".
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "minitui-web-model-"));
const FIX = join(import.meta.dir, "fixtures", "web-agent");
const saved = { ...process.env };
Object.assign(process.env, {
  MINITUI_DB_PATH: join(dir, "s.db"), MINITUI_CONFIG_DIR: dir, MINITUI_RESUME_DIR: join(dir, "r"), MINITUI_RUNS_DIR: join(dir, "u"),
  MINITUI_LAST_MODEL_PATH: join(dir, "l.json"), MINITUI_CONNECTIONS_PATH: join(dir, "p.json"), MINITUI_SETTINGS_PATH: join(dir, "st.json"),
  MINITUI_SKILLS_DIR: join(dir, "sk"), MSWEA_COST_TRACKING: "ignore_errors",
});
delete process.env.MINITUI_MINI_BIN;
delete process.env.MINITUI_EMBEDDED_AGENT;
afterAll(() => {
  for (const k of ["MINITUI_DB_PATH", "MINITUI_CONFIG_DIR", "MINITUI_RESUME_DIR", "MINITUI_RUNS_DIR", "MINITUI_LAST_MODEL_PATH", "MINITUI_CONNECTIONS_PATH", "MINITUI_SETTINGS_PATH", "MINITUI_SKILLS_DIR", "MSWEA_COST_TRACKING", "MSWEA_MINI_CONFIG_PATH"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  if (saved.MINITUI_MINI_BIN !== undefined) process.env.MINITUI_MINI_BIN = saved.MINITUI_MINI_BIN;
  if (saved.MINITUI_EMBEDDED_AGENT !== undefined) process.env.MINITUI_EMBEDDED_AGENT = saved.MINITUI_EMBEDDED_AGENT;
  rmSync(dir, { recursive: true, force: true });
});

const { SessionManager } = await import("../src/web/sessions");
const { detectRunner } = await import("../src/mini/spawn");
const agentOk = detectRunner() !== "cli";

const journalLen = (m: InstanceType<typeof SessionManager>, id: string) => (m.get(id)!.messages?.length ?? 0);
async function until(ok: () => boolean, ms = 15000) {
  for (let t = 0; t < ms / 100 && !ok(); t++) await Bun.sleep(100);
  return ok();
}

describe.skipIf(!agentOk)("web: switching model never starts work", () => {
  test("after a finished answer: status stays done, nothing is sent to the agent", async () => {
    process.env.MSWEA_MINI_CONFIG_PATH = join(FIX, "answer.yaml");
    const m = new SessionManager(() => {});
    const s = await m.create({ prompt: "what is the answer", target: "local", cwd: dir });
    expect(await until(() => m.get(s.id)!.status === "done")).toBe(true);
    const before = journalLen(m, s.id);
    m.setModel(s.id, "deterministic");
    await Bun.sleep(1500);
    expect(m.get(s.id)!.status).toBe("done");
    expect(journalLen(m, s.id)).toBe(before);
    const notice = m.get(s.id)!.events.at(-1) as { type: string; text: string };
    expect(notice.text).toMatch(/from your next message/); // not "from next step": nothing is running
    m.close(s.id);
  }, 25000);

  test("after an interrupt: status stays interrupted, nothing restarts", async () => {
    process.env.MSWEA_MINI_CONFIG_PATH = join(FIX, "sleep.yaml");
    const m = new SessionManager(() => {});
    const s = await m.create({ prompt: "sleep a while", target: "local", cwd: dir });
    await Bun.sleep(1500);
    m.interrupt(s.id);
    expect(await until(() => m.get(s.id)!.status === "interrupted")).toBe(true);
    await Bun.sleep(800);
    const before = journalLen(m, s.id);
    m.setModel(s.id, "deterministic");
    await Bun.sleep(1500);
    expect(m.get(s.id)!.status).toBe("interrupted");
    expect(journalLen(m, s.id)).toBe(before);
    m.close(s.id);
  }, 25000);

  test("during a run: the switch goes to the agent and applies from its next step", async () => {
    process.env.MSWEA_MINI_CONFIG_PATH = join(FIX, "sleep.yaml");
    const m = new SessionManager(() => {});
    const s = await m.create({ prompt: "sleep a while", target: "local", cwd: dir });
    await Bun.sleep(1200);
    m.setModel(s.id, "deterministic");
    expect(m.get(s.id)!.status).toBe("running");
    expect((m.get(s.id)!.events.at(-1) as { text: string }).text).toMatch(/from next step/);
    m.close(s.id);
  }, 25000);
});
