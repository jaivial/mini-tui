/**
 * Subprocess lifecycle for `mini`. The harness runs untouched and unmodified: we only
 * pass CLI flags (`-y --exit-immediately -o <session traj>`) and capture its raw stdout
 * to `<session>/mini.log`.
 */

import { appendFileSync, closeSync, openSync, readFileSync, writeFileSync } from "node:fs";

import { MINI_BIN, createSessionDir, type SessionPaths } from "../config";

export interface TaskSpec {
  task: string;
  model?: string;
  specs?: string[];
  cwd?: string;
}

export interface MiniRun {
  session: SessionPaths;
  pid?: number;
  cmd: string[];
  /** Resolves with the exit code (null when killed by a signal). */
  exited: Promise<number | null>;
  kill(): void;
  /** Ask the running agent to switch model from its next step (control file). */
  switchModel(model: string): void;
  /** Send a follow-up prompt that continues the same conversation (control file). */
  sendUserMessage(text: string): void;
}

export function spawnMini(spec: TaskSpec): MiniRun {
  const session = createSessionDir(spec.task);
  const cmd = [MINI_BIN, "-y", "--exit-immediately", "-o", session.trajPath];
  if (spec.model) cmd.push("-m", spec.model);
  for (const configSpec of spec.specs ?? []) cmd.push("-c", configSpec);
  cmd.push("-t", spec.task);

  const logFd = openSync(session.logPath, "a");
  const proc = Bun.spawn({
    cmd,
    cwd: spec.cwd ?? process.cwd(),
    stdin: "ignore",
    stdout: logFd,
    stderr: logFd,
    env: { ...process.env, MSWEA_CONTROL_FILE: session.controlPath },
  });
  closeSync(logFd);

  writeFileSync(session.pidPath, `${proc.pid}\n`);
  process.once("exit", () => {
    try {
      proc.kill("SIGTERM");
    } catch {
      // already gone
    }
  });
  let exiting = false;
  const exited = proc.exited.then((code) => code as number | null);

  return {
    session,
    pid: proc.pid,
    cmd,
    exited,
    kill() {
      if (exiting) return;
      exiting = true;
      try {
        proc.kill("SIGTERM");
      } catch {
        // already gone
      }
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // already gone
        }
      }, 5000).unref?.();
    },
    switchModel(model: string) {
      // The agent reads MSWEA_CONTROL_FILE before each model call (last `MODEL` line wins).
      appendFileSync(session.controlPath, `MODEL ${model}\n`);
    },
    sendUserMessage(text: string) {
      // JSON-quoted so multi-line prompts survive the line-based protocol.
      appendFileSync(session.controlPath, `MESSAGE ${JSON.stringify(text)}\n`);
    },
  };
}

/** Tail of the raw `mini` output, for error banners. */
export function tailLog(logPath: string, lines = 12): string {
  try {
    const text = readFileSync(logPath, "utf8");
    return text.split("\n").slice(-lines).join("\n").trim();
  } catch {
    return "";
  }
}
