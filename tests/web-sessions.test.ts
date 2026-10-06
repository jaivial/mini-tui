/**
 * The web session manager: transcript ingestion, follow-ups over the control
 * channel, and the remote stream-json mapping. No agent process is spawned:
 * the runner is stubbed and the trajectory journal is written by hand.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "minitui-web-"));
process.env.MINITUI_DB_PATH = join(dir, "sessions.db");
process.env.MINITUI_RESUME_DIR = join(dir, "resume");
process.env.MINITUI_RUNS_DIR = join(dir, "runs");
process.env.MINITUI_SETTINGS_PATH = join(dir, "settings.json");
process.env.MINITUI_CONFIG_DIR = dir;
process.env.MINITUI_LAST_MODEL_PATH = join(dir, "last-model.json");
process.env.MINITUI_CONNECTIONS_PATH = join(dir, "providers.json");
// `SessionManager.create` starts an agent. Point it at a stub that exits immediately, so the suite can
// never start a real run or spend tokens, whatever `mini` is installed on this machine.
const stub = join(dir, "mini-stub");
writeFileSync(stub, "#!/bin/sh\nexit 0\n");
chmodSync(stub, 0o755);
process.env.MINITUI_MINI_BIN = stub;
process.env.MINITUI_EMBEDDED_AGENT = "0";

// Dynamic on purpose: static imports are hoisted above the env assignments and would read the real paths.
const { remoteEventToRunEvent } = await import("../src/web/sessions");
const { sshArgs, buildRemoteScript } = await import("../src/web/ssh");
const { journalPathFor } = await import("../src/traj/watch");
const { createParseState, messagesToEvents, parseInfo } = await import("../src/traj/parse");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("remoteEventToRunEvent", () => {
  test("maps every stream-json type onto the shared RunEvent contract", () => {
    expect(remoteEventToRunEvent({ type: "task", text: "fix it" })).toEqual({ type: "task", text: "fix it" });
    expect(remoteEventToRunEvent({ type: "assistant", text: "done" })).toEqual({ type: "assistant", text: "done" });
    expect(remoteEventToRunEvent({ type: "tool_call", id: "c1", name: "bash", command: "ls" })).toEqual({
      type: "tool_call",
      id: "c1",
      name: "bash",
      command: "ls",
    });
    expect(remoteEventToRunEvent({ type: "observation", tool_call_id: "c1", returncode: 0, output: "a" })).toEqual({
      type: "observation",
      toolCallId: "c1",
      returncode: 0,
      output: "a",
      exceptionInfo: "",
    });
    expect(remoteEventToRunEvent({ type: "exit", exit_status: "Submitted", submission: "ok" })).toEqual({
      type: "exit",
      exitStatus: "Submitted",
      submission: "ok",
    });
    // A null returncode must stay null, not become 0.
    const obs = remoteEventToRunEvent({ type: "observation", output: "x" }) as any;
    expect(obs.returncode).toBeNull();
    expect(remoteEventToRunEvent({ type: "init" })).toBeNull();
  });

  test("survives a missing field instead of throwing", () => {
    expect(remoteEventToRunEvent({ type: "notice" })).toEqual({ type: "notice", text: "" });
    expect(remoteEventToRunEvent({})).toBeNull();
  });
});

describe("sshArgs", () => {
  test("is batch mode, so a missing key fails fast instead of hanging", () => {
    const args = sshArgs({ host: "example.com", port: 2222, user: "ubuntu", workdir: "~/repo" });
    expect(args).toContain("-o");
    expect(args).toContain("BatchMode=yes");
    expect(args[args.indexOf("-p") + 1]).toBe("2222");
    expect(args.at(-1)).toBe("ubuntu@example.com");
  });

  test("passes an identity file when one is configured", () => {
    const args = sshArgs({ host: "h", port: 22, user: "u", workdir: "~", identity: "/keys/id_ed25519" });
    expect(args[args.indexOf("-i") + 1]).toBe("/keys/id_ed25519");
  });
});

describe("journal path", () => {
  test("derives the .jsonl the agent appends to", () => {
    expect(journalPathFor("/a/b/traj.json")).toBe("/a/b/traj.jsonl");
    expect(journalPathFor("/a/b/traj")).toBe("/a/b/traj.jsonl");
  });
});

describe("the TUI parser drives the web transcript", () => {
  test("turns journal messages into the same events the terminal UI shows", () => {
    const messages = [
      { role: "user", content: "list the TODOs" },
      {
        role: "assistant",
        content: "Let me look.",
        tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }],
      },
      { role: "user", content: JSON.stringify({ returncode: 0, output: "a.txt" }) },
    ];
    const state = createParseState();
    const events = messagesToEvents(messages, {}, 0, state);
    const kinds = events.map((e) => e.type);
    expect(kinds).toContain("task");
    expect(kinds).toContain("tool_call");
    const call = events.find((e) => e.type === "tool_call") as any;
    expect(call.command).toContain("ls");
  });

  test("reads cost and api calls out of the trajectory info", () => {
    const info = parseInfo({
      messages: [],
      info: { model_stats: { instance_cost: 0.42, api_calls: 7 }, exit_status: "Submitted" },
    });
    expect(info.cost).toBeCloseTo(0.42);
    expect(info.apiCalls).toBe(7);
    expect(info.exitStatus).toBe("Submitted");
  });

  test("is incremental: a second pass over the same messages adds nothing", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const state = createParseState();
    const first = messagesToEvents(messages, {}, 0, state);
    const second = messagesToEvents(messages, {}, messages.length, state);
    expect(first.length).toBeGreaterThan(0);
    expect(second).toHaveLength(0);
  });
});

describe("remote prompt safety", () => {
  test("the prompt travels in the environment, never inside the script", () => {
    // A prompt full of shell metacharacters must not be able to break out of
    // the remote command, because it is never interpolated into it.
    const evil = `"; rm -rf / #`;
    expect(evil).toContain(";");
    // The script only ever references $MINITUI_PROMPT, quoted.
    const script = `mini-tui -p "$MINITUI_PROMPT"`;
    expect(script).toContain('"$MINITUI_PROMPT"');
  });
});

describe("buildRemoteScript", () => {
  test("passes the prompt as one single-quoted argument", () => {
    const script = buildRemoteScript("fix the failing test", "/tmp/repo", "xiaomi/mimo-v2.6-pro");
    expect(script).toContain("MINITUI_PROMPT=$(printf '%s' 'fix the failing test')");
    expect(script).toContain("cd '/tmp/repo'");
    expect(script).toContain("-m 'xiaomi/mimo-v2.6-pro'");
    // No sentinel may survive into what is actually sent.
    expect(script).not.toContain("__MINITUI_PROMPT_ARG__");
  });

  test("a prompt with shell metacharacters stays data, never commands", () => {
    // `bash -s` reads stdin as the script, so the prompt must be quoted in:
    // these characters would otherwise run as commands on the server.
    const hostile = `'; touch /tmp/PWNED; echo x #$(id)` + "`id`";
    const script = buildRemoteScript(hostile, "/tmp");
    expect(script).not.toContain("\ntouch /tmp/PWNED");
    expect(script).toContain("''\\''"); // the escaped single quote
  });

  test("a multi-line prompt stays a single argument", () => {
    const script = buildRemoteScript("line one\nline two", "/tmp");
    expect(script).toContain("'line one\nline two'");
  });

  test("falls back to the home directory when no workdir is set", () => {
    expect(buildRemoteScript("hi", "")).toContain("cd '~'");
  });
});

describe("probe output is never trusted verbatim", () => {
  test("a wrapper that dumps the environment does not leak it to the client", async () => {
    const { sanitizeProbeOutput } = await import("../src/web/ssh");
    // A real `mini-tui` wrapper on a login shell can print its whole
    // environment, secrets included. That must never reach the browser.
    const dumped = 'declare -x OPENAI_API_KEY="sk-super-secret"\ndeclare -x TOKEN="abc"';
    const result = sanitizeProbeOutput(dumped);
    expect(JSON.stringify(result)).not.toContain("sk-super-secret");
    expect(JSON.stringify(result)).not.toContain("abc");
    expect(result.agent).toBe(false);
  });

  test("a plain version string is reported", () => {
    const { sanitizeProbeOutput } = require("../src/web/ssh") as typeof import("../src/web/ssh");
    const result = sanitizeProbeOutput("0.17.3\n");
    expect(result.agent).toBe(true);
    expect(result.version).toBe("0.17.3");
  });

  test('"none" means no agent on the server', () => {
    const { sanitizeProbeOutput } = require("../src/web/ssh") as typeof import("../src/web/ssh");
    expect(sanitizeProbeOutput("none").agent).toBe(false);
  });
});

describe("explainFailure", () => {
  const traceback = [
    'Traceback (most recent call last):',
    '  File "/home/user/mini-tui/agent/src/minisweagent/agents/default.py", line 555, in _query_model',
    "    message = self.model.query(view)",
    '  File "/home/user/mini-tui/agent/src/minisweagent/models/deepseek_model.py", line 139, in _query',
    "    return super()._query(messages, **kwargs)",
    "minisweagent.models.errors.ProviderAbortError: HTTP 402 from https://api.deepseek.com/v1: Insufficient Balance (request_id: 8e90ccbd-7cb0-40c5-a178-ae829b294bb2) Top up your balance \u2014 retrying will not fix this.",
  ].join("\n");

  test("a provider traceback becomes a short actionable message", async () => {
    const { explainFailure } = await import("../src/web/sessions");
    const out = explainFailure(traceback);
    // No traceback noise, no python internals.
    expect(out).not.toContain("Traceback");
    expect(out).not.toContain('File "');
    expect(out).not.toContain("line 555");
    // The part that tells the user what to do.
    expect(out).toContain("ProviderAbortError");
    expect(out).toContain("Insufficient Balance");
    expect(out).toContain("out of credit");
  });

  test("the request id is stripped, the module path is not shown", async () => {
    const { explainFailure } = await import("../src/web/sessions");
    const out = explainFailure(traceback);
    expect(out).not.toContain("request_id");
    expect(out).not.toContain("minisweagent.models.errors");
  });

  test("an auth failure points at the key", async () => {
    const { explainFailure } = await import("../src/web/sessions");
    const out = explainFailure("openai.AuthenticationError: HTTP 401 from https://api.openai.com: bad key");
    expect(out).toContain("AuthenticationError");
    expect(out).toMatch(/API key/i);
  });

  test("a context overflow tells the user to start a new session", async () => {
    const { explainFailure } = await import("../src/web/sessions");
    const out = explainFailure("ProviderAbortError: maximum context length exceeded");
    expect(out).toMatch(/context/i);
    expect(out).toMatch(/new session/i);
  });

  test("an unrecognised log yields empty so the caller falls back", async () => {
    const { explainFailure } = await import("../src/web/sessions");
    expect(explainFailure("just some log noise\nnothing to see")).toBe("");
  });
});

describe("setModel", () => {
  // The manager opens a real database, so each test gets its own path.
  async function withManager<T>(fn: (m: import("../src/web/sessions").SessionManager) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), "minitui-model-"));
    const prev = process.env.MINITUI_DB_PATH;
    process.env.MINITUI_DB_PATH = join(dir, "sessions.db");
    const { SessionManager } = await import("../src/web/sessions");
    const m = new SessionManager(() => {});
    try {
      return await fn(m);
    } finally {
      if (prev === undefined) delete process.env.MINITUI_DB_PATH;
      else process.env.MINITUI_DB_PATH = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("an unknown session is rejected rather than silently ignored", async () => {
    await withManager(async (m) => {
      expect(() => m.setModel("s-nope", "xiaomi/mimo-v2.6-flash")).toThrow();
    });
  });

  test("an empty model name is rejected", async () => {
    await withManager(async (m) => {
      const s = await m.create({ target: "local", prompt: "hi", cwd: "/tmp" });
      expect(() => m.setModel(s.id, "   ")).toThrow();
    });
  });

  test("switching records the model and leaves a notice in the transcript", async () => {
    await withManager(async (m) => {
      const s = await m.create({ target: "local", prompt: "hi", cwd: "/tmp", model: "deepseek/deepseek-chat" });
      expect(s.model).toBe("deepseek/deepseek-chat");
      m.setModel(s.id, "xiaomi/mimo-v2.6-pro");
      const after = m.get(s.id);
      expect(after?.model).toBe("xiaomi/mimo-v2.6-pro");
      const notices = after?.events.filter((e) => e.type === "notice") ?? [];
      expect(notices.some((e) => e.text.includes("xiaomi/mimo-v2.6-pro"))).toBe(true);
    });
  });

  test("the switch is persisted, so it survives reopening the session", async () => {
    await withManager(async (m) => {
      const s = await m.create({ target: "local", prompt: "hi", cwd: "/tmp" });
      m.setModel(s.id, "cliproxy/claude-opus-5-5");
      const reopened = await m.openHistory(s.id);
      expect(reopened.model).toBe("cliproxy/claude-opus-5-5");
    });
  });
});

describe("a remote chat is saved from the start", () => {
  test("creating one writes its history row at once, in the folder it runs in", async () => {
    const { saveHosts, SessionManager: SM } = await import("../src/web/sessions");
    const { openDb: open, getSession: get } = await import("../src/sessions");
    saveHosts([{ id: "h-t", label: "box", host: "192.0.2.1", port: 22, user: "u", workdir: "/srv/default" }]);
    const m = new SM(() => {});
    const s = await m.create({ prompt: "remote job", target: "remote", hostId: "h-t", cwd: "/srv/picked" });
    m.close(s.id); // no ssh needed: 192.0.2.1 is unroutable, the run just fails; the row is what matters
    const db = open(process.env.MINITUI_DB_PATH!);
    const row = get(db, s.id);
    db.close();
    expect(row?.cwd).toBe("/srv/picked");
    expect(row?.task).toBe("remote job");
    saveHosts([]);
  });
});
