/**
 * v6-E: the consumer unit must be able to reach the user manager.
 *
 * transcribe.ts wraps every whisper run in `systemd-run --user` (a transient
 * scope with CPUQuota/MemoryMax) so a long transcription can never squeeze the
 * box's serving processes. That wrapper needs the USER manager's socket.
 *
 * `mini-channel-consumer` is a SYSTEM unit, and systemd does NOT export
 * XDG_RUNTIME_DIR into system units. Without it `systemd-run --user` fails with
 * "Failed to connect to bus: No such file or directory", and because that is
 * an environmental failure the transcriber deliberately reports it as
 * `transient` — which means EVERY voice note silently degrades to "temporarily
 * unavailable" instead of being transcribed, with nothing in the logs but a
 * transient marker. This test exists so that regression is caught here instead
 * of as a mystery months later.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dropin = join(import.meta.dir, "..", "deploy", "mini-channel-consumer-v6e.conf");

describe("deploy/mini-channel-consumer-v6e.conf", () => {
  test("exists and exports XDG_RUNTIME_DIR for the user manager", () => {
    expect(existsSync(dropin)).toBe(true);
    const conf = readFileSync(dropin, "utf8");
    const match = conf.match(/^Environment=XDG_RUNTIME_DIR=(\S+)$/m);
    expect(match).not.toBeNull();
    // The runtime dir must actually exist on a host with lingering enabled —
    // otherwise the value is a guess and the wrapper still cannot connect.
    expect(existsSync(match![1]!)).toBe(true);
  });

  test("does not touch credentials or the exec path", () => {
    const conf = readFileSync(dropin, "utf8");
    // A drop-in that restarts the unit or rewrites ExecStart is a redeploy
    // hazard; the only thing v6-E needs from systemd is the runtime dir.
    expect(conf).not.toMatch(/^ExecStart=/m);
    expect(conf).not.toMatch(/^Restart=/m);
    expect(conf.toLowerCase()).not.toContain("apikey");
    expect(conf.toLowerCase()).not.toContain("token=");
  });
});