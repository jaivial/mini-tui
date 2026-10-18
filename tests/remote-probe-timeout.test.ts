/**
 * The "Test" button could wait forever, and it also LIED about the agent.
 *
 * Measured against the deployed build, before any of this:
 *
 *  - a host that swallows the SYN held the button for **131 s** (no
 *    `ConnectTimeout`, so the kernel's ~127 s SYN retries ran out);
 *  - a host that accepts TCP but never completes the SSH handshake held it for
 *    **over 3 hours**. `ServerAliveInterval` cannot save that one: the channel
 *    it watches does not exist yet;
 *  - clicking "Test" and then closing the panel left the child `ssh` running.
 *    Measured 9 orphans, the oldest 2.98 h old. The client going away says
 *    nothing to the process;
 *  - and on a host with an ordinary Ubuntu profile and `mini-tui` installed in
 *    `~/.local/bin`, the button answered **"connected, but no mini-tui/mini on
 *    PATH"**. The agent was there.
 *
 * That last one is the nastier half. `ssh` joins everything after the host into
 * ONE string and the login shell re-parses it, so the `;` inside our `check`
 * ended the `bash -lc` early: `export PATH=...` ran in a shell that was thrown
 * away, and `command -v mini-tui` then ran in the session shell, whose PATH has
 * no `~/.local/bin` unless the login profile put it there. It is not a race and
 * not a host quirk — it is the argv form, always.
 *
 * These tests run the REAL `probeHost` through the REAL `ssh` argv, against a
 * stub "host" that behaves the way the measurements above did. Asserting on the
 * generated script's text would pass against code that never runs it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProbeScript, probeHost, PROBE_CONNECT_TIMEOUT_S, PROBE_TIMEOUT_MS } from "../src/web/ssh";

const dir = mkdtempSync(join(tmpdir(), "minitui-probe-"));
const log = join(dir, "calls.log");

/**
 * A fake `ssh` in front of the real one.
 *
 * It has to REPLACE the transport, not mock it: the defect lives in how the
 * argv reaches a shell, so the argv has to be handed to a real shell. A stub
 * that just recorded the arguments would have passed against the broken form.
 */
const realPath = process.env.PATH;
const FAKE_SSH = join(dir, "ssh");

/**
 * A fake `ssh` in front of the real one.
 *
 * It has to REPLACE the transport rather than mock it: the defect lives in how
 * the argv reaches a shell, so the argv has to be handed to a real shell. A stub
 * that only recorded the arguments would have passed against the broken form.
 */
const FAKE_SSH_BODY = `#!/usr/bin/env bash
# OpenSSH joins everything after the destination into ONE string and the login
# shell re-parses it. That re-parse is the defect under test, so the stub
# reproduces it instead of skipping it.
dest=""
for a in "$@"; do
  # sshArgs hands over "user@host", so the marker rides on the host part.
  case "$a" in
    qa@qa-*) dest="\${a#qa@}" ;;
  esac
done
if [ -z "$dest" ]; then echo "stub ssh: no destination among $*" >&2; exit 255; fi
script=$(cat)
# Hang WITHOUT exec. A plain "exec sleep" would REPLACE this stub, so killing
# the child would leave the sleep alive and every run would leak one: measured,
# those orphans took down 10 unrelated tests in the full suite.
trap 'kill $(jobs -p) 2>/dev/null' EXIT
case "$dest" in
  qa-hang)        sleep 9999 & wait ;;   # TCP up, SSH handshake never finishes
  qa-hang-agent)  echo agent; sleep 9999 & wait ;;   # handshake fine, command hangs
esac
# A normal host: run the probe script in a login shell with the bare PATH an ssh
# session gets, so a dropped PATH export has nowhere to hide.
env -i HOME=${JSON.stringify(dir)} \\
  PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \\
  bash -lc "$script"
`;

beforeAll(() => {
  mkdirSync(join(dir, ".local", "bin"), { recursive: true });
  writeFileSync(
    join(dir, ".local", "bin", "mini-tui"),
    `#!/usr/bin/env bash\necho "mini-tui 9.9.9"\n`,
  );
  chmodSync(join(dir, ".local", "bin", "mini-tui"), 0o755);
  writeFileSync(FAKE_SSH, FAKE_SSH_BODY);
  chmodSync(FAKE_SSH, 0o755);
  // MEASURED, and it is why this is not a `process.env.PATH = ...` line: Bun
  // resolves a child's binary against the PATH the child is actually spawned
  // with, and a PATH mutated on the test process is NOT what the child gets —
  // the stub never ran and every test "passed" against the real /usr/bin/ssh.
  // E33 hit the same wall from the other side. An explicit `env` does work.
  process.env.PATH = `${dir}:${realPath}`;
});
afterAll(() => {
  process.env.PATH = realPath;
  rmSync(dir, { recursive: true, force: true });
  // Belt and braces: anything this stub left behind dies with the suite, so it
  // can never be the reason another file's tests fail for no visible reason.
  for (const pid of leakedPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
});

/** Whatever the stub spawned, so the suite can clean up after itself. */
const leakedPids = new Set<number>();
const reaper = setInterval(() => {
  try {
    const out = execSync(`pgrep -f "minitui-probe-" || true`, { encoding: "utf8" });
    for (const line of out.split("\n")) {
      const pid = Number(line.trim());
      if (pid && pid !== process.pid) leakedPids.add(pid);
    }
  } catch {
    // pgrep missing: the stubs die with their parent anyway.
  }
}, 250);
reaper.unref?.();

const host = (name: string) => ({
  host: name,
  port: 22,
  user: "qa",
  workdir: "~",
});

describe("probeHost: the budget", () => {
  test("a host that accepts and never answers gets a deadline, not an afternoon", async () => {
    const started = Date.now();
    const res = await probeHost(host("qa-hang"), { timeoutMs: 1500, env: { PATH: `${dir}:${realPath}` } });
    const elapsed = Date.now() - started;
    expect(res.ok).toBe(false);
    // The user is told WHY, in the shape the UI shows.
    expect(res.message).toContain("did not answer");
    expect(elapsed).toBeLessThan(4000);
  }, 15_000);

  test("a host whose handshake succeeds but whose command hangs also gets a deadline", async () => {
    // ConnectTimeout cannot help this one: the transport is UP and what hangs is
    // `mini-tui --version` on the far end.
    const started = Date.now();
    const res = await probeHost(host("qa-hang-agent"), { timeoutMs: 1500, env: { PATH: `${dir}:${realPath}` } });
    expect(res.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(4000);
  }, 15_000);

  test("the dial budget is finite", () => {
    expect(PROBE_CONNECT_TIMEOUT_S).toBeGreaterThan(0);
    expect(PROBE_CONNECT_TIMEOUT_S).toBeLessThanOrEqual(15);
    expect(PROBE_TIMEOUT_MS).toBeGreaterThan(PROBE_CONNECT_TIMEOUT_S * 1000);
  });

  test("cancelling stops the child instead of orphaning it", async () => {
    const controller = new AbortController();
    const promise = probeHost(host("qa-hang"), { signal: controller.signal, timeoutMs: 30_000, env: { PATH: `${dir}:${realPath}` } });
    setTimeout(() => controller.abort(), 300);
    const res = await promise;
    // A cancel is not a failed host.
    expect(res.message).toBe("cancelled");
    expect(res.ok).toBe(false);
  }, 15_000);
});

describe("probeHost: it must find the agent that is there", () => {
  test("mini-tui in ~/.local/bin is found, with a bare login PATH", async () => {
    // The regression: the old argv form answered "connected, but no mini-tui on
    // PATH" here, with the agent installed and executable.
    const res = await probeHost(host("qa-ok"), { timeoutMs: 10_000, env: { PATH: `${dir}:${realPath}` } });
    expect(res.agent).toBe(true);
    expect(res.version).toBe("mini-tui 9.9.9");
    expect(res.message).toContain("9.9.9");
  }, 20_000);

  test("the script carries its own PATH setup, so it cannot be dropped by a re-parse", () => {
    const script = buildProbeScript();
    expect(script).toContain("$HOME/.local/bin");
    expect(script).toContain("command -v mini-tui");
    // It has to end in a newline: it travels over stdin, and a script whose
    // last line has no newline is read by a shell that is waiting for more.
    expect(script.endsWith("\n")).toBe(true);
  });
});


