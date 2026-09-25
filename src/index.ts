import { CONSOLE_TITLE, installConsoleClose } from "./consoleOverlay";
import { DEFAULT_MODEL } from "./config";
import { loadLastModel } from "./lastModel";
import type { TaskSpec } from "./mini/spawn";
import { syncSkills } from "./skills";
import { parseArgs, UsageError, withDefaultConfig, type CliArgs, type TuiArgs } from "./cli/args";
import pkg from "../package.json" with { type: "json" };

const USAGE = `mini-tui ${pkg.version} — a pretty terminal UI for mini-swe-agent (integrated agent runner).

Usage:
  mini-tui                                  start the TUI with the prompt ready
  mini-tui run ["task"] [-m <model>] [-c <spec>]... [--show-system]
  mini-tui view <traj.json> [--follow] [--show-system]
  mini-tui -p "<prompt>" [options]          headless: run, print the answer, exit
  mini-tui sessions | models | model | skills | settings   (scripting, see below)

Headless (-p, --print) — no TUI, for scripts, CI and other agents:
  -m, --model <model>        model for this run (default: $MINITUI_MODEL, the saved
                             session's model, else the model last picked with /model)
  -o, --output-format <fmt>  text (default: only the final answer on stdout)
                             json (one result object) | stream-json (JSON lines, live)
      --json                 same as --output-format json
  -v, --verbose              stream every step: thinking, commands and outputs
                             (text: on stderr; json: adds "events"; stream-json: full)
  -q, --quiet                only the answer: no error tail on stderr
  -C, --continue             continue the latest session of this folder
  -r, --resume <id>          continue a saved session (id or unique prefix)
      --compact              compact a --continue/--resume session instead of a prompt
      --no-session           do not save this run to the /resume history
      --cwd <dir>            working directory of the run (default: here)
      --max-steps <n>        stop after n model calls        (agent.step_limit)
      --cost-limit <usd>     stop past this cost, 0 = none    (agent.cost_limit)
      --timeout <seconds>    stop after this wall time        (agent.wall_time_limit_seconds)
  -c, --config <spec>        extra mini config spec (repeatable; key=value merges into
                             the default config)
  The prompt is the positional text (or -t "<task>"); piped stdin is appended to it
  (or is the prompt). $skills expand as in the TUI. Ctrl+C interrupts the run.
  Exit codes: 0 submitted, 1 the run failed/hit a limit, 2 usage error, 130 interrupted.

Scripting commands (add --json for machine-readable output):
  sessions [--all] [-n N] [-s text]   list saved sessions (this folder, or all)
  sessions show <id>                  print a session's transcript
  sessions rm <id>                    delete a saved session
  models                              list models (/model catalog + /connect providers)
  model [<id>]                        print / set the default model of new sessions
  skills                              list $skills
  settings [output-mode|theme <v>]    print / change /settings

Prompt commands (TUI):
  /model              open the model picker (or /model <id>)
  /settings           output display: collapsed / trimmed (2 lines) / expanded
  /compact            summarize the conversation now (frees context)
  /resume  /new  /connect  /quit
  $skill              reference skills anywhere in a prompt ($ opens the list)

Options (TUI):
  -m, --model <model>   Model for run (default: $MINITUI_MODEL, else the model last picked
                        with /model in any session, else mini's default)
  -c, --config <spec>   Extra mini config spec (repeatable)
  --follow              (view) keep watching the file for updates
  --show-system         Include the system prompt in the transcript
  -h, --help            Show this help        -V, --version   Show the version
`;

let parsed: CliArgs;
try {
  parsed = parseArgs(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof UsageError)) throw error;
  process.stderr.write(`error: ${error.message}\n\nRun \`mini-tui --help\` for usage.\n`);
  process.exit(2);
}

// Everything but the TUI runs without OpenTUI/React (fast start, no terminal takeover).
if (parsed.command === "help") {
  process.stdout.write(USAGE);
  process.exit(0);
}
if (parsed.command === "version") {
  process.stdout.write(`mini-tui ${pkg.version}\n`);
  process.exit(0);
}
if (parsed.command === "print") {
  try {
    syncSkills(); // new ~/.claude skills are usable as $skills right away, like in the TUI
  } catch {
    // a broken skills folder must never block a run
  }
  const { runHeadless } = await import("./cli/headless");
  process.exit(await runHeadless(parsed));
}
if (parsed.command !== "run" && parsed.command !== "view") {
  const cmd = parsed;
  const commands = await import("./cli/commands");
  const out = { stdout: (text: string) => process.stdout.write(text), stderr: (text: string) => process.stderr.write(text) };
  let code = 0;
  switch (cmd.command) {
    case "sessions":
      code = commands.sessionsCommand(cmd, out);
      break;
    case "models":
      code = commands.modelsCommand(cmd, out);
      break;
    case "model":
      code = commands.modelCommand(cmd, out);
      break;
    case "skills":
      code = commands.skillsCommand(cmd, out);
      break;
    case "settings":
      code = commands.settingsCommand(cmd, out);
      break;
  }
  process.exit(code);
}
const args: TuiArgs = parsed;

const { createCliRenderer } = await import("@opentui/core");
const { createRoot, createElement } = await import("@opentui/react");
const { App } = await import("./ui/App");
const { startProfiling } = await import("./profile");

// Default model of this launch: -m, else $MINITUI_MODEL, else the model last picked with
// /model in any session. Read once here, so TUIs already open keep their own model.
const initialModel = args.model || DEFAULT_MODEL || (args.command === "run" ? loadLastModel() : "") || undefined;

const runSpec: TaskSpec | undefined =
  args.command === "run" && args.task
    ? { task: args.task, model: initialModel, specs: args.specs ? withDefaultConfig(args.specs) : undefined, cwd: process.cwd() }
    : undefined;

// Skills new in ~/.claude/skills join mini-tui's own folder (fast: a directory scan).
let importedSkills: string[] = [];
try {
  importedSkills = syncSkills().added;
} catch {
  importedSkills = []; // a broken skills folder must never block startup
}

// ctrl+c belongs to the App: once clears the prompt, twice closes.
// The error console OpenTUI opens on uncaught errors gets a title with its close keys.
const renderer = await createCliRenderer({ exitOnCtrlC: false, consoleOptions: { title: CONSOLE_TITLE } });
installConsoleClose(renderer);

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
    initialModel,
    importedSkills,
    onQuit: quit,
  }),
);

process.on("SIGTERM", quit);
