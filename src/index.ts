import { createCliRenderer } from "@opentui/core";
import { createRoot, createElement } from "@opentui/react";

import { App } from "./ui/App";
import { waitForQuietInput } from "./helpers";
import { DEFAULT_MODEL } from "./config";
import { startProfiling } from "./profile";
import type { TaskSpec } from "./mini/spawn";

interface CliArgs {
  command: "run" | "view";
  task?: string;
  model?: string;
  specs?: string[];
  viewPath?: string;
  follow?: boolean;
  showSystem?: boolean;
}

const USAGE = `mini-tui — a pretty terminal UI for mini-swe-agent (the harness runs untouched).

Usage:
  mini-tui                                        start with the prompt (same as \`run\`)
  bun src/index.ts run ["task"] [-m <model>] [-c <spec>]... [--show-system]
  bun src/index.ts view <traj.json> [--follow] [--show-system]

Commands:
  run     Launch a mini run (yolo) and watch tools/outputs stream in.
          Without a positional task, the prompt bar is ready for your task
          (and for follow-ups: Enter send, Alt+Enter/Ctrl+J newline).
  view    Render an existing trajectory (e.g. ~/.config/mini-swe-agent/last_mini_run.traj.json).

Prompt commands:
  /model              open the model picker (or /model <id>)
  /settings           output display: collapsed / trimmed (2 lines) / expanded

Options:
  -m, --model <model>   Model for run (empty = mini's default)
  -c, --config <spec>   Extra mini config spec (repeatable)
  --follow              (view) keep watching the file for updates
  --show-system         Include the system prompt in the transcript
  -h, --help            Show this help
`;

function parseArgs(argv: string[]): CliArgs | null {
  if (argv.length === 0) return { command: "run" }; // bare `mini-tui` opens the prompt
  const [command, ...rest] = argv;
  if (command !== "run" && command !== "view") return null;
  const args: CliArgs = { command };
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "-m" || arg === "--model") args.model = rest[++i];
    else if (arg === "-c" || arg === "--config") args.specs = [...(args.specs ?? []), rest[++i] ?? ""];
    else if (arg === "--follow") args.follow = true;
    else if (arg === "--show-system") args.showSystem = true;
    else if (arg) positional.push(arg);
  }
  if (command === "view") {
    args.viewPath = positional[0];
    if (!args.viewPath) return null;
  } else if (positional.length) {
    args.task = positional.join(" ");
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args) {
  console.log(USAGE);
  process.exit(1);
}

const runSpec: TaskSpec | undefined =
  args.command === "run" && args.task
    ? { task: args.task, model: args.model || DEFAULT_MODEL || undefined, specs: args.specs, cwd: process.cwd() }
    : undefined;

// ctrl+c belongs to the App: once clears the prompt, twice closes.
// Smooth open: the renderer starts on the *main* screen (the shell stays visible) and
// renders nothing while the terminal's capability replies settle — then the alternate
// screen and the first (and only) content frame go out together, so the UI replaces the
// shell in a single visual step: no blank gap, no full-screen re-render.
let lastInputAt = 0;
const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  // the app's background from the very first cleared frame — the swap to the alternate
  // screen shows it instead of the terminal default, so there is no color blink either
  backgroundColor: "#09090B",
  screenMode: "main-screen",
  prependInputHandlers: [
    () => {
      lastInputAt = Date.now();
      return false;
    },
  ],
});
renderer.stop();
startProfiling();
const quit = () => {
  // leave the alternate screen by hand — the renderer never switched modes itself
  // (the swap is ours, for the smooth open), so it would not restore the shell view.
  process.stdout.write("\u001b[?2026h\u001b[?1049l\u001b[?2026l");
  renderer.destroy();
  process.exit(0);
};

await waitForQuietInput(() => Date.now() - lastInputAt);

createRoot(renderer).render(
  createElement(App, {
    cwd: process.cwd(),
    showSystem: args.showSystem,
    viewPath: args.command === "view" ? args.viewPath : undefined,
    follow: args.follow,
    runSpec,
    onQuit: quit,
  }),
);

// Swap to the alternate screen only once the content is mounted. The swap and an
// app-background fill go out in ONE sync batch, so the terminal shows the same dark
// canvas from the very first instant — shell → (dark canvas) → UI: no blank or
// default-color blink anywhere. Frames render on it by absolute position, so the
// renderer needs no mode switch at all (quit restores the shell by hand).
process.stdout.write("\u001b[?2026h\u001b[?1049h\u001b[38;2;255;255;255m\u001b[48;2;9;9;11m\u001b[2J\u001b[H\u001b[?2026l");
renderer.start();
renderer.requestRender();

process.on("SIGTERM", quit);
