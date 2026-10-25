import { spawn } from "node:child_process";

/**
 * Open a URL in the user's browser, detached so the terminal UI never waits on it. Returns the
 * opener used, or "" when there is none (an SSH session with no display): the caller then says
 * "copy the link" instead of pretending it opened.
 */
export function openUrl(url: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (!/^https?:\/\//i.test(url)) return "";
  const candidates: Array<[string, string[]]> =
    platform === "darwin"
      ? [["open", [url]]]
      : platform === "win32"
        ? [["cmd", ["/c", "start", "", url]]]
        : [
            ...(env.BROWSER ? ([[env.BROWSER, [url]]] as Array<[string, string[]]>) : []),
            ["xdg-open", [url]],
            ["wslview", [url]],
            ["gio", ["open", url]],
          ];
  // No display on Linux: a GUI opener would fail (or open a text browser inside our terminal).
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY && !env.WSL_DISTRO_NAME && !env.BROWSER) return "";
  for (const [cmd, args] of candidates) {
    try {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true });
      child.on("error", () => undefined);
      child.unref();
      if (child.pid) return cmd;
    } catch {
      // try the next one
    }
  }
  return "";
}
