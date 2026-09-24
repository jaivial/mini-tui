import { createCliRenderer } from "@opentui/core";
import { createRoot, createElement } from "@opentui/react";

import { App } from "./ui/App";
import { DEFAULT_MODEL } from "./config";
import { startProfiling } from "./profile";
import type { TaskSpec } from "./mini/spawn";
import { syncSkills } from "./skills";

interface CliArgs {
  command: "run" | "view";
  task?: string;
  model?: string;
  specs?: string[];
  viewPath?: string;
  follow?: boolean;
  showSystem?: boolean;
}

const USAGE = `mini-tui — a pretty terminal UI for mini-swe-agent (integrated agent runner).

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
  /compact            summarize the conversation now (frees context)
  $skill              reference skills anywhere in a prompt ($ opens the list)

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

// Skills new in ~/.claude/skills join mini-tui's own folder (fast: a directory scan).
let importedSkills: string[] = [];
try {
  importedSkills = syncSkills().added;
} catch {
  importedSkills = []; // a broken skills folder must never block startup
}

// ctrl+c belongs to the App: once clears the prompt, twice closes.
const renderer = await createCliRenderer({ exitOnCtrlC: false });

// Smooth open: the renderer has just entered the alternate screen (its buffer starts
// empty — the terminal's blank). Fill it with the app background in ONE sync batch right
// now, so the UI develops onto the same dark canvas instead of flashing a blank screen;
// the first content frame follows within the same beat (mounted immediately below).
process.stdout.write("\u001b[?2026h\u001b[38;2;255;255;255m\u001b[48;2;9;9;11m\u001b[2J\u001b[H\u001b[?2026l");
startProfiling();
const quit = () => {
  renderer.destroy();
  process.exit(0);
};

createRoot(renderer).render(
  createElement(App, {
    cwd: process.cwd(),
    showSystem: args.showSystem,
    viewPath: args.command === "view" ? args.viewPath : undefined,
    follow: args.follow,
    runSpec,
    importedSkills,
    onQuit: quit,
  }),
);

process.on("SIGTERM", quit);
