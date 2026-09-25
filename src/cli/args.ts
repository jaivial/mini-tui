/**
 * Command-line parsing for every mini-tui entry point: the interactive TUI (`run`/`view`),
 * headless runs (`-p`/`--print`) and the scripting subcommands (`sessions`, `models`, …).
 * Pure (no I/O) so each shape is unit-tested; `index.ts` dispatches on `command`.
 */

export type OutputFormat = "text" | "json" | "stream-json";
export const OUTPUT_FORMATS: OutputFormat[] = ["text", "json", "stream-json"];

export interface CommonArgs {
  model?: string;
  specs?: string[];
  showSystem?: boolean;
}

export interface TuiArgs extends CommonArgs {
  command: "run" | "view";
  task?: string;
  viewPath?: string;
  follow?: boolean;
}

/** `mini-tui -p "<prompt>"`: one agent run with no TUI, result on stdout, then exit. */
export interface HeadlessArgs extends CommonArgs {
  command: "print";
  /** Positional prompt (stdin is appended / used when this is empty). */
  prompt: string;
  outputFormat: OutputFormat;
  /** Stream every step (text: to stderr; stream-json: thinking + full outputs too). */
  verbose: boolean;
  /** Nothing but the final answer: no error log tail, no hints on stderr. */
  quiet: boolean;
  /** Continue the most recent session of `cwd`. */
  continueLast: boolean;
  /** Continue this saved session (id or unique id prefix). */
  resumeId?: string;
  /** Do not save the run to the /resume history. */
  noSession: boolean;
  /** Compact a resumed session instead of sending a prompt. */
  compact: boolean;
  cwd?: string;
  maxSteps?: number;
  costLimit?: number;
  /** Wall-clock limit in seconds. */
  timeout?: number;
}

export type SessionsAction = "list" | "show" | "rm";

export interface SessionsArgs {
  command: "sessions";
  action: SessionsAction;
  id?: string;
  /** list: every folder, not only the current one. */
  all: boolean;
  limit: number;
  query: string;
  json: boolean;
  cwd?: string;
}

export interface ModelsArgs {
  command: "models";
  json: boolean;
}

export interface ModelArgs {
  command: "model";
  /** Set the default model of new sessions (what `/model` does); empty prints it. */
  model?: string;
  json: boolean;
}

export interface SkillsArgs {
  command: "skills";
  json: boolean;
}

export interface SettingsArgs {
  command: "settings";
  key?: string;
  value?: string;
  json: boolean;
}

export interface HelpArgs {
  command: "help";
}

export interface VersionArgs {
  command: "version";
}

export type CliArgs =
  | TuiArgs
  | HeadlessArgs
  | SessionsArgs
  | ModelsArgs
  | ModelArgs
  | SkillsArgs
  | SettingsArgs
  | HelpArgs
  | VersionArgs;

export class UsageError extends Error {}

const SUBCOMMANDS = new Set(["run", "view", "sessions", "session", "models", "model", "skills", "settings", "help", "version"]);

function takeValue(argv: string[], i: number, flag: string): string {
  const value = argv[i + 1];
  if (value === undefined || value === "") throw new UsageError(`${flag} needs a value`);
  return value;
}

function positiveNumber(raw: string, flag: string, integer = false): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    throw new UsageError(`${flag} needs a ${integer ? "whole " : ""}number >= 0 (got ${JSON.stringify(raw)})`);
  }
  return value;
}

/** `--flag=value` → [`--flag`, `value`], so both spellings parse the same. */
function splitInline(argv: string[]): string[] {
  const out: string[] = [];
  for (const arg of argv) {
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 2) out.push(arg.slice(0, eq), arg.slice(eq + 1));
    else out.push(arg);
  }
  return out;
}

function isHeadless(argv: string[]): boolean {
  for (const arg of argv) {
    if (arg === "--") return false;
    if (arg === "-p" || arg === "--print") return true;
  }
  return false;
}

export function parseArgs(rawArgv: string[]): CliArgs {
  // `-c key=value` specs contain "=" too: only split long flags, never their values.
  const argv: string[] = [];
  for (let i = 0; i < rawArgv.length; i++) {
    const arg = rawArgv[i]!;
    if (arg === "-c" || arg === "--config" || arg === "-t") {
      argv.push(arg, rawArgv[++i] ?? "");
      continue;
    }
    argv.push(...splitInline([arg]));
  }
  if (argv.length === 0) return { command: "run" }; // bare `mini-tui` opens the prompt
  if (argv[0] === "-h" || argv[0] === "--help" || argv[0] === "help") return { command: "help" };
  if (argv[0] === "-V" || argv[0] === "--version" || argv[0] === "version") return { command: "version" };
  if (isHeadless(argv)) return parseHeadless(argv[0] === "run" ? argv.slice(1) : argv);
  const [command, ...rest] = argv;
  if (command === "sessions" || command === "session") return parseSessions(rest);
  if (command === "models") return { command: "models", json: rest.includes("--json") };
  if (command === "model") return parseModel(rest);
  if (command === "skills") return { command: "skills", json: rest.includes("--json") };
  if (command === "settings") return parseSettings(rest);
  if (command === "run" || command === "view") return parseTui(command, rest);
  if (!SUBCOMMANDS.has(command!) && !command!.startsWith("-")) {
    throw new UsageError(`unknown command: ${command} (a headless run is \`mini-tui -p "<prompt>"\`)`);
  }
  return parseTui("run", argv);
}

function parseTui(command: "run" | "view", rest: string[]): TuiArgs {
  const args: TuiArgs = { command };
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "-m" || arg === "--model") args.model = takeValue(rest, i++, arg);
    else if (arg === "-c" || arg === "--config") args.specs = [...(args.specs ?? []), takeValue(rest, i++, arg)];
    else if (arg === "--follow") args.follow = true;
    else if (arg === "--show-system") args.showSystem = true;
    else if (arg.startsWith("-") && arg !== "-") throw new UsageError(`unknown option: ${arg}`);
    else if (arg) positional.push(arg);
  }
  if (command === "view") {
    args.viewPath = positional[0];
    if (!args.viewPath) throw new UsageError("view needs a trajectory path");
  } else if (positional.length) {
    args.task = positional.join(" ");
  }
  return args;
}

function parseHeadless(argv: string[]): HeadlessArgs {
  const args: HeadlessArgs = {
    command: "print",
    prompt: "",
    outputFormat: "text",
    verbose: false,
    quiet: false,
    continueLast: false,
    noSession: false,
    compact: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "-p":
      case "--print":
        break;
      case "--":
        positional.push(...argv.slice(i + 1));
        i = argv.length;
        break;
      case "-m":
      case "--model":
        args.model = takeValue(argv, i++, arg);
        break;
      case "-c":
      case "--config":
        args.specs = [...(args.specs ?? []), takeValue(argv, i++, arg)];
        break;
      case "-t":
      case "--task":
        positional.push(takeValue(argv, i++, arg));
        break;
      case "-o":
      case "--output-format": {
        const value = takeValue(argv, i++, arg) as OutputFormat;
        if (!OUTPUT_FORMATS.includes(value)) throw new UsageError(`${arg} must be one of ${OUTPUT_FORMATS.join(", ")}`);
        args.outputFormat = value;
        break;
      }
      case "--json":
        args.outputFormat = "json";
        break;
      case "-v":
      case "--verbose":
        args.verbose = true;
        break;
      case "-q":
      case "--quiet":
        args.quiet = true;
        break;
      case "-C":
      case "--continue":
        args.continueLast = true;
        break;
      case "-r":
      case "--resume":
        args.resumeId = takeValue(argv, i++, arg);
        break;
      case "--no-session":
        args.noSession = true;
        break;
      case "--compact":
        args.compact = true;
        break;
      case "--cwd":
        args.cwd = takeValue(argv, i++, arg);
        break;
      case "--max-steps":
        args.maxSteps = positiveNumber(takeValue(argv, i++, arg), arg, true);
        break;
      case "--cost-limit":
        args.costLimit = positiveNumber(takeValue(argv, i++, arg), arg);
        break;
      case "--timeout":
        args.timeout = positiveNumber(takeValue(argv, i++, arg), arg, true);
        break;
      case "--show-system":
        args.showSystem = true;
        break;
      default:
        if (arg.startsWith("-") && arg !== "-") throw new UsageError(`unknown option for -p: ${arg}`);
        if (arg !== "-") positional.push(arg);
    }
  }
  args.prompt = positional.join(" ").trim();
  if (args.verbose && args.quiet) throw new UsageError("--verbose and --quiet exclude each other");
  if (args.continueLast && args.resumeId) throw new UsageError("use either --continue or --resume <id>");
  if (args.compact && !args.continueLast && !args.resumeId) throw new UsageError("--compact needs --continue or --resume <id>");
  if (args.compact && args.noSession) throw new UsageError("--compact updates a saved session: drop --no-session");
  return args;
}

function parseSessions(rest: string[]): SessionsArgs {
  const args: SessionsArgs = { command: "sessions", action: "list", all: false, limit: 20, query: "", json: false };
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--json") args.json = true;
    else if (arg === "-a" || arg === "--all") args.all = true;
    else if (arg === "-n" || arg === "--limit") args.limit = positiveNumber(takeValue(rest, i++, arg), arg, true);
    else if (arg === "--search" || arg === "-s") args.query = takeValue(rest, i++, arg);
    else if (arg === "--cwd") args.cwd = takeValue(rest, i++, arg);
    else if (arg.startsWith("-")) throw new UsageError(`unknown option for sessions: ${arg}`);
    else positional.push(arg);
  }
  const [action, id] = positional;
  if (action === undefined || action === "list" || action === "ls") return args;
  if (action === "show" || action === "rm" || action === "delete") {
    if (!id) throw new UsageError(`sessions ${action} needs a session id`);
    return { ...args, action: action === "delete" ? "rm" : action, id };
  }
  // `mini-tui sessions <id>` is `show`
  return { ...args, action: "show", id: action };
}

function parseModel(rest: string[]): ModelArgs {
  const json = rest.includes("--json");
  const positional = rest.filter((arg) => arg !== "--json");
  if (positional.some((arg) => arg.startsWith("-"))) throw new UsageError("usage: mini-tui model [<model id>] [--json]");
  return { command: "model", model: positional[0], json };
}

function parseSettings(rest: string[]): SettingsArgs {
  const json = rest.includes("--json");
  const positional = rest.filter((arg) => arg !== "--json");
  const [key, value] = positional;
  if (key && value === undefined) throw new UsageError(`settings ${key} needs a value`);
  return { command: "settings", key, value, json };
}

/**
 * mini's `-c` semantics: the specs *replace* the default config. A headless run that only
 * passes `key=value` overrides (or `--max-steps`, …) means "the default config, plus these",
 * so the default config file goes first unless a file spec was given.
 */
export function withDefaultConfig(specs: string[], defaultSpec: string = process.env.MSWEA_MINI_CONFIG_PATH || "mini"): string[] {
  if (!specs.length || specs.some((spec) => !spec.includes("="))) return specs;
  return [defaultSpec, ...specs];
}

/** `-c` specs for a headless run: user specs, then the limit flags. */
export function headlessSpecs(args: HeadlessArgs): string[] {
  const specs = [...(args.specs ?? [])];
  if (args.maxSteps !== undefined) specs.push(`agent.step_limit=${args.maxSteps}`);
  if (args.costLimit !== undefined) specs.push(`agent.cost_limit=${args.costLimit}`);
  if (args.timeout !== undefined) specs.push(`agent.wall_time_limit_seconds=${args.timeout}`);
  return withDefaultConfig(specs);
}
