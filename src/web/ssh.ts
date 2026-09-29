/**
 * SSH transport: run a mini-tui headless session on a remote box while the
 * web UI stays on this machine.
 *
 * The remote command is a single `bash -s` invocation over stdin, so no file
 * is copied and nothing is installed on the server beyond the agent itself.
 * The prompt is handed to the remote shell on stdin and exported there, which
 * keeps it out of the remote process table and out of shell-quoting hell.
 *
 * Progress comes back on stdout as the agent's own `-o stream-json` lines, so
 * one channel carries the whole live feed: no polling, no second connection.
 */

import { homedir } from "node:os";


export interface SshTarget {
  host: string;
  port: number;
  user: string;
  /** Identity file, `~` expanded. */
  identity?: string;
  workdir: string;
  model?: string;
}

/** `-i`/key options, batch mode so a missing key fails fast instead of hanging. */
export function sshArgs(target: SshTarget): string[] {
  const args = [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-p", String(target.port || 22),
  ];
  if (target.identity) args.push("-i", target.identity.replace(/^~(?=\/)/, homedir()));
  args.push(`${target.user}@${target.host}`);
  return args;
}

/**
 * The remote script.
 *
 * `mini-tui -p` runs one turn and exits, so there is no journal to tail: the
 * agent's own `-o stream-json` output *is* the live feed. The prompt travels
 * as an environment variable that is exported by this script (a non-interactive
 * `ssh host bash -s` does not forward the local environment), which also keeps
 * it out of the remote process table and out of shell-quoting hell.
 */
function remoteScript(workdir: string, model?: string): string {
  return `#!/usr/bin/env bash
set -uo pipefail
# __MINITUI_PROMPT_ARG__ is replaced with a single-quoted literal before
# this is sent. The prompt is data, so it is quoted, never interpolated raw.
MINITUI_PROMPT=$(printf '%s' __MINITUI_PROMPT_ARG__)
export MINITUI_PROMPT
# A non-interactive ssh gets a bare PATH: pick up the usual user bin dirs so a
# locally installed mini-tui is found the way it would be in a login shell.
export PATH="$HOME/.local/bin:$HOME/bin:$PATH"
cd ${shellQuote(workdir || '~')} 2>/dev/null || cd "$HOME"
exec mini-tui -p "$MINITUI_PROMPT" -o stream-json -v --no-session ${model ? `-m ${shellQuote(model)}` : ""}
`;
}

/** Single-quote a value for the remote shell. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Fill the prompt into the script.
 *
 * `ssh host bash -s` reads stdin as the script itself, so the prompt cannot be
 * piped behind it (it would be executed as commands). Instead it is substituted
 * into the script as a single-quoted literal: no file is copied, no temp file
 * is left behind, and a prompt full of quotes or newlines stays one argument.
 */
export function buildRemoteScript(prompt: string, workdir: string, model?: string): string {
  // global: the sentinel also appears in the script's comment line
  return remoteScript(workdir, model).replaceAll("__MINITUI_PROMPT_ARG__", () => shellQuote(prompt));
}

export interface RemoteRun {
  /** Kill the remote process (SIGINT, then SIGKILL). */
  stop(): void;
  readonly exited: Promise<number>;
  /** Called with every raw stdout chunk (the stream-json lines). */
  onData(handler: (chunk: string) => void): void;
}

/** Start a headless run on `target`, with the prompt safely quoted into the script. */
export function startRemoteRun(
  target: SshTarget,
  prompt: string,
  onStderr?: (text: string) => void,
): RemoteRun {
  const script = buildRemoteScript(prompt, target.workdir, target.model);
  const env: Record<string, string> = {};
  if (target.model) env.MINITUI_MODEL = target.model;

  const proc = Bun.spawn({
    cmd: ["ssh", "-T", ...sshArgs(target), "bash", "-s"],
    env: { ...process.env, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  // stdin carries the script, then EOF so the remote turn starts.
  void (async () => {
    try {
      proc.stdin.write(script);
      await proc.stdin.end();
    } catch {
      // the process already exited
    }
  })();

  if (proc.stderr) {
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
        const text = decoder.decode(chunk, { stream: true });
        if (text) onStderr?.(text);
      }
    })();
  }

  return {
    stop() {
      try {
        proc.kill("SIGINT");
      } catch {
        // already gone
      }
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // already gone
        }
      }, 4000).unref?.();
    },
    exited: proc.exited as Promise<number>,
    onData(handler) {
      void (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
          const text = decoder.decode(chunk, { stream: true });
          if (text) handler(text);
        }
      })();
    },
  };
}

/**
 * Make the probe's raw stdout safe to send to a browser.
 *
 * A `mini-tui` wrapper on the server can print its whole environment (secrets
 * included) when asked for a version, so the raw output is never echoed: only
 * a line that actually looks like a version is kept, and a `declare`/`export`
 * dump is treated as "not a version at all".
 */
export function sanitizeProbeOutput(out: string): { agent: boolean; version?: string } {
  const line = (out.trim().split("\n")[0] ?? "").trim();
  if (line === "" || line === "none" || /^(?:declare|export)\b/.test(line)) {
    return { agent: false };
  }
  const looksLikeVersion = /^[\w.+ -]{1,40}v?\d[\w.+-]*$/.test(line);
  return { agent: true, version: looksLikeVersion ? line : undefined };
}

/** Quick reachability + agent check for the "Test" button in the hosts panel. */
export async function probeHost(
  target: SshTarget,
): Promise<{ ok: boolean; message: string; agent: boolean; version?: string }> {
  // One line, no shell side effects: report only the agent, never the
  // environment (a `declare` fallback would dump every secret to the browser).
  const check =
    'export PATH="$HOME/.local/bin:$HOME/bin:$PATH"; ' +
    'if command -v mini-tui >/dev/null 2>&1; then mini-tui --version 2>/dev/null; ' +
    'elif command -v mini >/dev/null 2>&1; then echo "mini (no mini-tui)"; ' +
    'else echo none; fi';

  const proc = Bun.spawn({
    cmd: [
      "ssh",
      "-T",
      ...sshArgs(target),
      "bash",
      "-lc",
      check,
    ],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    return {
      ok: false,
      message:
        err
          .trim()
          .split("\n")
          .filter((line) => line.trim() && !/^(?:declare|export)\s/.test(line.trim()))
          .pop()
          ?.slice(0, 200) || `ssh exited with code ${code}`,
      agent: false,
    };
  }
  const { agent, version } = sanitizeProbeOutput(out);
  return {
    ok: true,
    agent,
    version,
    message: version ? `connected · ${version}` : agent ? "connected · agent found" : "connected, but no mini-tui/mini on PATH",
  };
}
