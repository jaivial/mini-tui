import { spawnSync, spawn } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/** OSC 52 payload (base64) wrapped for the current terminal — plain, or tmux passthrough. */
export function buildOsc52(text: string, inTmux: boolean): string {
  const payload = Buffer.from(text, "utf8").toString("base64");
  const osc = ESC + "]52;c;" + payload + BEL;
  if (!inTmux) return osc;
  // tmux DCS passthrough: ESC Ptmux; <seq with ESCs doubled> ESC \
  return ESC + "Ptmux;" + ESC + osc.replace(new RegExp(ESC, "g"), ESC + ESC) + ESC + String.fromCharCode(92);
}

/**
 * Copy text to the system clipboard, even inside tmux:
 * 1. OSC 52 (works over SSH; wrapped in tmux's passthrough sequence when needed),
 * 2. the tmux paste buffer (`prefix+]`), and
 * 3. any native clipboard tool that happens to be available.
 *
 * Returns the methods that succeeded.
 */
export function copyText(text: string): string[] {
  const used: string[] = [];
  const inTmux = Boolean(process.env.TMUX);

  // 1. OSC 52 -> the terminal's own clipboard integration (large payloads skipped).
  if (text.length <= 100_000) {
    const sequence = buildOsc52(text, inTmux);
    try {
      const fd = openSync("/dev/tty", "w");
      writeSync(fd, sequence);
      closeSync(fd);
      used.push("osc52");
    } catch {
      try {
        process.stdout.write(sequence);
        used.push("osc52");
      } catch {
        // no tty available
      }
    }
  }

  // 2. tmux paste buffer (prefix+] pastes it; tmux also syncs it to the system clipboard)
  if (inTmux) {
    try {
      const result = spawnSync("tmux", ["load-buffer", "-"], { input: text });
      if (result.status === 0) used.push("tmux");
    } catch {
      // tmux missing despite $TMUX
    }
  }

  // 3. native clipboard tools
  for (const [cmd, args] of [
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
    ["xsel", ["--clipboard", "--input"]],
    ["pbcopy", []],
  ] as Array<[string, string[]]>) {
    try {
      const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
      child.on("error", () => undefined);
      child.stdin?.end(text);
      used.push(cmd);
      break;
    } catch {
      // try the next tool
    }
  }

  return used;
}

/**
 * Read text back from the system clipboard (the inverse of `copyText`): the first
 * clipboard tool that answers wins, then the tmux paste buffer. Returns "" when
 * nothing can be read (e.g. over SSH without a local tool).
 */
export function pasteText(): string {
  for (const [cmd, args] of [
    ["wl-paste", ["-n"]],
    ["xclip", ["-selection", "clipboard", "-o"]],
    ["xsel", ["--clipboard", "--output"]],
    ["pbpaste", []],
  ] as Array<[string, string[]]>) {
    try {
      const result = spawnSync(cmd, args, { encoding: "utf8", timeout: 500 });
      if (result.status === 0 && result.stdout) return result.stdout;
    } catch {
      // try the next tool
    }
  }
  if (process.env.TMUX) {
    try {
      const result = spawnSync("tmux", ["show-buffer"], { encoding: "utf8", timeout: 500 });
      if (result.status === 0 && result.stdout) return result.stdout;
    } catch {
      // tmux missing despite $TMUX
    }
  }
  return "";
}

/** Pasted text as a single token (API keys, model ids): no whitespace, no control chars. */
export function pastedToken(text: string): string {
  return text.replace(/\s+/g, "");
}

/** Pasted text as a single search line (titles can contain spaces). */
export function pastedLine(text: string): string {
  return text.replace(/\r/g, "").split("\n")[0] ?? "";
}
