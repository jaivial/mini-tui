/**
 * The remote folder listing (`listRemote`) — the LAST copy of "spawn a child and read it", measured
 * against the deployed code (7f4df26) as three defects and one lie:
 *
 * 1. **No byte budget.** `new Response(proc.stdout).text()` with no cap: a remote host answering 200 MiB
 *    on EITHER stream grew the process from 19 MiB to **628 MiB RSS** and then answered 502.
 * 2. **The deadline was SIGTERM and nothing else.** `proc.kill()` is TERM, so a child that ignores it
 *    left the promise pending forever (still pending at 15 s on a 500 ms deadline) and itself alive.
 * 3. **The deadline did not reach the work.** Killing the local `ssh` leaves the remote script walking:
 *    measured over real sshd, the remote loop went on from 100 000 to 1 100 000 iterations after both
 *    SIGTERM and SIGKILL of the client, and eight listings that had already answered 504 left eight walks
 *    running on the host.
 * 4. The loop's work grew with the FOLDER, not with the number of folders shown: 60 000 entries cost
 *    334 ms of per-entry tests to answer "no subfolders here".
 *
 * These tests pin all four, plus the rule E44 wrote down: the limit on the host has to OUTLAST the call
 * that spends it.
 *
 * The fake hosts run in a CHILD process: Bun resolves a command against the PATH its own process started
 * with, so a `process.env.PATH` edit inside this test file would be ignored and the real `ssh` would run.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FOLDER_LIMIT,
  FOLDER_SCAN_LIMIT,
  FOLDER_SPAWN_MAX_BYTES,
  REMOTE_LIST_TIMEOUT_MS,
  REMOTE_WALK_SLACK_MS,
  SSH_CONNECT_TIMEOUT_SECONDS,
  remoteListCommand,
  remoteListScript,
  remoteWalkSeconds,
} from "../src/web/folders";

const FOLDERS = join(import.meta.dir, "..", "src", "web", "folders.ts");

interface Answer {
  ok: boolean;
  status: number;
  message: string;
  path?: string;
  entries?: string[];
  truncated?: boolean;
  /** Peak RSS of the child process that ran the listing: what the web process would have been holding. */
  peakMiB: number;
  elapsedMs: number;
}

let scratch: string;
let child = 0;

/** Write a fake `ssh`, then run one listing against it in a child process and report what came back. */
function againstHost(name: string, sshBody: string, opts: { input?: string; timeoutMs?: number } = {}): Answer {
  const dir = join(scratch, `${name}-${child++}`);
  Bun.spawnSync({ cmd: ["mkdir", "-p", dir] });
  writeFileSync(join(dir, "ssh"), `#!/usr/bin/env bash\n${sshBody}\n`, { mode: 0o755 });
  const runner = join(dir, "runner.ts");
  writeFileSync(runner, `import { listRemote } from ${JSON.stringify(FOLDERS)};
import { readFileSync } from "node:fs";
const hwm = () => Number(/VmHWM:\\s+(\\d+)/.exec(readFileSync("/proc/self/status", "utf8"))![1]) / 1024;
const t0 = Date.now();
try {
  const l = await listRemote({ host: "example.test", port: 22, user: "jaime" }, ${JSON.stringify(opts.input ?? "/srv")}, ${opts.timeoutMs ?? 12_000});
  console.log("E49ANSWER " + JSON.stringify({ ok: true, status: 0, message: "", path: l.path, entries: l.entries.map((e) => e.name), truncated: l.truncated, peakMiB: hwm(), elapsedMs: Date.now() - t0 }));
} catch (error) {
  console.log("E49ANSWER " + JSON.stringify({ ok: false, status: (error as { status?: number }).status ?? 0, message: String((error as Error).message), peakMiB: hwm(), elapsedMs: Date.now() - t0 }));
}
`);
  const run = Bun.spawnSync({
    cmd: ["bun", "run", runner],
    cwd: dir,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const line = run.stdout.toString().split("\n").find((l) => l.startsWith("E49ANSWER "));
  if (!line) throw new Error(`the runner said nothing (rc=${run.exitCode}): ${run.stderr.toString().slice(0, 400)}`);
  return JSON.parse(line.slice("E49ANSWER ".length)) as Answer;
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "folders-remote-"));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("the answer is bounded on the way back (the remote host is another server)", () => {
  test("200 MiB on stdout is refused by name instead of buffered", () => {
    const answer = againstHost("flood-out", "cat > /dev/null\ndd if=/dev/zero bs=65536 count=3200 2>/dev/null\nexit 0");
    expect(answer.status).toBe(502);
    expect(answer.message).toContain(String(FOLDER_SPAWN_MAX_BYTES));
    // The cap is about this process's memory: 200 MiB used to land here whole (628 MiB RSS measured).
    expect(answer.peakMiB).toBeLessThan(150);
  });

  test("200 MiB on stderr is refused too (the parent buffers it just the same)", () => {
    const answer = againstHost("flood-err", "cat > /dev/null\ndd if=/dev/zero bs=65536 count=3200 1>&2 2>/dev/null\nexit 0");
    expect(answer.status).toBe(502);
    expect(answer.message).toContain(String(FOLDER_SPAWN_MAX_BYTES));
    expect(answer.peakMiB).toBeLessThan(150);
  });

  test("a host that answers a real listing still gets through", () => {
    const answer = againstHost(
      "good",
      "cat > /dev/null\nprintf 'PATH\\t/srv\\nHOME\\t/srv\\n1\\tapp\\n0\\tlib\\n'\nexit 0",
      { input: "/srv" },
    );
    expect(answer.ok).toBe(true);
    expect(answer.path).toBe("/srv");
    expect(answer.entries).toEqual(["app", "lib"]);
  });
});

describe("the deadline lands", () => {
  test("a host that ignores SIGTERM cannot outlive the deadline", () => {
    // The shape of the E47 defect, still live here: TERM is swallowed and the walk goes on for ever.
    const pidFile = "/tmp/e49-stubborn.pid";
    Bun.spawnSync({ cmd: ["rm", "-f", pidFile] });
    const answer = againstHost(
      "stubborn",
      `cat > /dev/null\ntrap '' TERM INT\necho $$ > ${pidFile}\nprintf 'PATH\\t/x\\nHOME\\t/x\\n0\\ta\\n'\nwhile :; do :; done`,
      { input: "/x", timeoutMs: 400 },
    );
    expect(answer.status).toBe(504);
    expect(answer.elapsedMs).toBeLessThan(4_000);
    // Before: pending for ever (measured at 15 s on a 500 ms deadline) and the child left running.
    const pid = readFileSync(pidFile, "utf8").trim();
    expect(Bun.spawnSync({ cmd: ["kill", "-0", pid] }).exitCode).not.toBe(0);
  });

  test("the host that cut the walk itself is reported as the host cutting it, not as ssh failing", () => {
    const answer = againstHost("cut", "cat > /dev/null\nexit 124", { timeoutMs: 1_000 });
    expect(answer.status).toBe(504);
    expect(answer.message).toContain("stopped the walk itself");
  });

  test("an ssh that cannot connect is still a 502 with its own words", () => {
    const answer = againstHost(
      "refused",
      "cat > /dev/null\necho 'ssh: connect to host example.test port 22: Connection refused' >&2\nexit 255",
      { timeoutMs: 1_000 },
    );
    expect(answer.status).toBe(502);
    expect(answer.message).toContain("Connection refused");
  });

  test("a host that cannot run the walk at all says so, in its own words", () => {
    const answer = againstHost(
      "notimeout",
      "cat > /dev/null\necho '/bin/bash: line 1: timeout: command not found' >&2\nexit 127",
      { timeoutMs: 1_000 },
    );
    expect(answer.status).toBe(502);
    expect(answer.message).toContain("timeout: command not found");
  });
});

describe("the clock lives on the host that does the work", () => {
  test("the walk runs under `timeout` on the far side, with seconds that outlast our own deadline", () => {
    // Killing the local ssh does not kill the remote walk (measured over real sshd), so the walk carries
    // a clock of its own. And that clock must OUTLAST the call that spends it (the rule from E44): if the
    // host cut first, a slow but honest answer would die before this side could pass it through.
    const argv = remoteListCommand({ host: "example.test", port: 22, user: "jaime" }, REMOTE_LIST_TIMEOUT_MS);
    const at = argv.indexOf("timeout");
    expect(at).toBeGreaterThan(-1);
    expect(argv[at + 1]).toBe("-k");
    expect(argv[at + 2]).toBe("1");
    expect(Number(argv[at + 3])).toBe(Math.ceil((REMOTE_LIST_TIMEOUT_MS + REMOTE_WALK_SLACK_MS) / 1000));
    expect(remoteWalkSeconds(REMOTE_LIST_TIMEOUT_MS)).toBeGreaterThan(REMOTE_LIST_TIMEOUT_MS / 1000);
    expect(argv[argv.length - 2]).toBe("bash");
    // ssh still gets the whole channel and its own connect budget.
    expect(argv).toContain(`ConnectTimeout=${SSH_CONNECT_TIMEOUT_SECONDS}`);
    expect(argv).toContain("jaime@example.test");
  });

  test("the connect budget fits inside the whole budget", () => {
    // ssh gets 8 s of the 12 s to connect; the rest is the walk. A connect budget longer than the whole
    // budget would make the walk's budget unreachable and the two reasons indistinguishable.
    expect(SSH_CONNECT_TIMEOUT_SECONDS).toBeLessThan(REMOTE_LIST_TIMEOUT_MS / 1000);
    expect(REMOTE_WALK_SLACK_MS).toBeGreaterThan(0);
  });

  test("the program still travels on the one channel, through the launcher's stdin", () => {
    const stdinFile = join(scratch, "stdin-captured.sh");
    const answer = againstHost(
      "record",
      `cat > ${stdinFile}\nprintf 'PATH\\t/x\\nHOME\\t/x\\n0\\ta\\n'\nexit 0`,
      { input: "/srv/app" },
    );
    expect(answer.ok).toBe(true);
    expect(readFileSync(stdinFile, "utf8")).toBe(remoteListScript("/srv/app"));
  });
});

describe("the walk bounds its own work", () => {
  const runScript = (dir: string, scanLimit?: number): string => {
    let script = remoteListScript(dir);
    if (scanLimit !== undefined) script = script.replace(String(FOLDER_SCAN_LIMIT), String(scanLimit));
    return Bun.spawnSync({ cmd: ["bash", "-s"], stdin: Buffer.from(script), env: { ...process.env, HOME: dir } })
      .stdout.toString();
  };

  test("a small folder is unchanged: its names, and no MORE", () => {
    const dir = join(scratch, "small");
    Bun.spawnSync({ cmd: ["mkdir", "-p", join(dir, "alpha"), join(dir, "beta")] });
    const out = runScript(dir);
    expect(out).toContain(`PATH\t${dir}`);
    expect(out.split("\n").filter((l) => /^[01]\t/.test(l))).toEqual(["0\talpha", "0\tbeta"]);
    expect(out).not.toContain("MORE");
  });

  test("the loop stops looking at entries after its scan cap and says MORE", () => {
    // The answer's cap counts FOLDERS (`n`); this cap counts ENTRIES looked at (`i`), which is what grows
    // with the folder. Without it a folder with 60 000 files and two subfolders costs the host the same
    // as one with 60 000 subfolders. `aaa` sorts first, so it is inside the cap and still comes back.
    const dir = join(scratch, "wide");
    Bun.spawnSync({ cmd: ["mkdir", "-p", join(dir, "aaa")] });
    writeFileSync(join(dir, ".seed"), "x");
    for (let i = 0; i < 400; i++) linkSync(join(dir, ".seed"), join(dir, `f${String(i).padStart(4, "0")}`));
    const capped = runScript(dir, 50);
    expect(capped).toContain("MORE");
    expect(capped.split("\n").filter((l) => /^[01]\t/.test(l))).toEqual(["0\taaa"]);
    // Same folder, cap high enough to see everything: no MORE, and the same folder is still listed.
    const whole = runScript(dir, 10_000);
    expect(whole).not.toContain("MORE");
    expect(whole.split("\n").filter((l) => /^[01]\t/.test(l))).toEqual(["0\taaa"]);
  });

  test("the real script carries both caps", () => {
    const script = remoteListScript("/srv");
    expect(script).toContain(`-gt ${FOLDER_SCAN_LIMIT}`);
    expect(script).toContain(`-gt ${FOLDER_LIMIT}`);
  });
});
