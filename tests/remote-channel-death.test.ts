/**
 * Stopping a REMOTE turn must stop the agent on the HOST, not just the ssh client.
 *
 * `RemoteRun.stop()` signals the local `ssh` process, and the channel's remote end is a shell
 * forked by sshd for that connection. Nothing travels back up the channel when the client dies,
 * so the agent kept running: measured against the deployed build, over a real ssh connection to
 * a real host, it was still alive 25 s after `stop()` with no signal ever delivered to it. The
 * turn kept spending the host's tokens on a process the UI had already written off.
 *
 * These tests run the script `buildRemoteScript` actually produces, against a stub agent that
 * records every signal it receives BY NAME. Running the generated script is the point: a test
 * that only grepped it for the word "watchdog" would happily pass against a script that never
 * fires one.
 *
 * The channel is modelled the way it really is: the script runs as a child of a throwaway
 * "channel" process, and killing THAT process is what a dropped ssh connection looks like from
 * the remote end. A test that faked the channel by pointing `CHANNEL_PPID` at a pid that never
 * existed would signal the agent before it had installed its traps — a race the real topology
 * never has, and one that hides whether the watchdog works at all.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRemoteScript } from "../src/web/ssh";

const dir = mkdtempSync(join(tmpdir(), "minitui-channel-death-"));
const stub = join(dir, "agent.sh");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const read = (log: string): string[] => {
  try {
    return readFileSync(log, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};
const alive = (pid: string): boolean => {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * The stub agent. One signal trap per signal, because `$1` inside a trap is the script's
 * positional parameters and not the signal that fired — a single `trap 'on_signal' TERM` would
 * log "TERM" for a HUP too, and the test would pass without the right signal ever arriving.
 * `QA_STUB_STUBBORN=1` makes it ignore SIGTERM, which is how the escalation is exercised: a
 * watchdog that only sends TERM leaves that agent running forever.
 */
writeFileSync(
  stub,
  `#!/usr/bin/env bash
LOG="\${QA_CHANNEL_LOG:-/dev/null}"
record() { printf '%s %s\\n' "$1" "$$" >> "$LOG"; }
# Announce itself the moment it starts, so a test can wait for "the agent is running" instead
# of waiting for a signal that a healthy turn never sends.
record "START"
on_signal() {
  record "SIGNAL:$1"
  if [ "\${QA_CHANNEL_STUBBORN:-0}" = "1" ] && [ "$1" != "KILL" ]; then
    record "IGNORED:$1"
    return 0
  fi
  record "EXIT:$1"
  exit 143
}
trap 'on_signal HUP' HUP
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM
trap 'on_signal QUIT' QUIT
trap '' PIPE
echo '{"type":"init","session_id":"t","model":"stub"}'
# A POLLING LOOP, not a single \`sleep N & wait\`: a trap that returns simply resumes after the
# wait it interrupted, so an agent modelled as one long wait cannot "ignore" a signal at all --
# it would run to completion and the escalation test would pass for the wrong reason. Looping
# is what makes "still running after SIGTERM" mean what it says.
END=$(( $(date +%s) + \${QA_CHANNEL_HOLD:-30} ))
while [ "$(date +%s)" -lt "$END" ]; do sleep 0.25; done
echo '{"type":"result","subtype":"success","api_calls":1,"cost_usd":0.001,"result":"done"}'
record "EXIT:natural"
`,
);
chmodSync(stub, 0o755);

let seq = 0;
/** The generated script, with the stub standing in for `mini-tui`. */
function scriptUsingStub(): string {
  const path = join(dir, `run-${seq++}.sh`);
  writeFileSync(
    path,
    buildRemoteScript("hello", "/tmp").replace(/^(exec )?mini-tui .*$/m, `bash ${stub} &`),
  );
  chmodSync(path, 0o755);
  return path;
}

/**
 * Start the script behind a throwaway "channel" process, the way sshd forks a shell per
 * connection. `channel.kill()` is the equivalent of the client going away.
 */
function startBehindChannel(opts: { stubborn?: boolean; hold?: number } = {}) {
  const log = join(dir, `agent-${seq++}.log`);
  writeFileSync(log, "");
  const script = scriptUsingStub();
  // The wrapper outlives the turn on purpose (it IS the channel), so the script's own exit
  // status comes through a fifo rather than through the wrapper's exit code.
  const fifo = join(dir, `status-${seq++}`);
  // bun's node:fs has no mkfifo, and a plain file would not block until the writer shows up.
  spawnSync("mkfifo", [fifo]);
  const status = (async () => (await readFile(fifo, "utf8")).trim())();
  // The wrapper deliberately does NOT `exec` the script. With `exec` the script *replaces* the
  // wrapper, so killing "the channel" kills the script itself and the watchdog never gets a
  // chance to observe anything — measured, and it makes this test pass or fail for a reason
  // that has nothing to do with the fix. Here the wrapper stays alive as the script's parent,
  // so killing it leaves the script running and reparented to init, which is exactly what a
  // dropped ssh connection looks like from the remote end.
  const channel = Bun.spawn({
    cmd: ["bash", "-c", `bash ${script}; echo $? > "${fifo}"`],
    env: {
      ...process.env,
      QA_CHANNEL_LOG: log,
      QA_CHANNEL_HOLD: String(opts.hold ?? 30),
      QA_CHANNEL_STUBBORN: opts.stubborn ? "1" : "0",
    },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  return { channel, log, script, status };
}

async function until(pred: () => boolean, what: string, budget = 15_000) {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Wait until the agent has announced itself, and return its pid. */
async function agentPid(log: string): Promise<string> {
  await until(() => read(log).length > 0, "the agent to start");
  return read(log)[0]!.split(" ")[1]!;
}

const strOf = async (stream: ReadableStream<Uint8Array> | null): Promise<string> => {
  let s = "";
  if (stream) for await (const c of stream) s += new TextDecoder().decode(c);
  return s;
};

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("a remote turn is stopped on the host, not just on this machine", () => {
  test("killing the channel stops the agent", async () => {
    const { channel, log } = startBehindChannel();
    const pid = await agentPid(log);
    expect(alive(pid)).toBe(true);

    channel.kill("SIGKILL"); // the client going away: no goodbye, no signal
    await until(() => read(log).some((l) => l.startsWith("EXIT:")), "the agent to be stopped");
    const seen = read(log);
    expect(seen.some((l) => l.startsWith("SIGNAL:TERM"))).toBe(true);
    expect(alive(pid)).toBe(false);
  }, 30_000);

  test("escalates to SIGKILL when the agent ignores SIGTERM", async () => {
    // The escalation cannot be observed from inside the agent: SIGKILL cannot be trapped, so a
    // handler never runs and nothing is logged. What matters is the OUTCOME — the process that
    // refused to stop on SIGTERM is gone. Asserting on a log line here would be asserting on
    // something that is impossible by construction.
    const { channel, log } = startBehindChannel({ stubborn: true });
    const pid = await agentPid(log);

    channel.kill("SIGKILL");
    await until(
      () => read(log).some((l) => l.startsWith("IGNORED:TERM")),
      "the agent to refuse SIGTERM",
    );
    // Still alive at this point, which is what makes the escalation necessary.
    expect(alive(pid)).toBe(true);
    await until(() => !alive(pid), "the stubborn agent to be killed outright", 20_000);
    expect(alive(pid)).toBe(false);
  }, 45_000);

  test("a healthy turn is left alone and its exit status survives", async () => {
    // The case a careless watchdog breaks: stopping a turn that was about to finish would
    // truncate a good answer. The channel stays up, so nothing may be signalled at all.
    const { channel, log, status } = startBehindChannel({ hold: 1 });
    // Wait for the SCRIPT, not the channel: the wrapper is the channel and outlives the turn
    // on purpose, so awaiting it would hang until its own sleep expired.
    await status;
    const seen = read(log);
    expect(seen.filter((l) => l.startsWith("SIGNAL:"))).toEqual([]);
    expect(seen.some((l) => l.startsWith("EXIT:natural"))).toBe(true);
    expect(seen.some((l) => l.startsWith("START"))).toBe(true);
    const out = await strOf(channel.stdout as ReadableStream<Uint8Array>);
    expect(out).toContain('"type":"result"');
    expect(await status).toBe("0");
  }, 30_000);

  test("the agent runs in its own process group", async () => {
    // `set -m` is what gives the agent its own process group, which is what lets one signal
    // reach the agent AND its children instead of only the process the server holds a handle
    // on. Measured here rather than assumed: without it, the agent shares the script's group
    // and `kill -TERM -$AGENT` would take the watchdog down with it.
    const probe = join(dir, "pgid-probe.sh");
    writeFileSync(
      probe,
      `#!/usr/bin/env bash
echo "PGID=$(ps -o pgid= -p $$ | tr -d ' ')"
echo "SPID=$$"
`,
    );
    chmodSync(probe, 0o755);
    const log = join(dir, `pgid-${seq++}.log`);
    writeFileSync(log, "");
    const script = join(dir, `pgid-run-${seq++}.sh`);
    writeFileSync(
      script,
      buildRemoteScript("hello", "/tmp").replace(/^(exec )?mini-tui .*$/m, `bash ${probe} &`),
    );
    chmodSync(script, 0o755);
    const proc = Bun.spawn({ cmd: ["bash", script], stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const out = await strOf(proc.stdout as ReadableStream<Uint8Array>);
    expect(Number(out.match(/SPID=(\d+)/)?.[1])).toBe(Number(out.match(/PGID=(\d+)/)?.[1]));
  }, 20_000);

  test("job-control notices do not leak into the transcript", async () => {
    // The server forwards this script's stderr into the transcript as notices, so a stray
    // "[1]+ Done" would be a user-visible artifact of the fix — the agent being supervised
    // would be visible in the conversation.
    const { channel, status } = startBehindChannel({ hold: 1 });
    await status;
    expect(await strOf(channel.stderr as ReadableStream<Uint8Array>)).not.toMatch(/\[\d+\]\+/);
  }, 30_000);
});
