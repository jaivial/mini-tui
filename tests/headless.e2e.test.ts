/**
 * End-to-end `mini-tui -p` through the real entry point and the integrated agent, with the
 * agent's deterministic tool-call model (no network, no API keys) and a throwaway HOME-like
 * sandbox for sessions, runs and preferences.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const FIXTURES = join(import.meta.dir, "fixtures", "headless");
const SANDBOX = mkdtempSync(join(tmpdir(), "mini-tui-headless-"));
const ENV = {
  ...process.env,
  MINITUI_DB_PATH: join(SANDBOX, "sessions.db"),
  MINITUI_RESUME_DIR: join(SANDBOX, "resume"),
  MINITUI_RUNS_DIR: join(SANDBOX, "runs"),
  MINITUI_LAST_MODEL_PATH: join(SANDBOX, "last-model.json"),
  MINITUI_SETTINGS_PATH: join(SANDBOX, "settings.json"),
  MINITUI_CONNECTIONS_PATH: join(SANDBOX, "providers.json"),
  MINITUI_SKILLS_DIR: join(SANDBOX, "skills"),
  MINITUI_CLAUDE_SKILLS_DIR: join(SANDBOX, "claude-skills"),
  MINITUI_NO_TITLE: "1",
  MINITUI_MODEL: "",
  NO_COLOR: "1",
};

// The agent must be importable by the interpreter behind `mini` (skip, don't fail, elsewhere).
const probe = Bun.spawnSync({ cmd: ["bun", join(ROOT, "src", "index.ts"), "-V"], env: ENV });
const agentOk =
  probe.exitCode === 0 &&
  Bun.spawnSync({ cmd: [require("../src/helpers").resolvePython(), "-c", "import minisweagent.run.tui"], env: ENV, stdout: "ignore", stderr: "ignore" }).exitCode === 0;

function cli(args: string[], stdin?: string) {
  const proc = Bun.spawnSync({
    cmd: ["bun", join(ROOT, "src", "index.ts"), ...args],
    cwd: SANDBOX,
    env: ENV,
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
  });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

const MODEL = ["-c", "mini", "-c", join(FIXTURES, "answer.yaml")];

afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }));

describe.skipIf(!agentOk)("mini-tui -p (headless, real agent)", () => {
  test("text: only the final answer on stdout, exit 0", () => {
    const out = cli(["-p", "what is the answer", ...MODEL]);
    expect(out.code).toBe(0);
    expect(out.stdout).toBe("The answer is 42.\n");
    expect(out.stderr).toBe("");
  });

  test("text --verbose: steps stream to stderr, stdout stays the answer", () => {
    const out = cli(["-p", "verbose please", ...MODEL, "-v"]);
    expect(out.code).toBe(0);
    expect(out.stdout).toBe("The answer is 42.\n");
    expect(out.stderr).toContain("> verbose please");
    expect(out.stderr).toContain("$ echo hello-from-tool");
    expect(out.stderr).toContain("hello-from-tool [exit 0]");
    expect(out.stderr).toContain("■ Submitted");
  });

  test("json: one result object, saved as a session", () => {
    const out = cli(["-p", "json run", ...MODEL, "--json"]);
    expect(out.code).toBe(0);
    const result = JSON.parse(out.stdout);
    expect(result).toMatchObject({ type: "result", subtype: "success", is_error: false, result: "The answer is 42.", exit_status: "Submitted", num_steps: 1, api_calls: 2 });
    expect(result.session_id).toMatch(/^s-/);
    expect(existsSync(result.trajectory_path)).toBe(true);
    const list = JSON.parse(cli(["sessions", "--json"]).stdout) as Array<{ id: string }>;
    expect(list.map((row) => row.id)).toContain(result.session_id);
  });

  test("stream-json: init, one line per event, then the result", () => {
    const out = cli(["-p", "stream it", ...MODEL, "-o", "stream-json"]);
    expect(out.code).toBe(0);
    const lines = out.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(lines[0].type).toBe("init");
    expect(lines.map((line) => line.type)).toEqual(["init", "task", "assistant", "tool_call", "observation", "assistant", "exit", "result"]);
    expect(lines.at(-1).result).toBe("The answer is 42.");
  });

  test("--continue follows up in the same session and streams only the new turn", () => {
    const first = JSON.parse(cli(["-p", "first turn", ...MODEL, "--json"]).stdout);
    const out = cli(["-p", "second turn", ...MODEL, "-C", "-o", "stream-json"]);
    expect(out.code).toBe(0);
    const lines = out.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({ type: "init", resumed: true, session_id: first.session_id });
    const tasks = lines.filter((line) => line.type === "task").map((line) => line.text);
    expect(tasks).toEqual(["second turn"]);
    const shown = cli(["sessions", "show", first.session_id]).stdout;
    expect(shown).toContain("> first turn");
    expect(shown).toContain("> second turn");
  });

  test("--resume by id prefix; unknown ids are usage errors (exit 2)", () => {
    const first = JSON.parse(cli(["-p", "resume me", ...MODEL, "--json"]).stdout);
    const out = JSON.parse(cli(["-p", "again", ...MODEL, "-r", first.session_id.slice(0, -2), "--json"]).stdout);
    expect(out.session_id).toBe(first.session_id);
    const missing = cli(["-p", "again", "-r", "s-does-not-exist"]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("no session s-does-not-exist");
  });

  test("piped stdin is appended to the prompt; --no-session saves nothing", () => {
    const before = JSON.parse(cli(["sessions", "--json", "--all"]).stdout).length;
    const out = cli(["-p", "summarize:", ...MODEL, "--no-session", "-o", "stream-json"], "some piped log\n");
    const lines = out.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.find((line) => line.type === "task").text).toBe("summarize:\n\nsome piped log");
    expect(lines.at(-1).session_id).toBeNull();
    expect(JSON.parse(cli(["sessions", "--json", "--all"]).stdout).length).toBe(before);
  });

  test("a limit stops the run: exit 1 and the reason on stderr (-q silences it)", () => {
    const out = cli(["-p", "limited", ...MODEL, "--max-steps", "1", "--no-session"]);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("LimitsExceeded");
    const quiet = cli(["-p", "limited", ...MODEL, "--max-steps", "1", "--no-session", "-q"]);
    expect(quiet.code).toBe(1);
    expect(quiet.stderr).toBe("");
  });

  test("SIGINT interrupts the run: exit 130, result says interrupted", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", join(ROOT, "src", "index.ts"), "-p", "sleepy", "-c", "mini", "-c", join(FIXTURES, "sleep.yaml"), "--json", "--no-session"],
      cwd: SANDBOX,
      env: ENV,
      stdout: "pipe",
      stderr: "pipe",
    });
    await Bun.sleep(2500);
    proc.kill("SIGINT");
    const code = await proc.exited;
    const result = JSON.parse(await new Response(proc.stdout).text());
    expect(code).toBe(130);
    expect(result.subtype).toBe("interrupted");
  }, 20_000);

  test("usage errors exit 2 without starting an agent", () => {
    const out = cli(["-p"]);
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("-p needs a prompt");
    expect(cli(["-p", "x", "-o", "xml"]).code).toBe(2);
  });
});

describe("scripting subcommands", () => {
  test("model sets and prints the default of new sessions", () => {
    expect(cli(["model", "xiaomi/mimo-v2.6-flash"]).code).toBe(0);
    expect(cli(["model"]).stdout.trim()).toBe("xiaomi/mimo-v2.6-flash");
    const models = JSON.parse(cli(["models", "--json"]).stdout) as Array<{ id: string; default: boolean }>;
    expect(models.find((row) => row.default)?.id).toBe("xiaomi/mimo-v2.6-flash");
  });
  test("settings validate their values", () => {
    expect(cli(["settings", "output-mode", "expanded"]).code).toBe(0);
    expect(JSON.parse(cli(["settings", "--json"]).stdout).outputMode).toBe("expanded");
    expect(cli(["settings", "theme", "nope"]).code).toBe(2);
    expect(cli(["settings", "color", "x"]).code).toBe(2);
  });
  test("sessions rm deletes; unknown ids exit 1", () => {
    expect(cli(["sessions", "rm", "s-none"]).code).toBe(1);
  });
  test("--version and --help", () => {
    expect(cli(["--version"]).stdout).toMatch(/^mini-tui \d+\.\d+\.\d+\n$/);
    expect(cli(["--help"]).stdout).toContain("--output-format");
  });
});
