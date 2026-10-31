import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard, usePaste, useSelectionHandler, useTerminalDimensions } from "@opentui/react";
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import type { Database } from "bun:sqlite";
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";

import { colors, applyTheme, DEFAULT_THEME } from "./theme";
import { buildItems, buildItemsIncremental, type Item, type ItemBuildCache } from "./items";
import { StatusLine } from "./components/StatusLine";
import { TaskCard } from "./components/TaskCard";
import { StepCard } from "./components/StepCard";
import { AssistantCard } from "./components/AssistantCard";
import { NoticeLine } from "./components/NoticeLine";
import { ExitBanner } from "./components/ExitBanner";
import { ErrorBanner } from "./components/ErrorBanner";
import { ThinkingCard } from "./components/ThinkingCard";
import { PromptBar } from "./components/PromptBar";
import { ModelPicker, MODELS } from "./components/ModelPicker";
import { SettingsPanel, SETTINGS_GROUPS, JEV_GROUP } from "./components/SettingsPanel";
import { TasksModal, TASK_FILTERS, visibleTasks, type TaskFilter } from "./components/TasksModal";
import { WorkspacesModal, type WorkspaceRow, type WorkspaceStep } from "./components/WorkspacesModal";
import { completeFolder, completePath } from "./pathComplete";
import { AttachmentsBar, attachmentsBarRows } from "./components/AttachmentsBar";
import { MAX_STAGED, escapeAttachPath, humanSize, localAttachmentText, parseAttachArgs, stageFile, type StagedAttachment } from "../attach";
import { JevSettings } from "./components/JevSettings";
import { HelpPanel } from "./components/HelpPanel";
import { Modal } from "./components/Modal";
import { SessionModal } from "./components/SessionModal";
import { CommandPalette, PALETTE_ROWS, buildOptions, matchOptions, type CommandOption } from "./components/CommandPalette";
import { ConnectWizard } from "./components/ConnectWizard";
import { McpPanel } from "./components/McpPanel";
import { addRows, type McpStep } from "../mcpPanel";
import * as mcp from "../mcp/index";
import { openUrl } from "../openUrl";
import type { ConnectStep } from "../connect";
import { filterModels, filterProviders } from "../connect";
import {
  PROVIDERS,
  connectionModelOptions,
  fetchProviderModels,
  loadConnections,
  modelEnv,
  saveConnection,
  testProviderModel,
  type ProviderDef,
} from "../providers";
import { cleanTaskText, createParseState, messagesToEvents, parseInfo, type ParseState } from "../traj/parse";
import { boundEvent, slimMessage } from "../traj/slim";
import { readTrajectory, watchTrajectory, type WatchHandle } from "../traj/watch";
import { sessionRunEnv, sessionTrajectories } from "../mini/sessionEnv";
import { SubagentSync, type SubagentView } from "../mini/subagents";
import { attachMini, foreignRunAlive, runnerSupportsCompactOnly, spawnMini, tailLog, type MiniRun, type TaskSpec } from "../mini/spawn";
import { DEFAULT_MODEL } from "../config";
import { copyText, pasteText, pastedLine, pastedToken } from "../clipboard";
import { gitBranch, shortPath } from "../git";
import { WheelSpeed } from "../scroll";
import {
  DEFAULT_DB_PATH,
  PAGE_SIZE,
  countSessions,
  createSession,
  fallbackTitle,
  getLiveRun,
  getSession,
  getSessionPreview,
  listSessions,
  openDb,
  saveTranscript,
  registerLiveRun,
  rememberAgentRun,
  clearLiveRun,
  writeResumeFile,
  type SessionRecord,
} from "../sessions";
import { generateTitle } from "../title";
import { PromptHistory } from "../history";
import { SKILLS_DIR, expandSkills, filterSkills, insertSkill, listSkills, skillQueryAt } from "../skills";
import { SkillHighlighter } from "./skillHighlight";
import { fromCursorOffset, tabWidthOf, toCursorOffset } from "./textOffsets";
import { chatModeOf, loadSettings, saveSettings, settingsFilePath, type Settings } from "../settings";
import { addWorkspace, expandHome, listWorkspaces, removeWorkspace, renameWorkspace, workspaceForCwd, type SavedWorkspace } from "../workspaces";
import { EMPTY_QUEUE, cleanQueueEvents, queueBadge, type AttachmentRef, type QueueClientLike, type QueueState, type SessionMetaView } from "../queueClient";
import { gitDiff } from "../jev/diff";
import { pickReader } from "../jev/reader";
import { formatReport, verifyDiff } from "../jev/verifier";
import { saveLastModel } from "../lastModel";
import type { RunEvent, RunInfo, Trajectory, TrajectoryMessage } from "../traj/schema";

const COMMAND_OPTIONS = buildOptions(MODELS);
/** Prompts that open the completion palette: a leading `/` command, or a `$skill` being typed
 * at the cursor (anywhere in the prompt). */
const isPaletteText = (text: string, cursor: number = text.length) => text.startsWith("/") || skillQueryAt(text, cursor) !== null;
const ESC_DOUBLE_MS = 800;
/** Window for the second ctrl+c that closes the TUI (the first one only clears the prompt). */
const CTRL_C_DOUBLE_MS = 1500;
/** Transcript saves while a run streams: at most one per this interval (plus one per turn). */
const SAVE_EVERY_MS = 30_000;
/** Quiet time before a save (batches the burst of snapshots a single step produces). */
const SAVE_SETTLE_MS = 1000;

/** First-frame guess at the prompt's wrapped rows, before the textarea has laid its text out
 * (character wrap; the textarea's own count replaces it right after). */
export function estimatePromptRows(text: string, width: number): number {
  return text.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil((line.length + 1) / width)), 0);
}

/**
 * Transcript mounts are bounded by the visible viewport, not by conversation
 * length. Two viewports keep scrolling responsive while avoiding native text
 * buffers for content the terminal cannot show. The 120-item ceiling preserves
 * the previous UX on unusually tall terminals; `g` pages older items in.
 */
export function mountedItemLimit(viewportRows: number): number {
  if (!Number.isFinite(viewportRows)) return 24;
  const rows = Math.max(1, Math.floor(viewportRows));
  return Math.max(24, Math.min(120, rows * 2));
}
/** Stable identity: a fresh literal would re-apply (and re-render) on every commit. */
const CONTENT_OPTIONS = { gap: 1 };

export interface AppProps {
  cwd: string;
  showSystem?: boolean;
  /** Pre-parsed data for static rendering (tests). Disables spawn/watch. */
  events?: RunEvent[];
  info?: RunInfo;
  /** View mode: an existing trajectory file. */
  viewPath?: string;
  follow?: boolean;
  /** Run mode: start immediately with this task (otherwise wait for the prompt). */
  runSpec?: TaskSpec;
  /** Force the bottom-stack status (for screenshot scenes); otherwise derived from the run. */
  statusOverride?: "running" | "done" | "error" | "idle";
  /** Override persisted settings (tests/screenshots). */
  initialSettings?: Settings;
  /** Persist settings/sessions to disk (tests set this to false). */
  persistSettings?: boolean;
  /** Sessions database path (tests use a temporary file). */
  dbPath?: string;
  /** Override prompt submission (tests); otherwise runs a task or continues the run. */
  onSend?: (text: string) => void;
  /** Skills folder for `$skill` prompts (tests); defaults to `~/.config/mini-tui/skills`. */
  skillsDir?: string;
  /** Model this launch starts with (-m / $MINITUI_MODEL / the last model picked anywhere). */
  initialModel?: string;
  /** Skills the startup sync just imported from `~/.claude/skills` (shown once as a notice). */
  importedSkills?: string[];
  /** Override clipboard writes (tests); defaults to OSC 52 + tmux buffer + native tools. */
  onCopy?: (text: string) => void;
  /** Override clipboard reads for ctrl+v/shift+insert (tests); defaults to `pasteText`. */
  onPasteText?: () => string;
  /** Observe double-Esc interrupts (tests). */
  onInterrupt?: () => void;
  /** Override the provider connection test (tests); defaults to a real one-token query. */
  testModel?: (modelName: string, key: string) => Promise<boolean>;
  /** Override opening a URL in the browser (tests); returns the opener used, "" when none. */
  onOpenUrl?: (url: string) => string;
  /** MCP store file (tests); defaults to `~/.config/mini-tui/mcp.json`. */
  mcpPath?: string | null;
  /**
   * The work-queue client the dispatcher chat mode talks to (a factory is called on first use).
   * Absent = no dispatcher here (tests, `view`, `run`): the chat behaves as in manual mode.
   */
  queue?: QueueClientLike | (() => QueueClientLike) | null;
  onQuit?: () => void;
}

type Overlay = "none" | "model" | "settings" | "help" | "resume" | "connect" | "mcp" | "tasks" | "workspaces";

/** Settings compared by value (key order differs between a load and a patch). */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((k) => [k, canonical((value as Record<string, unknown>)[k])]));
  }
  return value;
}
function sameSettings(a: Settings, b: Settings): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Value-level message identity across re-parses (trajectory files are re-read whole). */
function sameMessage(a: TrajectoryMessage | undefined, b: TrajectoryMessage | undefined): boolean {
  return (
    Boolean(a && b) &&
    a?.role === b?.role &&
    String(a?.content ?? "") === String(b?.content ?? "") &&
    a?.tool_call_id === b?.tool_call_id
  );
}

/** The agent answered and holds at exit: an `exit` message is followed only by notices
 * (e.g. a `/compact` result), never by a new task. */
function waitingAtExit(messages: TrajectoryMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "exit") return true;
    const itype = (message.extra as Record<string, unknown> | undefined)?.interrupt_type;
    if (itype !== "Compaction" && itype !== "CompactionSkipped") return false;
  }
  return false;
}

function sameRunInfo(a: RunInfo, b: RunInfo): boolean {
  return (
    a.model === b.model &&
    a.cost === b.cost &&
    a.apiCalls === b.apiCalls &&
    a.exitStatus === b.exitStatus &&
    a.submission === b.submission &&
    a.trajectoryFormat === b.trajectoryFormat
  );
}

export type RunStatus = "running" | "done" | "error" | "idle" | "interrupted";

/**
 * Status chip for the bottom line. The agent holds a run open at exit to take follow-ups
 * (the exit stays in its append-only journal), so an exit only means "finished" while it is
 * the *last* event — a follow-up after it is live work again, whatever the process says.
 * A trailing `error` (a crash's log tail) reads error the same way.
 */
export function deriveStatus(status: RunStatus, events: RunEvent[]): RunStatus {
  if (status === "interrupted") return status;
  // Only the agent's own events can say it is working again. A notice the UI writes itself (a
  // `/model` switch, a missing-skill warning, "nothing to compact") is not work: skipping it keeps a
  // finished turn finished, instead of a model change reading as "running" with nothing running.
  let end = events.length;
  while (end > 0 && isUiNote(events[end - 1]!)) end--;
  const last = events[end - 1];
  if (last?.type === "exit") return !last.exitStatus || last.exitStatus === "Submitted" ? "done" : "error";
  if (last?.type === "error") return "error";
  return status;
}

/** Notices mini-tui adds to the transcript itself, as opposed to ones parsed from the agent's journal. */
const UI_NOTES = new Set(["model", "skills", "subagents", "queue", "workspace", "attach"]);
/** A prompt that is an `/attach` with arguments started (Tab completes its last path). */
const ATTACH_ARGS = /^\/attach\s/i;
function isUiNote(event: RunEvent): boolean {
  return event.type === "notice" && (!event.interruptType || UI_NOTES.has(event.interruptType));
}

export function App(props: AppProps) {
  const staticMode = Boolean(props.events);
  const [events, setEvents] = useState<RunEvent[]>(() => {
    const initial = props.events ?? [];
    const imported = props.importedSkills ?? [];
    if (!imported.length) return initial;
    const names = imported.map((name) => `$${name}`).join(", ");
    return [...initial, { type: "notice", text: `imported ${imported.length} skill${imported.length > 1 ? "s" : ""} from ~/.claude/skills: ${names}`, interruptType: "skills" }];
  });
  const itemAppendHint = useRef(false);
  const [info, setInfo] = useState<RunInfo>(props.info ?? { cost: 0, apiCalls: 0 });
  const [status, setStatus] = useState<RunStatus>(
    props.statusOverride ?? (props.runSpec ? "running" : staticMode || props.viewPath ? "done" : "idle"),
  );
  const [focusIdx, setFocusIdx] = useState(0);
  const [flipped, setFlipped] = useState<Set<number>>(new Set());
  /** Top of the mounted transcript window when reading history (null = follow the live tail). */
  const [anchor, setAnchor] = useState<number | null>(null);
  const [modelOverride, setModelOverride] = useState<string | undefined>(() => props.initialModel || undefined);
  const [settings, setSettings] = useState<Settings>(() => {
    const loaded = props.initialSettings ?? loadSettings();
    applyTheme(loaded.theme ?? DEFAULT_THEME);
    return loaded;
  });
  const [settingsGroup, setSettingsGroup] = useState(0);
  /** The verifier phase runs in the background after a turn; its report lands as a notice. */
  const [verifying, setVerifying] = useState(false);
  const verifyingRef = useRef(false);
  /** Read at fire time so a toggle flipped mid-run is the one that counts. */
  const settingsRef = useRef<Settings>(settings);
  settingsRef.current = settings;
  const [inputFocused, setInputFocusedState] = useState(true);
  const [overlayState, setOverlayState] = useState<Overlay>("none");
  /** ctrl+c was pressed once: the prompt placeholder says a second press closes. */
  const [closeArmed, setCloseArmed] = useState(false);
  const [promptText, setPromptTextState] = useState("");
  /** Rows the prompt textarea wraps its text into (read from its layout). */
  const [promptWrapRows, setPromptWrapRows] = useState<number | null>(null);
  const [paletteDismissed, setPaletteDismissedState] = useState(false);
  const [paletteIdx, setPaletteIdxState] = useState(0);
  const [resumeQuery, setResumeQueryState] = useState("");
  const [resumePage, setResumePageState] = useState(0);
  const [resumeIdx, setResumeIdxState] = useState(0);
  const [resumeRows, setResumeRows] = useState<SessionRecord[]>([]);
  const [resumePages, setResumePages] = useState(0);
  /** The session previewed read-only inside the /resume panel (null = the list). */
  const [resumePreview, setResumePreviewState] = useState<SessionRecord | null>(null);
  const [connectStep, setConnectStepState] = useState<ConnectStep | null>(null);
  const [connections, setConnections] = useState(() => loadConnections());
  const mcpFile = props.mcpPath === undefined ? mcp.mcpPath() : props.mcpPath;
  const [mcpStep, setMcpStepState] = useState<McpStep | null>(null);
  const mcpRef = useRef<McpStep | null>(null);
  const [mcpServers, setMcpServers] = useState<mcp.McpServerView[]>([]);
  const mcpServersRef = useRef<mcp.McpServerView[]>([]);
  const mcpLoginUnsub = useRef<(() => void) | null>(null);
  const [mcpNow, setMcpNow] = useState(() => Date.now());
  // Key handlers can fire several times before React re-renders; mirror what they
  // read/write into refs so state is never stale inside a batch of keystrokes.
  const inputRefocus = useRef(true);
  const overlayRef = useRef<Overlay>("none");
  const exitedRef = useRef(false);
  const interruptedRef = useRef(false);
  /** Prompt focus before the first Esc of a pair, restored by the second (see `escapePress`). */
  const focusBeforeEsc = useRef(true);
  const promptRef = useRef("");
  const dismissedRef = useRef(false);
  const paletteIdxRef = useRef(0);
  const lastEscAt = useRef(0);
  const lastCtrlCAt = useRef(0);
  const historyRef = useRef(new PromptHistory());
  const followRef = useRef(true);
  /** Start of the current turn, as state so the status line restarts its timer. */
  const [turnStartedAt, setTurnStartedAt] = useState(0);
  /** A compaction is in flight ("manual" = `/compact`, "auto"/"overflow" = the agent's own). */
  const [compacting, setCompacting] = useState<string | null>(null);
  const compactOnlyRef = useRef(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<TextareaRenderable | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  /** Tasks echoed into the thread at send time, waiting for their journal twin. */
  const pendingTasksRef = useRef<string[]>([]);
  const messagesRef = useRef<TrajectoryMessage[]>([]);
  const dbRef = useRef<Database | null>(null);
  const resumeQueryRef = useRef("");
  const resumePageRef = useRef(0);
  const resumeIdxRef = useRef(0);
  const resumeRowsRef = useRef<SessionRecord[]>([]);
  const resumePreviewRef = useRef<SessionRecord | null>(null);
  const previewScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const connectRef = useRef<ConnectStep | null>(null);
  const commandOptionsRef = useRef<CommandOption[]>([]);
  /** The folder new sessions start in: the launch folder, or the workspace picked in manual mode. */
  const [cwd, setCwdState] = useState(props.cwd);
  const cwdRef = useRef(props.cwd);
  const setCwd = (value: string) => {
    cwdRef.current = value;
    setCwdState(value);
  };
  const branch = useMemo(() => gitBranch(cwd), [cwd]);

  const setMcpStep = (value: McpStep | null) => {
    mcpRef.current = value;
    setMcpStepState(value);
  };
  const reloadMcp = () => {
    // The installed servers only: the built-in `cu` server is a fixed line of the panel, not a
    // row (nothing to install, log in, disable or remove; McpPanel shows it under the list).
    const views = mcp.listViews(mcpFile);
    mcpServersRef.current = views;
    setMcpServers(views);
    return views;
  };
  const setInputFocused = (value: boolean) => {
    inputRefocus.current = value;
    setInputFocusedState(value);
  };
  const setOverlay = (value: Overlay) => {
    overlayRef.current = value;
    setOverlayState(value);
    if (value !== "resume") setResumePreview(null); // /resume always reopens on its list
    if (value !== "mcp") {
      // Leaving the panel cancels a login still waiting for the browser (its listener goes away).
      const step = mcpRef.current;
      if (step?.kind === "login" && (step.login.status === "pending")) mcp.cancelLogin(step.login.id);
      mcpLoginUnsub.current?.();
      mcpLoginUnsub.current = null;
    }
  };
  const setPromptText = (value: string) => {
    promptRef.current = value;
    setPromptTextState(value);
  };
  const setPaletteDismissed = (value: boolean) => {
    dismissedRef.current = value;
    setPaletteDismissedState(value);
  };
  const setPaletteIdx = (value: number) => {
    paletteIdxRef.current = value;
    setPaletteIdxState(value);
  };
  const setResumeQuery = (value: string) => {
    resumeQueryRef.current = value;
    resumePageRef.current = 0;
    resumeIdxRef.current = 0;
    setResumeQueryState(value);
    setResumePageState(0);
    setResumeIdxState(0);
  };
  const setResumePage = (value: number) => {
    resumePageRef.current = value;
    resumeIdxRef.current = 0;
    setResumePageState(value);
    setResumeIdxState(0);
  };
  const setResumeIdx = (value: number) => {
    resumeIdxRef.current = value;
    setResumeIdxState(value);
  };
  const setResumePreview = (listed: SessionRecord | null) => {
    // list rows carry metadata only: load this one session's transcript for the preview
    let value = listed;
    if (listed) {
      try {
        value = getSessionPreview(db(), listed.id) ?? listed;
      } catch {
        value = listed;
      }
    }
    resumePreviewRef.current = value;
    setResumePreviewState(value);
  };
  const setConnectStep = (value: ConnectStep | null) => {
    connectRef.current = value;
    setConnectStepState(value);
  };
  const dims = useTerminalDimensions();
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const wheelAccel = useMemo(() => new WheelSpeed(), []);
  const live = useRef<{ watch?: WatchHandle; run?: MiniRun }>({});

  const persist = props.persistSettings !== false;
  const db = (): Database => (dbRef.current ??= openDb(props.dbPath ?? DEFAULT_DB_PATH));

  // Connected providers contribute their models to /model and its palette entries.
  const modelOptions = useMemo(() => [...MODELS, ...connectionModelOptions(connections)], [connections]);
  const commandOptions = useMemo(() => buildOptions(modelOptions), [modelOptions]);
  commandOptionsRef.current = commandOptions;
  const skillsDir = props.skillsDir ?? SKILLS_DIR;
  // Read once per launch: `$` completes against the skills installed right now.
  const skillOptions = useMemo<CommandOption[]>(
    () =>
      listSkills(skillsDir).map((skill) => ({
        insert: `$${skill.name} `,
        label: `$${skill.name}`,
        detail: skill.description.length > 72 ? `${skill.description.slice(0, 71)}…` : skill.description,
        full: skill.description,
      })),
    [skillsDir],
  );
  const skillOptionsRef = useRef<CommandOption[]>([]);
  skillOptionsRef.current = skillOptions;
  const skillNames = useMemo(() => new Set(skillOptions.map((o) => o.label.slice(1))), [skillOptions]);
  /** Cursor offset in the prompt buffer (the `$` panel completes the token under it). */
  const cursorOf = (text: string): number => {
    try {
      // the textarea counts display columns (wide chars, tabs): convert to a string index
      const offset = textareaRef.current?.cursorOffset;
      return typeof offset === "number" ? fromCursorOffset(text, offset, tabWidthOf(textareaRef.current)) : text.length;
    } catch {
      return text.length;
    }
  };
  /** Put the textarea cursor at string index `index` of `text`. */
  const setCursorAt = (text: string, index: number) => {
    const area = textareaRef.current;
    if (area) area.cursorOffset = toCursorOffset(text, index, tabWidthOf(area));
  };
  /** Palette rows for the prompt text: commands after a leading `/`, skills for a `$name` being
   * typed anywhere — matched on any word of the name in any order, so `$pr` lists `$pr-body`,
   * `$pr-fix-loop`, … and `$body` or `$body-pr` finds `$pr-body` too. A name match always wins; the description is searched too, but only below every name rank. */
  const paletteFor = (text: string, cursor: number = cursorOf(text)): CommandOption[] => {
    if (text.startsWith("/") && !text.includes(" ")) return matchOptions(text, commandOptionsRef.current);
    if (text.startsWith("/model ")) return matchOptions(text, commandOptionsRef.current);
    const at = skillQueryAt(text, cursor);
    return at
      ? filterSkills(at.query, skillOptionsRef.current, (option) => option.label.slice(1), (option) => option.full)
      : [];
  };

  // `$skill` references in the prompt keep a color of their own (known skills only).
  const highlighterRef = useRef(new SkillHighlighter());
  useEffect(() => {
    highlighterRef.current.apply(textareaRef.current, promptText, skillNames);
  }, [promptText, skillNames, settings.theme]);

  const paletteOptions = !paletteDismissed ? paletteFor(promptText) : [];
  const paletteOpen = paletteOptions.length > 0 && inputFocused && overlayState === "none";
  // Soft-wrapped rows: long lines continue on the next row and grow the box (up to 8). The
  // textarea word-wraps, so only its own layout knows the real row count: a character-count
  // estimate came up short when a long word jumped to the next row, which scrolled that row
  // out of sight until a later edit. The estimate only covers the first frame.
  const promptContentWidth = Math.max(12, dims.width - 4);
  const promptRows = Math.min(8, Math.max(1, promptWrapRows ?? estimatePromptRows(promptText, promptContentWidth)));

  /** Replace the prompt buffer and park the cursor at its end (typing continues after it). */
  const writePrompt = (text: string) => {
    textareaRef.current?.setText(text);
    textareaRef.current?.gotoBufferEnd();
  };

  /** The buffer changed under the textarea (typing, paste): re-derive the palette state. A
   * freshly typed `/` or `$` (the token is just the sigil) reopens a dismissed panel. */
  const syncPromptText = (text: string) => {
    setPromptText(text);
    if (!ATTACH_ARGS.test(text)) setAttachHint("");
    const cursor = cursorOf(text);
    const skill = skillQueryAt(text, cursor);
    if (!isPaletteText(text, cursor)) setPaletteDismissed(false);
    else if ((text.startsWith("/") && text.length <= 1) || (skill && skill.query === "")) {
      setPaletteDismissed(false);
      setPaletteIdx(0);
    }
  };

  /** Replace the buffer and put the cursor at `cursor` (palette typing mid-phrase). */
  const editPrompt = (text: string, cursor: number) => {
    textareaRef.current?.setText(text);
    try {
      setCursorAt(text, cursor);
    } catch {
      textareaRef.current?.gotoBufferEnd();
    }
    setPromptText(text);
    if (!isPaletteText(text, cursor)) setPaletteDismissed(false);
    setPaletteIdx(0);
  };

  const applyPromptText = (text: string) => {
    writePrompt(text);
    setPromptText(text);
    if (!isPaletteText(text)) setPaletteDismissed(false);
    setPaletteIdx(0);
  };

  /** Cursor right after an auto-inserted `$skill ` space: punctuation typed next replaces it. */
  const skillSpaceAt = useRef(-1);

  const completeOption = (option: CommandOption) => {
    const current = promptRef.current;
    if (option.label.startsWith("$")) {
      // replace just the `$query` under the cursor: the rest of the phrase stays as typed
      const next = insertSkill(current, cursorOf(current), option.label.slice(1));
      textareaRef.current?.setText(next.text);
      try {
        setCursorAt(next.text, next.cursor);
      } catch {
        textareaRef.current?.gotoBufferEnd();
      }
      setPromptText(next.text);
      skillSpaceAt.current = next.text[next.cursor - 1] === " " ? next.cursor : -1;
      setPaletteDismissed(false); // typing on continues; a new `$` reopens the panel
    } else {
      writePrompt(option.insert);
      setPromptText(option.insert);
      setPaletteDismissed(true);
    }
    setPaletteIdx(0);
    setInputFocused(true);
  };

  /** Messages are append-only per run: parse only what's new since the last snapshot. */
  const consumedRef = useRef(0);
  const parseStateRef = useRef<ParseState | undefined>(createParseState());
  /** Show the sent task at once — the trajectory only carries it with the next journal write. */
  const echoTask = (task: string) => {
    const text = cleanTaskText(task);
    pendingTasksRef.current.push(text);
    itemAppendHint.current = true;
    setEvents((prev) => [...prev, { type: "task", text }]);
  };
  const applySnapshot = (traj: Trajectory) => {
    const messages = traj.messages ?? [];
    // Only continue incrementally when the file grew from what we already consumed —
    // a replaced file (e.g. `view --follow` on another run's output) restarts from zero.
    const from = consumedRef.current;
    const prev = messagesRef.current;
    const contiguous = from > 0 && messages.length >= from && sameMessage(prev[from - 1], messages[from - 1]);
    const startFrom = contiguous ? from : 0;
    if (startFrom === 0 || !parseStateRef.current) {
      parseStateRef.current = createParseState(messages, startFrom);
    }
    const fresh = messagesToEvents(messages, { showSystem: props.showSystem }, startFrom, parseStateRef.current);
    // The TUI echoes every sent task at once; when the journal finally carries it, drop the
    // echo's parsed twin so a task shows exactly once (a rebuild starts from the truth anyway).
    let incoming = fresh;
    if (startFrom === 0) {
      pendingTasksRef.current = [];
    } else if (pendingTasksRef.current.length) {
      const pending = [...pendingTasksRef.current];
      incoming = fresh.filter((event) => {
        if (event.type !== "task") return true;
        const at = pending.indexOf(event.text);
        if (at === -1) return true;
        pending.splice(at, 1);
        return false;
      });
      pendingTasksRef.current = pending;
    }
    // Events are built: keep only the slim copy of the new messages (heavy extras dropped).
    // Reuse the retained array for append-only snapshots; slicing the entire
    // prefix on every poll was another O(n) allocation in long runs.
    const kept = startFrom === 0 ? [] : prev;
    if (startFrom > 0) kept.length = startFrom;
    for (let i = startFrom; i < messages.length; i++) kept.push(slimMessage(messages[i]!));
    messagesRef.current = kept;
    consumedRef.current = messages.length;
    itemAppendHint.current = startFrom > 0 && incoming.length > 0;
    setEvents((prevEvents) => (startFrom === 0 ? fresh : incoming.length ? [...prevEvents, ...incoming] : prevEvents));
    // A prompt sent to this agent from elsewhere (the web app follows the same agent): its task
    // lands here with no echo of ours, and the agent is working on it.
    if (startFrom > 0 && !exitedRef.current && !interruptedRef.current && incoming.some((event) => event.type === "task") && !waitingAtExit(messages)) {
      setStatus("running");
      setTurnStartedAt(Date.now());
    }
    const nextInfo = parseInfo(traj);
    setInfo((previous) => (sameRunInfo(previous, nextInfo) ? previous : nextInfo));
    // The agent's journal says when a summary call is running; a compaction message (or a
    // skipped marker) arriving ends a `/compact` we started.
    const agentCompacting = typeof traj.info?.compacting === "string" && traj.info.compacting ? traj.info.compacting : null;
    const finished = fresh.some((event) => event.type === "notice" && event.interruptType === "context");
    setCompacting((current) => agentCompacting ?? (finished ? null : current === "manual" ? current : null));
    // `/compact` has no model reply: once its result lands the agent is back waiting at exit
    if (finished && (compactOnlyRef.current || waitingAtExit(messages))) {
      compactOnlyRef.current = false;
      setStatus("done");
    }
  };

  useEffect(() => {
    if (staticMode) return;
    if (props.viewPath) {
      if (props.follow) {
        live.current.watch = watchTrajectory(props.viewPath, applySnapshot);
      } else {
        const traj = readTrajectory(props.viewPath);
        if (traj) applySnapshot(traj);
        else {
          itemAppendHint.current = false;
          setEvents([{ type: "notice", text: `Could not read trajectory: ${props.viewPath}` }]);
        }
      }
    } else if (props.runSpec) {
      echoTask(props.runSpec.task); // run mode: the task is on screen before mini even starts
      startRun(props.runSpec);
    }
    return () => {
      live.current.watch?.stop();
      live.current.run?.kill();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the session transcript saved once a session exists. Each save stringifies the whole
  // transcript (MBs on long runs), so while a run streams it is throttled to SAVE_EVERY_MS;
  // a finished turn (trailing exit) or a quiet transcript saves right away.
  const lastSaveAt = useRef(0);
  const latestSave = useRef<() => void>(() => {});
  latestSave.current = () => {
    const id = sessionIdRef.current;
    if (!persist || !id) return;
    // The web app owns the agent this terminal follows, and saves it: two writers would only fight.
    if (live.current.run?.attached && !exitedRef.current) return;
    lastSaveAt.current = Date.now();
    try {
      saveTranscript(db(), id, events, info, messagesRef.current);
    } catch {
      // persistence is best-effort
    }
  };
  useEffect(() => {
    if (!persist || !sessionIdRef.current) return;
    const turnOver = events[events.length - 1]?.type === "exit";
    const due = Math.max(0, lastSaveAt.current + SAVE_EVERY_MS - Date.now());
    const timer = setTimeout(() => latestSave.current(), turnOver ? SAVE_SETTLE_MS : Math.max(due, SAVE_SETTLE_MS));
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, info]);

  // Load one page of this folder's sessions whenever the /resume modal state changes.
  useEffect(() => {
    if (overlayState !== "resume") return;
    try {
      const total = countSessions(db(), cwd, resumeQuery);
      const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      const page = Math.min(resumePage, pages - 1);
      const rows = listSessions(db(), cwd, resumeQuery, page);
      resumeRowsRef.current = rows;
      setResumeRows(rows);
      setResumePages(pages);
    } catch {
      resumeRowsRef.current = [];
      setResumeRows([]);
      setResumePages(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlayState, resumeQuery, resumePage, cwd]);

  /**
   * The optional verifier phase (toggle 2), run after a turn finishes and the code is on disk.
   *
   * It is fire-and-forget on purpose: the phase adds a notice to the transcript, it never blocks
   * the prompt and never touches the run. The settings are read through `settingsRef` at fire
   * time, not captured, so turning it off while a run is finishing really does stop it.
   */
  const runVerifierPhase = () => {
    if (!settingsRef.current.jevVerifierEnabled) return;
    if (verifyingRef.current) return; // one at a time: a slow phase must not stack up
    verifyingRef.current = true;
    setVerifying(true);
    const folder = cwdRef.current;
    void (async () => {
      try {
        const diff = gitDiff(folder);
        const { reader, reason } = pickReader();
        const report = await verifyDiff({ diff, reader, readerReason: reason });
        itemAppendHint.current = true;
        setEvents((prev) => [
          ...prev,
          ...formatReport(report).map((text) => ({ type: "notice" as const, text, interruptType: "jev" })),
        ]);
      } catch (error) {
        // A broken phase must never take the run with it: say so and move on.
        itemAppendHint.current = true;
        setEvents((prev) => [...prev, { type: "notice", text: `jev · verifier failed: ${(error as Error).message}`, interruptType: "jev" }]);
      } finally {
        verifyingRef.current = false;
        setVerifying(false);
      }
    })();
  };

  const startRun = (spec: TaskSpec) => {
    setStatus("running");
    exitedRef.current = false;
    interruptedRef.current = false;
    setTurnStartedAt(Date.now());
    // Direct CLI run mode reaches startRun before the prompt handler creates a session.
    if (!sessionIdRef.current && persist) {
      const id = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      try {
        createSession(db(), { id, cwd: spec.cwd ?? cwdRef.current, model: spec.model || modelOverride || DEFAULT_MODEL, task: spec.task });
        sessionIdRef.current = id;
      } catch { /* persistence is best effort */ }
    }
    const id = sessionIdRef.current;
    let recovery: string[] = [];
    if (persist && id && spec.resumePath) {
      try { recovery = sessionTrajectories(db(), id, live.current.run?.session.trajPath); } catch { /* persistence is best effort */ }
    }
    const run = spawnMini({
      ...spec,
      model: spec.model || modelOverride,
      env: sessionRunEnv({ ...modelEnv(spec.model || modelOverride || DEFAULT_MODEL, connections), ...spec.env }, id, recovery),
    });
    live.current = { run };
    // Announce the agent, so the web app (or another terminal) opening this session follows this
    // very agent live and sends its prompts to it, instead of resuming a second copy beside it.
    const announced = sessionIdRef.current;
    if (persist && announced && run.pid) {
      try {
        rememberAgentRun(db(), announced, run.session.trajPath);
        registerLiveRun(db(), { session_id: announced, traj_path: run.session.trajPath, control_path: run.session.controlPath, pid: run.pid, owner: "tui" });
      } catch {
        // best-effort
      }
    }
    consumedRef.current = 0; // fresh trajectory: events rebuild from its first message
    parseStateRef.current = createParseState();
    live.current.watch = watchTrajectory(run.session.trajPath, applySnapshot);
    run.exited.then((code) => {
      if (persist && announced) {
        try {
          clearLiveRun(db(), announced, run.session.trajPath);
        } catch {
          // a stale row is harmless: its pid no longer runs that trajectory
        }
      }
      if (live.current.run !== run) return; // superseded (e.g. `/new`): don't touch the new session
      exitedRef.current = true;
      setCompacting(null);
      live.current.watch?.stop();
      const traj = readTrajectory(run.session.trajPath);
      if (traj) applySnapshot(traj);
      if (interruptedRef.current) {
        setStatus("interrupted"); // the user asked for this stop — not an error
      } else if (code === 0) {
        setStatus("done");
        runVerifierPhase();
      } else {
        setStatus("error");
        // Post the raw log tail into the thread at the failure point: as a transcript item it
        // scrolls up with the conversation instead of sticking to the bottom of the chat.
        const tail = tailLog(run.session.logPath);
        if (tail) {
          itemAppendHint.current = true;
          setEvents((prev) => [...prev, { type: "error", text: tail }]);
        }
      }
    });
  };

  /** Double Esc: interrupt the run in flight (SIGINT through `MiniRun.interrupt`). */
  const interruptRun = () => {
    if (props.onInterrupt) props.onInterrupt();
    if (dispatcherRef.current) {
      // a worker's session: back to the main chat; the main chat: stop the dispatcher's turn
      if (viewTaskRef.current) return backToMain();
      const main = queueStateRef.current.main;
      if (main) void queueClient()?.interrupt(main).catch(() => undefined);
      return;
    }
    if (remoteWsRef.current) {
      const id = remoteSessionRef.current;
      if (id) void queueClient()?.interrupt(id).catch((error: Error) => addNote(`could not interrupt: ${error.message}`, "workspace"));
      return;
    }
    const run = live.current.run;
    if (!run || exitedRef.current) return;
    interruptedRef.current = true;
    run.interrupt();
  };

  const openSession = (listed: SessionRecord) => {
    // list/preview rows don't carry the raw messages: read the full row now
    let record = listed;
    try {
      record = getSession(db(), listed.id) ?? listed;
    } catch {
      record = listed;
    }
    setOverlay("none");
    setResumeQuery("");
    sessionIdRef.current = record.id;
    pendingTasksRef.current = [];
    try {
      // bounded on the way in: sessions saved before outputs were bounded can hold 100+ MB
      const restoredEvents = (JSON.parse(record.events_json) as RunEvent[]).map(boundEvent);
      itemAppendHint.current = false;
      setEvents(restoredEvents);
      historyRef.current.reset(restoredEvents.flatMap((event) => (event.type === "task" ? [event.text] : [])));
      const restored = JSON.parse(record.info_json) as RunInfo;
      setInfo({ ...restored, cost: restored.cost ?? 0, apiCalls: restored.apiCalls ?? 0 });
      messagesRef.current = JSON.parse(record.messages_json) as TrajectoryMessage[];
      consumedRef.current = messagesRef.current.length;
      // The restored prefix is already represented by restoredEvents. Let the
      // next append establish parser state from that prefix once, without
      // reparsing the entire saved session during the click handler.
      parseStateRef.current = undefined;
    } catch {
      itemAppendHint.current = false;
      setEvents([{ type: "notice", text: "could not restore that session" }]);
    }
    setStatus("done");
    setInputFocused(true);
    void attachToLiveRun(record.id);
  };

  /**
   * The session may be running right now in the web app: follow that agent (its trajectory
   * streams here and prompts typed here reach it) instead of starting a second one beside it.
   */
  const attachToLiveRun = async (sessionId: string): Promise<void> => {
    let record;
    try {
      record = getLiveRun(db(), sessionId);
    } catch {
      return;
    }
    if (!record) return;
    const foreign = { trajPath: record.traj_path, controlPath: record.control_path, pid: record.pid };
    if (!(await foreignRunAlive(foreign))) return;
    live.current.watch?.stop();
    live.current.run?.kill();
    const run = attachMini(foreign);
    live.current = { run };
    exitedRef.current = false;
    interruptedRef.current = false;
    // Rebuild from the agent's own trajectory: it is newer than the owner's last save.
    consumedRef.current = 0;
    parseStateRef.current = createParseState();
    const traj = readTrajectory(foreign.trajPath);
    if (traj && (traj.messages ?? []).length) applySnapshot(traj);
    const holding = traj ? waitingAtExit(traj.messages ?? []) : false;
    setStatus(holding ? "done" : "running");
    if (!holding) setTurnStartedAt(Date.now());
    live.current.watch = watchTrajectory(foreign.trajPath, applySnapshot);
    run.exited.then(() => {
      if (live.current.run !== run) return;
      exitedRef.current = true;
      live.current.watch?.stop();
      const final = readTrajectory(foreign.trajPath);
      if (final) applySnapshot(final);
      setStatus((current) => (current === "running" ? "done" : current));
      // Same post-code phase as a run we started ourselves: a followed agent finished its turn too.
      if (!holding) runVerifierPhase();
    });
  };

  /** The subagents this session's agent started, saved as sessions under it (`/resume` opens them). */
  const subagentSync = useRef<SubagentSync | null>(null);
  const syncSubagents = (): SubagentView[] => {
    const id = sessionIdRef.current;
    const traj = live.current.run?.session.trajPath;
    if (!persist || !id || !traj) return [];
    subagentSync.current ??= new SubagentSync(db);
    try {
      return subagentSync.current.sync(id, traj);
    } catch {
      return [];
    }
  };
  useEffect(() => {
    if (staticMode) return;
    const timer = setInterval(() => syncSubagents(), 2000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function memLine(rss: number, avg: number): string {
    const f = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)}G` : `${mb}M`);
    return `mem ${f(rss)}/${f(avg)}`;
  }

  /** `/subagents` lists each child's memory too: now, the average it is charged for, its peak. */
  const showSubagents = () => {
    const views = syncSubagents();
    const text = views.length
      ? [
          `${views.length} subagent${views.length === 1 ? "" : "s"} (open one with /resume, they are saved as sessions):`,
          ...views.map(
            (v) =>
              `  ${v.name.padEnd(16)} ${(v.exitStatus && v.state !== "running" ? `${v.state} ${v.exitStatus}` : v.state).padEnd(20)} ${String(v.steps).padStart(4)} steps  $${v.cost.toFixed(3)}  ${v.memAvg ? `${memLine(v.memRss, v.memAvg)}  ` : ""}${v.state === "running" ? v.lastCommand : v.task}`.slice(0, 190),
          ),
        ].join("\n")
      : "no subagents yet: the agent starts them with `mini-agent-rs agent spawn` (Rust agent only)";
    itemAppendHint.current = true;
    setEvents((prev) => [...prev, { type: "notice", text, interruptType: "subagents" }]);
  };

  /** Drop the transcript and whatever runs (a local run is stopped); model and settings stay. */
  const clearTranscript = (keep: RunEvent[] = []) => {
    latestSave.current(); // flush the throttled save
    live.current.watch?.stop();
    live.current.run?.kill();
    live.current = {};
    exitedRef.current = true;
    interruptedRef.current = false;
    sessionIdRef.current = null;
    messagesRef.current = [];
    pendingTasksRef.current = [];
    consumedRef.current = 0;
    parseStateRef.current = createParseState();
    setTurnStartedAt(0);
    followRef.current = true;
    historyRef.current.reset();
    togglesRef.current.clear();
    itemAppendHint.current = false;
    setEvents(keep);
    setInfo({ cost: 0, apiCalls: 0 });
    setStatus("idle");
    setCompacting(null);
    setFocusIdx(0);
    setFlipped(new Set());
    setAnchor(null);
  };

  /** `/new`: stop whatever runs and start a blank session (model and settings stay). */
  const newSession = () => {
    clearTranscript();
    setOverlay("none");
    setInputFocused(true);
  };

  /** A notice line of mini-tui's own (`queue`/`workspace` notes never change the run status). */
  const addNote = (text: string, interruptType: string) => {
    const event: RunEvent = { type: "notice", text, interruptType };
    if (serverChatRef.current) notesRef.current.push(event);
    itemAppendHint.current = true;
    setEvents((prev) => [...prev, event]);
  };

  // ------------------------------------------------------------ chat modes
  // dispatcher: the transcript is a session the web server runs (the main chat, or a task's
  // worker), followed over its socket; prompts go to the queue. manual: local sessions in `cwd`.
  const chatMode = chatModeOf(settings);
  const queueCapable = Boolean(props.queue) && !staticMode && !props.viewPath && !props.runSpec;
  const dispatcher = chatMode === "dispatcher" && queueCapable;
  const dispatcherRef = useRef(dispatcher);
  dispatcherRef.current = dispatcher;
  /**
   * Manual mode on a saved workspace of a remote host: the web server runs its sessions (it owns
   * the SSH runs), so the transcript is a server session, followed like the dispatcher's.
   */
  const [remoteWs, setRemoteWsRaw] = useState<SavedWorkspace | null>(null);
  const remoteWsRef = useRef<SavedWorkspace | null>(null);
  const setRemoteWs = (value: SavedWorkspace | null) => {
    remoteWsRef.current = value;
    setRemoteWsRaw(value);
  };
  /** That workspace's session on the server ("" = none yet: the next prompt creates it). */
  const [remoteSession, setRemoteSessionRaw] = useState("");
  const remoteSessionRef = useRef("");
  const setRemoteSession = (value: string) => {
    remoteSessionRef.current = value;
    setRemoteSessionRaw(value);
  };
  const remoteWorkspace = dispatcher ? null : remoteWs;
  /** The transcript is a session the web server runs (dispatcher, or a remote workspace). */
  const serverChat = dispatcher || Boolean(remoteWorkspace);
  const serverChatRef = useRef(serverChat);
  serverChatRef.current = serverChat;
  /** Saved hosts' labels by id (`GET /api/hosts`); a host the server did not name shows its id. */
  const [hostLabels, setHostLabels] = useState<Record<string, string>>({});
  const hostLabel = (hostId?: string) => (hostId ? hostLabels[hostId] || hostId : "");
  const loadHostLabels = () => {
    const client = queueClient();
    if (!client) return;
    void client.hosts().then((hosts) => {
      if (!hosts.length) return;
      setHostLabels(Object.fromEntries(hosts.map((h) => [h.id, h.label || h.host || h.id])));
    });
  };
  const queueClientRef = useRef<QueueClientLike | null>(null);
  const queueClient = (): QueueClientLike | null => {
    if (!queueClientRef.current && props.queue) queueClientRef.current = typeof props.queue === "function" ? props.queue() : props.queue;
    return queueClientRef.current;
  };
  const [queueState, setQueueStateRaw] = useState<QueueState>(EMPTY_QUEUE);
  const queueStateRef = useRef<QueueState>(EMPTY_QUEUE);
  const setQueueState = (value: QueueState) => {
    queueStateRef.current = value;
    setQueueStateRaw(value);
  };
  const [queueLink, setQueueLinkRaw] = useState<"off" | "connecting" | "live" | "polling" | "error">("off");
  const queueLinkRef = useRef(queueLink);
  const setQueueLink = (value: typeof queueLink) => {
    queueLinkRef.current = value;
    setQueueLinkRaw(value);
  };
  /** The task whose worker session the transcript shows ("" = the main chat). */
  const [viewTask, setViewTaskRaw] = useState("");
  const viewTaskRef = useRef("");
  const setViewTask = (value: string) => {
    viewTaskRef.current = value;
    setViewTaskRaw(value);
  };
  /** mini-tui's own notes in a followed session: kept across the server's snapshots. */
  const mainNotesRef = useRef<RunEvent[]>(dispatcher ? events.filter((event) => event.type === "notice") : []);
  const notesRef = useRef<RunEvent[]>(mainNotesRef.current);
  const followed = useRef<{ id: string; gone: boolean } | null>(null);
  /** Bumped to follow the same session again (it was closed on the server and came back). */
  const [followNonce, setFollowNonce] = useState(0);
  const remoteRunning = useRef(false);
  const viewed = viewTask ? queueState.tasks.find((task) => task.id === viewTask) : undefined;
  const followId = dispatcher ? (viewTask ? viewed?.sessionId ?? "" : queueState.main) : remoteWorkspace ? remoteSession : "";

  const reloadSettings = () => {
    const next = loadSettings();
    if (sameSettings(next, settingsRef.current)) return;
    settingsRef.current = next;
    setSettings(next);
    applyTheme(next.theme ?? DEFAULT_THEME);
  };

  // The settings file is shared with the web app: a change made there (the chat mode, the
  // theme) reaches this terminal without a restart.
  useEffect(() => {
    if (!persist || staticMode) return;
    const file = settingsFilePath();
    if (!file) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let watcher: FSWatcher | undefined;
    try {
      watcher = watch(dirname(file), (_event, name) => {
        if (name && name !== basename(file)) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(reloadSettings, 150);
      });
    } catch {
      return; // no settings folder yet: the file is read again at the next launch
    }
    return () => {
      if (timer) clearTimeout(timer);
      watcher?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Switching the mode starts over in the other one (a local run in flight is stopped).
  const modeSeen = useRef(dispatcher);
  useEffect(() => {
    if (modeSeen.current === dispatcher) return;
    modeSeen.current = dispatcher;
    mainNotesRef.current = [];
    notesRef.current = mainNotesRef.current;
    setViewTask("");
    setRemoteWs(null);
    setRemoteSession("");
    const note: RunEvent = dispatcher
      ? { type: "notice", text: "main chat: dispatcher · each request becomes queued tasks (/tasks lists them)", interruptType: "queue" }
      : { type: "notice", text: "main chat: manual · sessions start in the current folder (/workspaces switches it)", interruptType: "workspace" };
    if (dispatcher) notesRef.current.push(note);
    clearTranscript([note]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatcher]);

  // Dispatcher: reach the queue (the server is started when none runs) and keep its list live.
  useEffect(() => {
    if (!dispatcher) return;
    const client = queueClient();
    if (!client) return;
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    setQueueLink("connecting");
    client
      .connect()
      .then((result) => {
        if (cancelled) return;
        if (result.started) {
          addNote(
            `started a web server for the work queue at ${result.url}${result.logPath ? ` (log ${shortPath(result.logPath)})` : ""}; it stops with mini-tui and the queue resumes on the next server`,
            "queue",
          );
        }
        setQueueState(client.state());
        setQueueLink("live");
        unsubscribe = client.subscribe({
          onQueue: (state) => setQueueState(state),
          onLink: (up) => setQueueLink(up ? "live" : "polling"),
          onSession: (meta) => {
            const current = followed.current;
            if (current?.gone && meta.id === current.id) setFollowNonce((n) => n + 1);
          },
          onSettings: () => reloadSettings(),
        });
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setQueueLink("error");
        addNote(`dispatcher: ${error.message}. Start the web server (bun run web:serve), or switch the main chat to manual in /settings.`, "queue");
      });
    return () => {
      cancelled = true;
      unsubscribe?.();
      setQueueLink("off");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatcher]);

  // A remote workspace: reach the web server (started when none runs), which runs its sessions.
  const remoteKey = remoteWorkspace?.id ?? "";
  useEffect(() => {
    if (!remoteKey) return;
    const client = queueClient();
    if (!client) return;
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    const host = hostLabel(remoteWsRef.current?.hostId);
    setQueueLink("connecting");
    client
      .connect()
      .then((result) => {
        if (cancelled) return;
        if (result.started) {
          addNote(`started a web server for the remote workspace at ${result.url}${result.logPath ? ` (log ${shortPath(result.logPath)})` : ""}; it stops with mini-tui`, "workspace");
        }
        setQueueLink("live");
        loadHostLabels();
        unsubscribe = client.subscribe({
          onQueue: () => undefined,
          onLink: (up) => setQueueLink(up ? "live" : "polling"),
          onSession: (meta) => {
            const current = followed.current;
            if (current?.gone && meta.id === current.id) setFollowNonce((n) => n + 1);
          },
          onSettings: () => reloadSettings(),
        });
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setQueueLink("error");
        addNote(`remote workspace: ${error.message}. Sessions on ${host} run through the web server: start it (bun run web:serve), or pick a local workspace.`, "workspace");
      });
    return () => {
      cancelled = true;
      unsubscribe?.();
      // the dispatcher may own the link by now (the mode switched): leave its state alone
      if (!dispatcherRef.current) setQueueLink("off");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteKey]);

  useEffect(() => () => queueClientRef.current?.stop(), []);

  const remoteStatus = (meta: SessionMetaView) => {
    setInfo((previous) => {
      const next = { ...previous, model: meta.model || previous.model, cost: meta.cost ?? previous.cost, apiCalls: meta.apiCalls ?? previous.apiCalls };
      return sameRunInfo(previous, next) ? previous : next;
    });
    if (!meta.status) return;
    if (meta.status === "running") {
      if (!remoteRunning.current) setTurnStartedAt(meta.startedAt || Date.now());
      remoteRunning.current = true;
      setStatus("running");
      return;
    }
    remoteRunning.current = false;
    setStatus(meta.status === "error" ? "error" : meta.status === "interrupted" ? "interrupted" : meta.status === "idle" ? "idle" : "done");
  };

  // Dispatcher: follow the session the transcript shows (the main chat or the opened task).
  const followSeen = useRef("|");
  useEffect(() => {
    if (!serverChat) return;
    const client = queueClient();
    if (!client) return;
    const viewKey = `${viewTask}|${followId}`;
    if (followSeen.current !== viewKey) {
      followSeen.current = viewKey;
      notesRef.current = viewTask ? [] : mainNotesRef.current;
      const task = viewTask ? queueStateRef.current.tasks.find((t) => t.id === viewTask) : undefined;
      if (task) {
        notesRef.current = [
          { type: "notice", text: `task ${task.id} · ${oneLine(task.title, 80)} · ${task.status}${task.workspace ? ` · ◆ ${task.workspace}` : ""} — prompts here redirect it · Esc Esc or /main back to the main chat`, interruptType: "queue" },
        ];
        if (!task.sessionId) {
          notesRef.current.push({ type: "notice", text: `${task.id} has no worker session yet (${task.status}): it starts when a slot frees`, interruptType: "queue" });
        }
      }
      clearTranscript([...(task && !task.sessionId && task.prompt ? [{ type: "task" as const, text: task.prompt }] : []), ...notesRef.current]);
      remoteRunning.current = false;
    }
    if (!followId) return;
    const entry = { id: followId, gone: false };
    followed.current = entry;
    const stop = client.follow(followId, {
      onSnapshot: (session) => {
        if (followed.current !== entry) return;
        itemAppendHint.current = false;
        setEvents([...cleanQueueEvents(session.events), ...notesRef.current]);
        remoteStatus(session);
      },
      onDelta: (fresh, meta) => {
        if (followed.current !== entry) return;
        const shown = cleanQueueEvents(fresh);
        if (shown.length) {
          itemAppendHint.current = true;
          setEvents((prev) => [...prev, ...shown]);
        }
        remoteStatus(meta);
      },
      onGone: () => {
        if (followed.current !== entry) return;
        entry.gone = true;
        remoteRunning.current = false;
        setStatus((current) => (current === "running" ? "done" : current));
      },
    });
    return () => {
      stop();
      if (followed.current === entry) followed.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatcher, serverChat, viewTask, followId, followNonce]);

  /** A prompt in dispatcher mode: to the queue's chat, or a redirect of the opened task. */
  const sendToQueue = (task: string, attachments?: AttachmentRef[]) => {
    const client = queueClient();
    if (!client) return;
    if (queueLinkRef.current === "connecting" || queueLinkRef.current === "error") {
      addNote(queueLinkRef.current === "connecting" ? "still reaching the work queue: send it again in a moment" : "the work queue is not reachable (see above): nothing was sent", "queue");
      return;
    }
    const taskId = viewTaskRef.current;
    if (taskId) {
      addNote(`→ redirect ${taskId}: ${oneLine(task, 160)}`, "queue");
      void client
        .redirect(taskId, task)
        .then((result) => addNote(result.ok ? result.text || `${taskId} redirected` : `redirect refused: ${result.text || result.error || "the server said no"}`, "queue"))
        .catch((error: Error) => addNote(`redirect failed: ${error.message}`, "queue"));
      return;
    }
    remoteRunning.current = true;
    setStatus("running");
    setTurnStartedAt(Date.now());
    void client
      .prompt(task, modelOverride, attachments)
      .then(({ id }) => {
        const current = followed.current;
        if (id && current?.id === id && current.gone) setFollowNonce((n) => n + 1);
      })
      .catch((error: Error) => {
        remoteRunning.current = false;
        setStatus("error");
        addNote(`the dispatcher did not take the message: ${error.message}`, "queue");
      });
  };

  const newQueueChat = () => {
    const client = queueClient();
    setOverlay("none");
    setInputFocused(true);
    if (!client) return;
    setViewTask("");
    mainNotesRef.current.length = 0;
    void client
      .newChat()
      .then(() => addNote("new main chat · the queue and its tasks stay", "queue"))
      .catch((error: Error) => addNote(`could not start a new chat: ${error.message}`, "queue"));
  };

  const backToMain = () => {
    if (!viewTaskRef.current) return;
    setViewTask("");
    setInputFocused(true);
  };

  /** The server is reachable for a send (otherwise a note says why and nothing goes out). */
  const serverReady = (): boolean => {
    const link = queueLinkRef.current;
    if (link !== "connecting" && link !== "error") return true;
    const what = dispatcherRef.current ? "the work queue" : "the web server";
    addNote(link === "connecting" ? `still reaching ${what}: send it again in a moment` : `${what} is not reachable (see above): nothing was sent`, dispatcherRef.current ? "queue" : "workspace");
    return false;
  };

  /**
   * A prompt in a remote workspace: the first one creates the session on the server (on the
   * workspace's host and folder), later ones continue it. The raw prompt goes up: the server
   * expands `$skills` itself, and its transcript then shows the prompt as typed.
   */
  const sendToRemote = (prompt: string, attachments?: AttachmentRef[]) => {
    const client = queueClient();
    const ws = remoteWsRef.current;
    if (!client || !ws) return;
    if (!serverReady()) return;
    remoteRunning.current = true;
    setStatus("running");
    setTurnStartedAt(Date.now());
    const id = remoteSessionRef.current;
    const sent = id
      ? client.send(id, prompt, attachments).then(() => id)
      : client
          .createSession({ prompt, cwd: ws.path, model: modelOverride, target: "remote", hostId: ws.hostId, attachments })
          .then((session) => {
            if (remoteWsRef.current === ws && !remoteSessionRef.current) setRemoteSession(session.id);
            return session.id;
          });
    void sent
      .then((sessionId) => {
        const current = followed.current;
        if (current?.id === sessionId && current.gone) setFollowNonce((n) => n + 1);
      })
      .catch((error: Error) => {
        remoteRunning.current = false;
        setStatus("error");
        addNote(`${hostLabel(ws.hostId)} did not take the message: ${error.message}`, "workspace");
      });
  };

  /** `/new` in a remote workspace: the next prompt starts another session there. */
  const newRemoteSession = () => {
    const ws = remoteWsRef.current;
    setOverlay("none");
    setInputFocused(true);
    if (!ws) return;
    const note: RunEvent = { type: "notice", text: `new session on ${hostLabel(ws.hostId)} · ${ws.path} — the next prompt starts it`, interruptType: "workspace" };
    mainNotesRef.current = [note];
    notesRef.current = mainNotesRef.current;
    remoteRunning.current = false;
    setRemoteSession("");
    clearTranscript([note]);
  };

  // ---- /attach
  const [staged, setStagedRaw] = useState<StagedAttachment[]>([]);
  const stagedRef = useRef<StagedAttachment[]>([]);
  const setStaged = (value: StagedAttachment[]) => {
    stagedRef.current = value;
    setStagedRaw(value);
  };
  /** Files of the staged list going up right now (a second send waits for them). */
  const [uploading, setUploadingRaw] = useState(false);
  const uploadingRef = useRef(false);
  const setUploading = (value: boolean) => {
    uploadingRef.current = value;
    setUploadingRaw(value);
  };
  /** Matches of the last Tab completion in `/attach` (the strip above the prompt shows them). */
  const [attachHint, setAttachHint] = useState("");

  const attachCommand = (args: string) => {
    const words = parseAttachArgs(args);
    if (!words.length) {
      const files = stagedRef.current;
      return addNote(
        files.length
          ? `attached: ${files.map((f, i) => `${i + 1}. ${shortPath(f.path)} (${humanSize(f.size)})`).join(" · ")} — sent with the next prompt · /detach [n] removes`
          : "/attach <file> [more files] stages files for the next prompt (Tab completes paths) · /detach removes them",
        "attach",
      );
    }
    if (words.length === 1 && words[0]!.toLowerCase() === "clear") return detachCommand("");
    const next = [...stagedRef.current];
    const refused: string[] = [];
    for (const word of words) {
      try {
        const file = stageFile(word, cwdRef.current);
        if (next.some((f) => f.path === file.path)) continue;
        if (next.length >= MAX_STAGED) {
          refused.push(`${file.name}: at most ${MAX_STAGED} files per prompt`);
          continue;
        }
        next.push(file);
      } catch (error) {
        refused.push((error as Error).message);
      }
    }
    setStaged(next);
    setAttachHint("");
    if (refused.length) addNote(`not attached: ${refused.join(" · ")}`, "attach");
  };

  const detachCommand = (args: string) => {
    const files = stagedRef.current;
    const which = args.trim();
    if (!which || which.toLowerCase() === "all") {
      setStaged([]);
      return addNote(files.length ? `removed ${files.length} attachment${files.length === 1 ? "" : "s"}` : "nothing is attached", "attach");
    }
    const n = Number(which);
    const at = Number.isInteger(n) && n >= 1 ? n - 1 : files.findIndex((f) => f.name === which || f.path === which);
    if (at < 0 || at >= files.length) return addNote(`no attachment ${which} (${files.length ? `1-${files.length}` : "none attached"})`, "attach");
    setStaged(files.filter((_, i) => i !== at));
  };

  /** Tab in `/attach …`: complete the last path (files and folders, relative to the session folder). */
  const completeAttachPath = (text: string) => {
    const match = /^(.*?)((?:\\.|[^\s\\])*)$/s.exec(text);
    const head = match?.[1] ?? text;
    const token = (match?.[2] ?? "").replace(/\\(.)/g, "$1");
    if (!ATTACH_ARGS.test(head)) return; // still on the command word itself
    const done = completePath(token, { base: cwdRef.current, files: true });
    const next = head + escapeAttachPath(done.text);
    if (next !== text) editPrompt(next, next.length);
    setAttachHint(done.matches.length ? done.matches.slice(0, 16).join("  ") + (done.matches.length > 16 ? "  …" : "") : "");
  };

  /** Upload the staged files to the server, in order; the refs go with the prompt. */
  const uploadStaged = async (client: QueueClientLike, files: StagedAttachment[]): Promise<AttachmentRef[]> => {
    const refs: AttachmentRef[] = [];
    for (const file of files) {
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(readFileSync(file.path));
      } catch (error) {
        throw new Error(`${file.name}: cannot be read (${(error as Error).message})`);
      }
      refs.push(await client.upload({ name: file.name, bytes }));
    }
    return refs;
  };

  /**
   * Send with the staged files through the server: upload them, then hand the refs to `deliver`.
   * A refused upload keeps both the files and the prompt (back in the box) for another try.
   */
  const sendWithUploads = (prompt: string, deliver: (refs: AttachmentRef[]) => void) => {
    const client = queueClient();
    const files = stagedRef.current;
    if (!client) return;
    const keep = () => applyPromptText(prompt);
    if (uploadingRef.current) {
      keep();
      return addNote("still uploading the attachments: send it again in a moment", "attach");
    }
    if (!serverReady()) return keep();
    setUploading(true);
    void uploadStaged(client, files)
      .then((refs) => {
        setUploading(false);
        // a /detach while the files went up wins: only what is still staged is sent
        const still = new Set(stagedRef.current.map((f) => f.path));
        setStaged([]);
        deliver(refs.filter((_, i) => still.has(files[i]!.path)));
      })
      .catch((error: Error) => {
        setUploading(false);
        keep();
        addNote(`attachments not sent: ${error.message} · the prompt is back in the box and the files stay attached (/detach removes one)`, "attach");
      });
  };

  // ---- /tasks
  const [tasksUi, setTasksUiRaw] = useState<{ filter: TaskFilter; index: number; confirm: string | null; note?: string }>({ filter: "all", index: 0, confirm: null });
  const tasksUiRef = useRef(tasksUi);
  const setTasksUi = (value: typeof tasksUi) => {
    tasksUiRef.current = value;
    setTasksUiRaw(value);
  };
  const openTasks = () => {
    if (!dispatcherRef.current) {
      addNote("the task list belongs to the dispatcher chat mode (/settings → main chat)", "workspace");
      return;
    }
    setTasksUi({ filter: tasksUiRef.current.filter, index: 0, confirm: null });
    setOverlay("tasks");
  };
  const openTask = (taskId: string) => {
    setOverlay("none");
    setViewTask(taskId);
    setInputFocused(true);
  };
  const tasksKey = (key: { name: string; sequence?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }) => {
    const ui = tasksUiRef.current;
    const rows = visibleTasks(queueStateRef.current.tasks, ui.filter);
    const index = Math.min(ui.index, Math.max(rows.length - 1, 0));
    const isEnter = key.name === "return" || key.name === "enter" || key.name === "kpenter";
    if (ui.confirm) {
      if (key.name === "y" || isEnter) {
        const id = ui.confirm;
        setTasksUi({ ...ui, confirm: null, note: `cancelling ${id}…` });
        void queueClient()
          ?.cancel(id)
          .then((result) => setTasksUi({ ...tasksUiRef.current, note: result.ok ? result.text || `${id} cancelled` : `could not cancel ${id}: ${result.text || result.error || "refused"}` }))
          .catch((error: Error) => setTasksUi({ ...tasksUiRef.current, note: `could not cancel ${id}: ${error.message}` }));
      } else if (key.name === "n" || key.name === "escape") setTasksUi({ ...ui, confirm: null, note: undefined });
      return;
    }
    if (key.name === "escape" || (key.ctrl && key.name === "t")) {
      setOverlay("none");
      setInputFocused(true);
      return;
    }
    if (key.name === "up" || key.name === "k") return setTasksUi({ ...ui, index: Math.max(0, index - 1), note: undefined });
    if (key.name === "down" || key.name === "j") return setTasksUi({ ...ui, index: Math.min(Math.max(rows.length - 1, 0), index + 1), note: undefined });
    if (key.name === "pageup") return setTasksUi({ ...ui, index: Math.max(0, index - 10) });
    if (key.name === "pagedown") return setTasksUi({ ...ui, index: Math.min(Math.max(rows.length - 1, 0), index + 10) });
    if (key.name === "home") return setTasksUi({ ...ui, index: 0 });
    if (key.name === "end") return setTasksUi({ ...ui, index: Math.max(rows.length - 1, 0) });
    if (key.name === "tab" || key.name === "f") {
      const at = TASK_FILTERS.indexOf(ui.filter);
      const next = TASK_FILTERS[(at + (key.shift ? TASK_FILTERS.length - 1 : 1)) % TASK_FILTERS.length]!;
      return setTasksUi({ filter: next, index: 0, confirm: null });
    }
    if (key.sequence && /^[1-6]$/.test(key.sequence) && !key.ctrl && !key.meta) {
      return setTasksUi({ filter: TASK_FILTERS[Number(key.sequence) - 1]!, index: 0, confirm: null });
    }
    const row = rows[index];
    if (!row) return;
    if (isEnter || key.name === "right") return openTask(row.id);
    if (key.name === "c" || key.name === "delete") {
      if (row.status !== "queued" && row.status !== "running") return setTasksUi({ ...ui, note: `${row.id} is ${row.status}: only queued or running tasks can be cancelled` });
      return setTasksUi({ ...ui, confirm: row.id, note: undefined });
    }
  };

  // ---- /workspaces (manual mode)
  const [workspacesVersion, setWorkspacesVersion] = useState(0);
  const workspaceLabel = useMemo(() => {
    if (dispatcher) return undefined;
    try {
      return workspaceForCwd(listWorkspaces(), cwd)?.name;
    } catch {
      return undefined;
    }
  }, [cwd, dispatcher, workspacesVersion]);
  const [wsRows, setWsRowsRaw] = useState<WorkspaceRow[]>([]);
  const wsRowsRef = useRef<WorkspaceRow[]>([]);
  const [wsStep, setWsStepRaw] = useState<WorkspaceStep>({ kind: "list", index: 0 });
  const wsStepRef = useRef<WorkspaceStep>({ kind: "list", index: 0 });
  const setWsStep = (value: WorkspaceStep) => {
    wsStepRef.current = value;
    setWsStepRaw(value);
  };
  const reloadWorkspaces = (): WorkspaceRow[] => {
    let list: SavedWorkspace[] = [];
    try {
      list = listWorkspaces();
    } catch {
      list = [];
    }
    const sessionsIn = (path: string) => {
      try {
        return countSessions(db(), path, "");
      } catch {
        return 0;
      }
    };
    const rows = [...list.filter((w) => !w.hostId), ...list.filter((w) => w.hostId)].map((workspace) => ({
      workspace,
      path: workspace.hostId ? workspace.path : shortPath(workspace.path),
      sessions: workspace.hostId ? 0 : sessionsIn(workspace.path),
      remote: Boolean(workspace.hostId),
    }));
    wsRowsRef.current = rows;
    setWsRowsRaw(rows);
    setWorkspacesVersion((v) => v + 1);
    return rows;
  };
  const openWorkspaces = () => {
    if (dispatcherRef.current) {
      addNote("workspaces belong to the manual chat mode: the dispatcher picks each task's folder (/settings → main chat)", "queue");
      return;
    }
    const rows = reloadWorkspaces();
    const remoteHere = remoteWsRef.current?.id;
    const here = rows.findIndex((row) => (remoteHere ? row.workspace.id === remoteHere : !row.remote && row.workspace.path === cwdRef.current));
    setWsStep({ kind: "list", index: Math.max(0, here) });
    setOverlay("workspaces");
    if (rows.some((row) => row.remote)) loadHostLabels();
  };
  const switchWorkspace = (workspace: SavedWorkspace) => {
    clearTranscript([{ type: "notice", text: `workspace ${workspace.name} · ${shortPath(workspace.path)} — new sessions start here (/resume lists its sessions)`, interruptType: "workspace" }]);
    setCwd(workspace.path);
    if (remoteWsRef.current) {
      setRemoteWs(null);
      setRemoteSession("");
    }
    setOverlay("none");
    setInputFocused(true);
  };
  /** A workspace on a remote host: its sessions run on the web server (local runs stop here). */
  const switchRemoteWorkspace = (workspace: SavedWorkspace) => {
    const host = hostLabel(workspace.hostId);
    const note: RunEvent = { type: "notice", text: `workspace ${workspace.name} · ${host}:${workspace.path} — sessions run on ${host} through the web server (/new starts another · Esc Esc interrupts)`, interruptType: "workspace" };
    mainNotesRef.current = [note];
    notesRef.current = mainNotesRef.current;
    remoteRunning.current = false;
    setRemoteSession("");
    setRemoteWs(workspace);
    clearTranscript([note]);
    setOverlay("none");
    setInputFocused(true);
  };
  /** Enter (or a click) on a workspace row. */
  const pickWorkspace = (row: WorkspaceRow): string | undefined => {
    if (row.remote) {
      if (!queueCapable) return `${row.workspace.name} is on a remote host: its sessions run through the web server, which this terminal does not reach here (open it in the web app)`;
      switchRemoteWorkspace(row.workspace);
      return undefined;
    }
    if (!existsSync(row.workspace.path)) return `${row.path} no longer exists`;
    switchWorkspace(row.workspace);
    return undefined;
  };
  const workspacesKey = (key: { name: string; sequence?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }) => {
    const step = wsStepRef.current;
    const rows = wsRowsRef.current;
    const isEnter = key.name === "return" || key.name === "enter" || key.name === "kpenter";
    const typed = !key.ctrl && !key.meta && key.sequence && key.sequence >= " " ? key.sequence : "";
    const paste = (key.ctrl && key.name === "v") || (key.shift && key.name === "insert");
    if (step.kind === "list") {
      const index = Math.min(step.index, Math.max(rows.length - 1, 0));
      const row = rows[index];
      if (key.name === "escape" || (key.ctrl && key.name === "t")) {
        setOverlay("none");
        setInputFocused(true);
        return;
      }
      if (key.name === "up" || key.name === "k") return setWsStep({ kind: "list", index: Math.max(0, index - 1) });
      if (key.name === "down" || key.name === "j") return setWsStep({ kind: "list", index: Math.min(Math.max(rows.length - 1, 0), index + 1) });
      if (key.name === "n" || key.name === "a") return setWsStep({ kind: "add", field: "path", path: "~/", name: "" });
      if (key.name === "s") {
        try {
          const saved = addWorkspace({ path: cwdRef.current });
          const next = reloadWorkspaces();
          return setWsStep({ kind: "list", index: Math.max(0, next.findIndex((r) => r.workspace.id === saved.id)), note: `saved ${saved.name} (${shortPath(saved.path)})` });
        } catch (error) {
          return setWsStep({ ...step, note: (error as Error).message });
        }
      }
      if (!row) return;
      if (isEnter) {
        const refused = pickWorkspace(row);
        if (refused) setWsStep({ ...step, note: refused });
        return;
      }
      if (key.name === "r") return setWsStep({ kind: "rename", id: row.workspace.id, value: row.workspace.name });
      if (key.name === "d" || key.name === "delete") return setWsStep({ kind: "remove", id: row.workspace.id });
      return;
    }
    if (step.kind === "remove") {
      if (key.name === "y" || isEnter) {
        const gone = rows.find((r) => r.workspace.id === step.id);
        removeWorkspace(step.id);
        const next = reloadWorkspaces();
        return setWsStep({ kind: "list", index: Math.min(Math.max(0, rows.findIndex((r) => r.workspace.id === step.id)), Math.max(next.length - 1, 0)), note: `removed ${gone?.workspace.name ?? "the workspace"} (its sessions stay)` });
      }
      if (key.name === "n" || key.name === "escape") return setWsStep({ kind: "list", index: Math.max(0, rows.findIndex((r) => r.workspace.id === step.id)) });
      return;
    }
    if (step.kind === "rename") {
      const at = Math.max(0, rows.findIndex((r) => r.workspace.id === step.id));
      if (key.name === "escape") return setWsStep({ kind: "list", index: at });
      if (key.name === "backspace") return setWsStep({ ...step, value: step.value.slice(0, -1), error: undefined });
      if (paste) return setWsStep({ ...step, value: step.value + pastedLine(readClipboard()), error: undefined });
      if (isEnter) {
        try {
          const renamed = renameWorkspace(step.id, step.value);
          reloadWorkspaces();
          return setWsStep({ kind: "list", index: at, note: `renamed to ${renamed.name}` });
        } catch (error) {
          return setWsStep({ ...step, error: (error as Error).message });
        }
      }
      if (typed) return setWsStep({ ...step, value: step.value + typed, error: undefined });
      return;
    }
    // add: the folder, then an optional name
    const field = step.field;
    const value = field === "path" ? step.path : step.name;
    const set = (next: string) => setWsStep({ ...step, [field]: next, error: undefined, hint: undefined });
    if (key.name === "escape") return setWsStep({ kind: "list", index: 0 });
    if (key.name === "tab") {
      if (field === "name") return setWsStep({ ...step, field: "path" });
      const done = completeFolder(step.path);
      return setWsStep({ ...step, path: done.text, error: undefined, hint: done.matches.length ? done.matches.slice(0, 12).join("  ") + (done.matches.length > 12 ? "  …" : "") : undefined });
    }
    if (key.name === "backspace") return set(value.slice(0, -1));
    if (paste) return set(value + pastedLine(readClipboard()));
    if (isEnter) {
      if (field === "path") {
        const path = expandHome(step.path);
        let isDir = false;
        try {
          isDir = statSync(path).isDirectory();
        } catch {
          isDir = false;
        }
        if (!isDir) return setWsStep({ ...step, error: `${shortPath(path)} is not a folder on this machine` });
        return setWsStep({ ...step, field: "name", hint: undefined, error: undefined });
      }
      try {
        const added = addWorkspace({ path: step.path, name: step.name });
        const next = reloadWorkspaces();
        return setWsStep({ kind: "list", index: Math.max(0, next.findIndex((r) => r.workspace.id === added.id)), note: `added ${added.name} · Enter switches to it` });
      } catch (error) {
        return setWsStep({ ...step, error: (error as Error).message });
      }
    }
    const chunk = pastedSequence(key) || typed;
    if (chunk) return set(value + chunk.replace(/[\r\n]+/g, ""));
  };
  const applyModel = (model: string) => {
    setOverlay("none");
    setModelOverride(model);
    const liveRun = live.current.run;
    liveRun?.switchModel(model);
    const remoteId = !dispatcherRef.current && remoteWsRef.current ? remoteSessionRef.current : "";
    if (remoteId) void queueClient()?.setModel(remoteId, model).catch((error: Error) => addNote(`the remote session kept its model: ${error.message}`, "model"));
    // Fresh launches start on this model; open TUIs read the file only at startup.
    if (persist) saveLastModel(model);
    const id = sessionIdRef.current;
    if (persist && id) {
      try {
        db().query("UPDATE sessions SET model = ?, updated_at = ? WHERE id = ?").run(model, Date.now(), id);
      } catch {
        // persistence is best-effort
      }
    }
    itemAppendHint.current = true;
    setEvents((prev) => [
      ...prev,
      {
        type: "notice",
        text: dispatcherRef.current ? `model → ${model} (the dispatcher's next turn and the tasks it creates from now on)` : remoteWsRef.current ? `model → ${model} (${remoteId ? "the remote session's next turn" : "the next remote session"})` : liveRun && !exitedRef.current ? `model → ${model} (from next step)` : `model → ${model} (next run)`,
        interruptType: "model",
      },
    ]);
    setInputFocused(true);
  };

  const changeSettings = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    applyTheme(next.theme ?? DEFAULT_THEME);
    if (props.persistSettings !== false) saveSettings(next);
  };

  const doneSettings = () => {
    setOverlay("none");
    setInputFocused(true);
  };

  /** `/compact`: summarize the conversation now. A live run gets `COMPACT` on its control
   * channel; otherwise a resumed run compacts the saved history and waits for the next prompt. */
  const compactNow = () => {
    if (serverChatRef.current) {
      const id = followed.current?.id;
      if (!id) return addNote("nothing to compact yet", "queue");
      setCompacting("manual");
      void queueClient()
        ?.compact(id)
        .catch((error: Error) => {
          setCompacting(null);
          addNote(`could not compact: ${error.message}`, "queue");
        });
      return;
    }
    const liveRun = live.current.run;
    itemAppendHint.current = true;
    if (liveRun && !exitedRef.current) {
      liveRun.requestCompact();
      setCompacting("manual");
      return;
    }
    const history = messagesRef.current;
    if (!sessionIdRef.current || history.length < 3) {
      setEvents((prev) => [...prev, { type: "notice", text: "nothing to compact yet", interruptType: "context" }]);
      return;
    }
    if (!props.onSend && !runnerSupportsCompactOnly()) {
      setEvents((prev) => [...prev, { type: "notice", text: "/compact between runs needs the integrated runner (pip install -e ./agent); it still works while a run is live", interruptType: "context" }]);
      return;
    }
    if (props.onSend) {
      props.onSend("/compact"); // tests observe the command
      return;
    }
    let resumePath: string | undefined;
    try {
      resumePath = writeResumeFile(sessionIdRef.current, history);
    } catch {
      resumePath = undefined;
    }
    if (!resumePath) return;
    setCompacting("manual");
    startRun({ task: "", compactOnly: true, model: modelOverride, cwd: cwdRef.current, resumePath });
    compactOnlyRef.current = true;
  };

  const send = (text: string) => {
    const trimmed = text.trim();
    setPromptText("");
    setPaletteDismissed(false);
    setPaletteIdx(0);
    if (attachHint) setAttachHint("");
    if (!trimmed) return;
    historyRef.current.push(trimmed);
    const command = trimmed.replace(/^\//, "").toLowerCase();
    // Only the slash form: "attach the logs to the report" is a prompt, not a command.
    const attach = /^\/(attach|detach)(?:\s+([\s\S]*))?$/i.exec(trimmed);
    if (attach) return attach[1]!.toLowerCase() === "attach" ? attachCommand(attach[2] ?? "") : detachCommand(attach[2] ?? "");
    if (command === "model") return setOverlay("model");
    if (command === "settings" || command === "config") {
      setSettingsGroup(0);
      return setOverlay("settings");
    }
    if (command === "help" || command === "h") return setOverlay("help");
    if (command === "resume" || command === "sessions") {
      if (dispatcherRef.current) return addNote("/resume lists this folder's own sessions: open a worker's session with /tasks, or switch the main chat to manual in /settings", "queue");
      if (remoteWsRef.current) return addNote("/resume lists this machine's sessions: the remote workspace's earlier sessions open in the web app (/new starts another here)", "workspace");
      return setOverlay("resume");
    }
    if (command === "tasks" || command === "queue") return openTasks();
    if (command === "workspaces" || command === "workspace" || command === "ws") return openWorkspaces();
    if (command === "main" || command === "chat") {
      if (!dispatcherRef.current) return addNote("/main returns to the dispatcher chat (dispatcher mode only)", "workspace");
      return backToMain();
    }
    if (command === "connect") {
      setConnectStep({ kind: "provider", index: 0, query: "" });
      return setOverlay("connect");
    }
    if (command === "mcp") {
      reloadMcp();
      setMcpStep({ kind: "list", index: 0 });
      return setOverlay("mcp");
    }
    if (command === "quit" || command === "exit" || command === "q") return quit();
    if (command === "new" || command === "clear") return dispatcherRef.current ? newQueueChat() : remoteWsRef.current ? newRemoteSession() : newSession();
    if (command.startsWith("model ")) {
      const model = trimmed.replace(/^\//, "").slice("model ".length).trim();
      if (model) return applyModel(model);
      return;
    }
    if (command === "compact") return compactNow();
    if (command === "subagents" || command === "agents") return showSubagents();
    // `$skill` anywhere: mini gets each referenced skill's SKILL.md ahead of the prompt.
    const expanded = expandSkills(trimmed, skillsDir);
    if (expanded.missing.length && !expanded.used.length && /^\$/.test(trimmed)) {
      applyPromptText(trimmed); // keep the prompt so a typo is one edit away
      itemAppendHint.current = true;
      setEvents((prev) => [...prev, { type: "notice", text: `no skill named $${expanded.missing[0]} in ${shortPath(skillsDir)}` }]);
      return;
    }
    if (expanded.missing.length && expanded.used.length) {
      itemAppendHint.current = true;
      setEvents((prev) => [...prev, { type: "notice", text: `unknown skill${expanded.missing.length > 1 ? "s" : ""} sent as plain text: ${expanded.missing.map((n) => `$${n}`).join(", ")}` }]);
    }
    const files = stagedRef.current;
    if (dispatcherRef.current || remoteWsRef.current) {
      const deliver = (refs?: AttachmentRef[]) => (dispatcherRef.current ? sendToQueue(expanded.task, refs) : sendToRemote(trimmed, refs));
      if (!files.length) return deliver();
      if (dispatcherRef.current && viewTaskRef.current) {
        applyPromptText(trimmed);
        return addNote("a redirect carries text only: /main sends the files with a prompt to the main chat (/detach drops them)", "queue");
      }
      return sendWithUploads(trimmed, deliver);
    }
    // A local agent runs on this machine: the prompt names the files and it reads them in place.
    const task = files.length ? `${expanded.task}\n\n${localAttachmentText(files)}` : expanded.task;
    if (files.length) setStaged([]);
    echoTask(task);
    if (props.onSend) {
      props.onSend(task);
      return;
    }
    const liveRun = live.current.run;
    if (liveRun && !exitedRef.current) {
      liveRun.sendUserMessage(task);
      compactOnlyRef.current = false;
      setStatus("running"); // e.g. the first prompt after a `/compact` between runs
      setTurnStartedAt(Date.now()); // a new turn: the working timer starts over
      return;
    }
    if (!sessionIdRef.current) {
      const id = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      sessionIdRef.current = id;
      const model = modelOverride ?? DEFAULT_MODEL;
      if (persist) {
        try {
          createSession(db(), { id, cwd: cwdRef.current, model, task: trimmed });
          generateTitle(trimmed, model, (title) => {
            try {
              db().query("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?").run(title, Date.now(), id);
            } catch {
              // persistence is best-effort
            }
          });
        } catch {
          // persistence is best-effort
        }
      }
    }
    // Follow-ups after the first prompt (or after /resume) continue the same
    // conversation: the raw history goes to `mini --resume` as context.
    let resumePath: string | undefined;
    const history = messagesRef.current;
    if (sessionIdRef.current && history.length > 0) {
      try {
        resumePath = writeResumeFile(sessionIdRef.current, history);
      } catch {
        resumePath = undefined;
      }
    }
    startRun({ task, model: modelOverride, cwd: cwdRef.current, resumePath });
  };


  // Follow-the-bottom when the transcript grows (OpenTUI's sticky scroll blanks out
  // for short content, so it only turns on when content exceeds the viewport).
  // `followRef` detaches the auto-follow once the user scrolls up.
  useEffect(() => {
    const timer = setTimeout(() => {
      const scroll = scrollRef.current;
      if (!scroll) return;
      try {
        // `+ 1`: an empty (or exactly-fitting) content box measures one row taller than the
        // viewport without being scrollable — that slack must not count as overflow.
        const tall = (scroll.content?.height ?? 0) > (scroll.viewport?.height ?? 1) + 1;
        scroll.stickyScroll = tall;
        // Manual visibility (the auto one flashes at startup: the scrollbar paints before the
        // first layout settles) — show the thumb exactly when the thread overflows the view.
        scroll.verticalScrollBar.visible = tall;
        if (tall && followRef.current) scroll.scrollBy(1_000_000);
      } catch {
        // renderable torn down between render and this check
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [events, dims.height, dims.width]);

  // Sliding window over the transcript: only the viewport budget is mounted at a time
  // (native text buffers make each mounted item cost ~1 MB). By default it follows the live
  // tail; `g` pins the top (`anchor`) to page older items in, `G` releases it.
  const itemCacheRef = useRef<ItemBuildCache | undefined>(undefined);
  const allItems = useMemo(() => {
    const appendOnly = itemAppendHint.current;
    itemAppendHint.current = false;
    itemCacheRef.current = buildItemsIncremental(events, itemCacheRef.current, appendOnly);
    return itemCacheRef.current.items;
  }, [events]);
  const mountedItems = mountedItemLimit(dims.height);
  const tailStart = Math.max(0, allItems.length - mountedItems);
  const start = Math.min(anchor ?? tailStart, tailStart);
  const items = allItems.slice(start, start + mountedItems);
  const pairItems = items.filter((item): item is Extract<Item, { kind: "pair" }> => item.kind === "pair");
  const pairRank = new Map(pairItems.map((p, i) => [p.toolIndex, i] as const));

  const quit = () => {
    latestSave.current(); // the throttled save may be pending: flush before leaving
    queueClientRef.current?.stop(); // a queue server this terminal started stops with it
    live.current.watch?.stop();
    live.current.run?.kill(); // quitting interrupts any run in flight
    if (props.onQuit) props.onQuit();
    else process.exit(0);
  };

  /**
   * Esc: double press interrupts the run in flight; single press toggles prompt/navigation.
   *
   * The first press of a double already toggled focus (it cannot know a second is coming), so the
   * second puts focus back where it was before the pair. Without that, every interrupt from the prompt
   * left the TUI in navigation mode, where ↑/↓ scroll the transcript instead of recalling prompts.
   */
  const escapePress = () => {
    const now = Date.now();
    if (now - lastEscAt.current < ESC_DOUBLE_MS) {
      lastEscAt.current = 0; // a third press starts a new pair instead of interrupting again
      setInputFocused(focusBeforeEsc.current);
      return interruptRun();
    }
    lastEscAt.current = now;
    focusBeforeEsc.current = inputRefocus.current;
    return setInputFocused(!inputRefocus.current);
  };

  /** ctrl+c: the first press clears the prompt; a second one within the window closes. */
  const ctrlCPress = () => {
    const now = Date.now();
    if (now - lastCtrlCAt.current < CTRL_C_DOUBLE_MS) return quit();
    lastCtrlCAt.current = now;
    // read the buffer itself: promptRef syncs a tick after each key, so a ctrl+c that
    // lands right behind fast typing would otherwise see an empty prompt
    let text = promptRef.current;
    try {
      text = textareaRef.current?.editorView.getText() ?? text;
    } catch {
      // renderer torn down
    }
    if (text) applyPromptText("");
    setCloseArmed(true);
    setTimeout(() => setCloseArmed(false), CTRL_C_DOUBLE_MS);
  };

  // Mouse-highlight any text in the UI to copy it (clipboard works inside tmux too).
  useSelectionHandler((selection) => {
    const text = selection.getSelectedText();
    if (!text) return;
    if (copyTimer.current) clearTimeout(copyTimer.current);
    // copy once the selection settles (mouse released / drag paused)
    copyTimer.current = setTimeout(() => {
      if (props.onCopy) props.onCopy(text);
      else copyText(text);
    }, 350);
  });

  /** What ctrl+v/shift+insert read (tests override via `onPasteText`). */
  const readClipboard = () => (props.onPasteText ?? pasteText)();
  // ---------------------------------------------------------------- /mcp
  // The login countdown ticks only while a login is on screen.
  useEffect(() => {
    if (mcpStep?.kind !== "login") return;
    const timer = setInterval(() => setMcpNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [mcpStep?.kind]);
  // Tokens are refreshed in the background, so a long session's runs keep a valid one.
  useEffect(() => {
    if (props.persistSettings !== false) mcp.ensureTokenRefresher();
  }, []);
  /** Follow a login in the background: the panel moves on by itself when the browser comes back. */
  const watchLogin = (login: mcp.LoginView) => {
    mcpLoginUnsub.current?.();
    setMcpStep({ kind: "login", login });
    mcpLoginUnsub.current = mcp.subscribeLogin(login.id, (view) => {
      const step = mcpRef.current;
      if (step?.kind !== "login" || step.login.id !== view.id) return;
      if (view.status === "done") {
        reloadMcp();
        setMcpStep({ kind: "done", name: view.serverName, tools: view.toolCount ?? 0 });
      } else if (view.status === "error") {
        if (view.error !== "cancelled") setMcpStep({ kind: "error", message: view.error ?? "the login failed", serverId: view.serverId });
      } else setMcpStep({ ...step, login: view });
    });
  };

  const mcpLogin = (serverId: string) => {
    const step = mcpRef.current;
    setMcpStep(step?.kind === "list" ? { ...step, busy: "starting the login…", note: undefined } : { kind: "list", index: 0, busy: "starting the login…" });
    mcp.markOAuth(serverId, mcpFile);
    void mcp
      .startLogin({ serverId, loopback: true, path: mcpFile })
      .then((login) => {
        if (overlayRef.current !== "mcp") return mcp.cancelLogin(login.id);
        watchLogin(login);
      })
      .catch((error: Error) => overlayRef.current === "mcp" && setMcpStep({ kind: "error", message: error.message, serverId }));
  };

  /** Enter on a server: log in when it needs it, otherwise prove it works. */
  const mcpActivate = (server: mcp.McpServerView) => {
    if (server.state === "needs-login" || server.state === "expired") return mcpLogin(server.id);
    const step = mcpRef.current;
    if (step?.kind !== "list") return;
    setMcpStep({ ...step, busy: `testing ${server.name}…`, note: undefined });
    void mcp.probeStored(server.id, mcpFile).then((result) => {
      const now = mcpRef.current;
      if (now?.kind !== "list") return;
      if (result.needsAuth) {
        mcp.markOAuth(server.id, mcpFile);
        reloadMcp();
        return mcpLogin(server.id);
      }
      setMcpStep({ ...now, busy: undefined, note: result.ok ? `✓ ${server.name}: ${result.tools?.length ?? 0} tools` : `✗ ${server.name}: ${result.error}` });
    });
  };

  const mcpInstall = (input: mcp.AddInput) => {
    let record: mcp.McpServerRecord;
    try {
      record = mcp.addServer(input, mcpFile);
    } catch (error) {
      const now = mcpRef.current;
      if (now?.kind === "url" || now?.kind === "client") setMcpStep({ ...now, error: (error as Error).message });
      else setMcpStep({ kind: "error", message: (error as Error).message });
      return;
    }
    const views = reloadMcp();
    setMcpStep({ kind: "list", index: Math.max(0, views.findIndex((v) => v.id === record.id)), busy: `connecting to ${record.name}…` });
    void mcp.probe(record).then((result) => {
      if (overlayRef.current !== "mcp") return;
      if (result.needsAuth) {
        mcp.markOAuth(record.id, mcpFile);
        reloadMcp();
        return mcpLogin(record.id);
      }
      const now = mcpRef.current;
      if (now?.kind === "list") setMcpStep({ ...now, busy: undefined, note: result.ok ? `✓ ${record.name}: ${result.tools?.length ?? 0} tools` : `✗ ${result.error}` });
    });
  };

  const mcpCopy = (text: string) => {
    if (props.onCopy) props.onCopy(text);
    else copyText(text);
  };

  const mcpKey = (key: { name: string; sequence?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }) => {
    const step = mcpRef.current;
    if (!step) return;
    const typed = !key.ctrl && !key.meta && key.sequence && key.sequence.length === 1 && key.sequence >= " " ? key.sequence : "";
    const isEnter = key.name === "return" || key.name === "enter" || key.name === "kpenter";
    const paste = (key.ctrl && key.name === "v") || (key.shift && key.name === "insert");
    const servers = mcpServersRef.current;

    if (step.kind === "list") {
      if (key.name === "escape") return setOverlay("none");
      const count = servers.length + 1;
      if (key.name === "up" || key.name === "k") return setMcpStep({ ...step, index: (step.index - 1 + count) % count });
      if (key.name === "down" || key.name === "j") return setMcpStep({ ...step, index: (step.index + 1) % count });
      const server = servers[step.index];
      if (key.name === "a" || (isEnter && !server)) return setMcpStep({ kind: "add", index: 0, query: "" });
      if (!server) return;
      if (isEnter) return mcpActivate(server);
      if (key.name === "d" || key.name === "delete") {
        mcp.removeServer(server.id, mcpFile);
        const views = reloadMcp();
        return setMcpStep({ kind: "list", index: Math.min(step.index, views.length), note: `removed ${server.name}` });
      }
      if (key.name === "l" && server.oauth) {
        mcp.logoutServer(server.id, mcpFile);
        reloadMcp();
        return setMcpStep({ ...step, note: `logged out of ${server.name}` });
      }
      if (key.name === "x") {
        mcp.setDisabled(server.id, !server.disabled, mcpFile);
        reloadMcp();
        return setMcpStep({ ...step, note: `${server.name} ${server.disabled ? "enabled" : "disabled"}` });
      }
      return;
    }

    if (step.kind === "add") {
      const rows = addRows(mcp.MCP_PRESETS, step.query, servers.map((s) => s.preset ?? ""));
      if (key.name === "escape") return setMcpStep({ kind: "list", index: 0 });
      if (key.name === "up") return setMcpStep({ ...step, index: Math.max(0, step.index - 1) });
      if (key.name === "down") return setMcpStep({ ...step, index: Math.min(rows.length - 1, step.index + 1) });
      if (key.name === "backspace") return setMcpStep({ ...step, query: step.query.slice(0, -1), index: 0 });
      if (isEnter || key.name === "tab") {
        const row = rows[Math.min(step.index, rows.length - 1)];
        if (row === "custom") return setMcpStep({ kind: "url", value: "" });
        if (row?.needsClient) return setMcpStep({ kind: "client", preset: row, field: "id", id: "", secret: "" });
        if (row) return mcpInstall({ preset: row.id });
        return;
      }
      if (typed) return setMcpStep({ ...step, query: step.query + typed, index: 0 });
      return;
    }

    if (step.kind === "url") {
      if (key.name === "escape") return setMcpStep({ kind: "add", index: 0, query: "" });
      if (key.name === "backspace") return setMcpStep({ ...step, value: step.value.slice(0, -1), error: undefined });
      if (paste) return setMcpStep({ ...step, value: step.value + pastedToken(readClipboard()), error: undefined });
      if (isEnter) return step.value.trim() ? mcpInstall({ url: step.value.trim() }) : undefined;
      const chunk = pastedSequence(key) || typed;
      if (chunk) return setMcpStep({ ...step, value: step.value + chunk.trim(), error: undefined });
      return;
    }

    if (step.kind === "client") {
      const field = step.field;
      const value = field === "id" ? step.id : step.secret;
      const set = (next: string) => setMcpStep({ ...step, [field]: next, error: undefined });
      if (key.name === "escape") return setMcpStep({ kind: "add", index: 0, query: "" });
      if (key.name === "tab" || key.name === "down" || key.name === "up") return setMcpStep({ ...step, field: field === "id" ? "secret" : "id" });
      if (key.name === "backspace") return set(value.slice(0, -1));
      if (paste) return set(value + pastedToken(readClipboard()));
      if (isEnter) {
        if (field === "id") return setMcpStep({ ...step, field: "secret" });
        if (!step.id.trim()) return setMcpStep({ ...step, field: "id", error: "the client id is required" });
        return mcpInstall({ preset: step.preset.id, clientId: step.id.trim(), clientSecret: step.secret.trim() });
      }
      const chunk = pastedSequence(key) || typed;
      if (chunk) return set(value + chunk.trim());
      return;
    }

    if (step.kind === "login") {
      if (step.pasting !== undefined) {
        // The redirect URL field: a browser elsewhere ends on a localhost page that cannot load.
        if (key.name === "escape") return setMcpStep({ ...step, pasting: undefined, pasteError: undefined });
        if (key.name === "backspace") return setMcpStep({ ...step, pasting: step.pasting.slice(0, -1), pasteError: undefined });
        if (paste) return setMcpStep({ ...step, pasting: step.pasting + pastedToken(readClipboard()), pasteError: undefined });
        if (isEnter) {
          const text = step.pasting;
          void mcp.completeFromPaste(step.login.id, text).catch((error: Error) => {
            const now = mcpRef.current;
            if (now?.kind === "login") setMcpStep({ ...now, pasteError: error.message });
          });
          return;
        }
        const chunk = pastedSequence(key) || typed;
        if (chunk) return setMcpStep({ ...step, pasting: step.pasting + chunk.trim(), pasteError: undefined });
        return;
      }
      if (key.name === "escape") {
        mcp.cancelLogin(step.login.id);
        return setMcpStep({ kind: "list", index: 0, note: "login cancelled" });
      }
      if (key.name === "c" || key.name === "y") {
        mcpCopy(step.login.url);
        return setMcpStep({ ...step, copied: true });
      }
      if (key.name === "o" || isEnter) {
        const opener = (props.onOpenUrl ?? openUrl)(step.login.url);
        if (!opener) mcpCopy(step.login.url);
        return setMcpStep({ ...step, opened: opener || undefined, copied: opener ? step.copied : true, pasteError: opener ? undefined : "no browser here: the link was copied, open it anywhere" });
      }
      if (key.name === "p") return setMcpStep({ ...step, pasting: "", pasteError: undefined });
      return;
    }

    if (step.kind === "error" && key.name === "r" && step.serverId) return mcpLogin(step.serverId);
    if (key.name === "escape" || isEnter) {
      reloadMcp();
      return setMcpStep({ kind: "list", index: 0 });
    }
  };

  /** The pasted text of a key event that carries some (non-bracketed paste fallback). */
  const pastedSequence = (key: { sequence?: string; ctrl?: boolean; meta?: boolean }) => {
    const ch = key.sequence ?? "";
    return ch && ch.length > 1 && !key.ctrl && !key.meta && ch >= " " ? ch : "";
  };

  // Bracketed pastes (the usual ctrl+shift+v / shift+insert in modern terminals) arrive as
  // PasteEvents. The wizard's and session browser's inputs are display-only, so wire them
  // by hand — the prompt textarea pastes natively and is left alone.
  usePaste((event) => {
    if (overlayRef.current === "mcp") {
      const step = mcpRef.current;
      const text = pastedToken(new TextDecoder().decode(event.bytes));
      if (!text || !step) return;
      event.preventDefault();
      event.stopPropagation();
      if (step.kind === "url") setMcpStep({ ...step, value: step.value + text, error: undefined });
      else if (step.kind === "client") setMcpStep({ ...step, [step.field]: (step.field === "id" ? step.id : step.secret) + text, error: undefined });
      else if (step.kind === "login") setMcpStep({ ...step, pasting: (step.pasting ?? "") + text, pasteError: undefined });
      else if (step.kind === "add") setMcpStep({ ...step, query: step.query + text, index: 0 });
      return;
    }
    if (overlayRef.current === "connect") {
      const step = connectRef.current;
      if (!step) return;
      const token = pastedToken(new TextDecoder().decode(event.bytes));
      if (!token) return;
      event.preventDefault();
      event.stopPropagation();
      if (step.kind === "key") setConnectStep({ ...step, value: step.value + token });
      else if (step.kind === "models" || step.kind === "provider")
        setConnectStep({ ...step, query: step.query + token, index: 0 });
      return;
    }
    if (overlayRef.current === "workspaces") {
      const step = wsStepRef.current;
      const line = pastedLine(new TextDecoder().decode(event.bytes));
      if (!line) return;
      event.preventDefault();
      event.stopPropagation();
      if (step.kind === "add") setWsStep({ ...step, [step.field]: (step.field === "path" ? step.path : step.name) + line, error: undefined });
      else if (step.kind === "rename") setWsStep({ ...step, value: step.value + line, error: undefined });
      return;
    }
    if (overlayRef.current === "resume") {
      const line = pastedLine(new TextDecoder().decode(event.bytes));
      if (!line) return;
      event.preventDefault();
      event.stopPropagation();
      setResumeQuery(resumeQueryRef.current + line);
    }
  });

  useKeyboard((key) => {
    if (overlayRef.current === "mcp") return mcpKey(key);
    if (overlayRef.current === "tasks") return tasksKey(key);
    if (overlayRef.current === "workspaces") return workspacesKey(key);
    if (overlayRef.current === "none" && key.ctrl && key.name === "t") {
      // the list of the current chat mode: the queue's tasks, or the saved workspaces
      return dispatcherRef.current ? openTasks() : openWorkspaces();
    }
    if (overlayRef.current === "connect") {
      // the BYOK wizard owns the keys (its inputs are display-only)
      const step = connectRef.current;
      if (!step) return;
      if (step.kind === "testing") return; // the connection test is in flight

      if (step.kind === "provider") {
        const filtered = filterProviders(PROVIDERS, step.query);
        if (key.name === "escape") return setOverlay("none");
        if (key.name === "up") return setConnectStep({ ...step, index: Math.max(0, step.index - 1) });
        if (key.name === "down")
          return setConnectStep({ ...step, index: Math.min(Math.max(filtered.length - 1, 0), step.index + 1) });
        if (key.name === "backspace") return setConnectStep({ ...step, query: step.query.slice(0, -1), index: 0 });
        if ((key.ctrl && key.name === "v") || (key.shift && key.name === "insert")) {
          const token = pastedToken(readClipboard());
          return token ? setConnectStep({ ...step, query: step.query + token, index: 0 }) : undefined;
        }
        if (key.name === "return" || key.name === "enter" || key.name === "tab" || key.name === "kpenter") {
          const def = filtered[Math.min(step.index, Math.max(filtered.length - 1, 0))];
          return def ? setConnectStep({ kind: "key", def, value: "" }) : undefined;
        }
        const paste = pastedSequence(key);
        if (paste) return setConnectStep({ ...step, query: step.query + paste, index: 0 });
        const ch = key.sequence;
        if (ch && ch.length === 1 && !key.ctrl && !key.meta && ch >= " ")
          return setConnectStep({ ...step, query: step.query + ch, index: 0 });
        return;
      }

      if (step.kind === "key") {
        if (key.name === "escape") return setConnectStep({ kind: "provider", index: 0, query: "" });
        if (key.name === "tab") return setConnectStep({ ...step, show: !step.show });
        if (key.name === "backspace") return setConnectStep({ ...step, value: step.value.slice(0, -1) });
        if ((key.ctrl && key.name === "v") || (key.shift && key.name === "insert")) {
          const token = pastedToken(readClipboard());
          return token ? setConnectStep({ ...step, value: step.value + token }) : undefined;
        }
        if (key.name === "return" || key.name === "enter") {
          if (!step.value.trim()) return;
          // load the provider catalog (static fallback when the request fails)
          setConnectStep({ kind: "models", def: step.def, key: step.value.trim(), models: step.def.staticModels, query: "", index: 0 });
          fetchProviderModels(step.def, step.value.trim())
            .then((ids) => {
              const merged = [...new Set([...ids, ...step.def.staticModels])];
              const current = connectRef.current;
              if (current?.kind === "models") {
                setConnectStep({ ...current, models: merged.length ? merged : step.def.staticModels });
              }
            })
            .catch(() => undefined);
          return;
        }
        const paste = pastedSequence(key);
        if (paste) return setConnectStep({ ...step, value: step.value + paste });
        const ch = key.sequence;
        if (ch && ch.length === 1 && !key.ctrl && !key.meta && ch >= " ") return setConnectStep({ ...step, value: step.value + ch });
        return;
      }

      if (step.kind === "models") {
        const filtered = filterModels(step.models, step.query);
        if (key.name === "escape") return setConnectStep({ kind: "key", def: step.def, value: step.key });
        if (key.name === "up") return setConnectStep({ ...step, index: Math.max(0, step.index - 1) });
        if (key.name === "down") return setConnectStep({ ...step, index: Math.min(Math.max(filtered.length - 1, 0), step.index + 1) });
        if (key.name === "backspace") return setConnectStep({ ...step, query: step.query.slice(0, -1), index: 0 });
        if ((key.ctrl && key.name === "v") || (key.shift && key.name === "insert")) {
          const token = pastedToken(readClipboard());
          return token ? setConnectStep({ ...step, query: step.query + token, index: 0 }) : undefined;
        }
        if (key.name === "return" || key.name === "enter" || key.name === "tab" || key.name === "kpenter") {
          const model = filtered[Math.min(step.index, Math.max(filtered.length - 1, 0))];
          if (!model) return;
          setConnectStep({ kind: "testing", def: step.def, key: step.key, model });
          const modelName = `${step.def.prefix}/${model}`;
          void (props.testModel ?? ((model, key) => testProviderModel(step.def, model, key)))(modelName, step.key).then(
            (ok) => {
              if (!ok) {
                setConnectStep({ ...step, error: `could not reach ${modelName} with that key` });
                return;
              }
              const full = step.models;
              const connection = {
                id: step.def.id,
                name: step.def.name,
                route: step.def.route,
                keyEnv: step.def.keyEnv,
                extraEnv: step.def.extraEnv,
                baseUrl: step.def.baseUrl,
                prefix: step.def.prefix,
                key: step.key,
                models: full,
                defaultModel: model,
                addedAt: Date.now(),
              };
              if (props.persistSettings !== false) saveConnection(connection);
              setConnections((prev) => [...prev.filter((c) => c.id !== connection.id), connection]);
              setConnectStep({ kind: "done", def: step.def, model, count: full.length });
            },
          );
          return;
        }
        const paste = pastedSequence(key);
        if (paste) return setConnectStep({ ...step, query: step.query + paste, index: 0 });
        const ch = key.sequence;
        if (ch && ch.length === 1 && !key.ctrl && !key.meta && ch >= " ")
          return setConnectStep({ ...step, query: step.query + ch, index: 0 });
        return;
      }

      // done / error screens
      if (key.name === "escape") return setOverlay("none");
      return;
    }

    if (overlayRef.current === "resume") {
      // the session browser owns the keys: its search box is display-only
      const rows = resumeRowsRef.current;
      const previewing = resumePreviewRef.current;
      if (previewing) {
        // read-only transcript: scroll it, go back to the list, or open the session
        const scroll = previewScrollRef.current;
        const page = Math.max(3, Math.floor(modalAreaHeight / 2));
        if (key.name === "escape" || key.name === "left" || key.name === "backspace") return setResumePreview(null);
        if (key.name === "return" || key.name === "enter" || key.name === "kpenter" || key.name === "tab")
          return openSession(previewing);
        if (key.name === "up" || key.name === "k") return scroll?.scrollBy(-1);
        if (key.name === "down" || key.name === "j") return scroll?.scrollBy(1);
        if (key.name === "pageup") return scroll?.scrollBy(-page);
        if (key.name === "pagedown" || key.name === "space") return scroll?.scrollBy(page);
        if (key.name === "home" || (key.name === "g" && !key.shift)) return scroll?.scrollTo(0);
        if (key.name === "end" || key.name === "G" || (key.name === "g" && key.shift)) return scroll?.scrollBy(1_000_000);
        return;
      }
      if (key.name === "escape") {
        setOverlay("none");
        setInputFocused(true);
        return;
      }
      if (key.name === "up") return setResumeIdx(Math.max(0, resumeIdxRef.current - 1));
      if (key.name === "down") return setResumeIdx(Math.min(Math.max(rows.length - 1, 0), resumeIdxRef.current + 1));
      if (key.name === "pageup") return setResumePage(Math.max(0, resumePageRef.current - 1));
      if (key.name === "pagedown") return setResumePage(resumePageRef.current + 1);
      if (key.name === "right") {
        const record = rows[Math.min(resumeIdxRef.current, Math.max(rows.length - 1, 0))];
        if (record) setResumePreview(record);
        return;
      }
      if (key.name === "return" || key.name === "enter" || key.name === "tab" || key.name === "kpenter") {
        const record = rows[Math.min(resumeIdxRef.current, Math.max(rows.length - 1, 0))];
        if (record) openSession(record);
        return;
      }
      if (key.name === "backspace") return setResumeQuery(resumeQueryRef.current.slice(0, -1));
      if ((key.ctrl && key.name === "v") || (key.shift && key.name === "insert")) {
        const line = pastedLine(readClipboard());
        return line ? setResumeQuery(resumeQueryRef.current + line) : undefined;
      }
      const paste = pastedSequence(key);
      if (paste) return setResumeQuery(resumeQueryRef.current + pastedLine(paste));
      const ch = key.sequence;
      if (ch && ch.length === 1 && !key.ctrl && !key.meta && ch >= " ")
        return setResumeQuery(resumeQueryRef.current + ch);
      return;
    }

    if (overlayRef.current === "settings") {
      if (key.name === "escape") {
        setOverlay("none");
        setInputFocused(true);
        return;
      }
      // Tab moves between the groups; the focused select owns the other keys. Group 2 (jev) is
      // its own panel that owns every key while it is open, so only Tab is routed to it here.
      if (key.name === "tab" || key.name === "left" || key.name === "right") {
        return setSettingsGroup((group) => (group + 1) % SETTINGS_GROUPS);
      }
      return;
    }

    if (overlayRef.current !== "none") {
      if (key.name === "escape") {
        setOverlay("none");
        setInputFocused(true);
      }
      return; // the overlay owns the other keys
    }

    if (inputRefocus.current) {
      if (key.ctrl && key.name === "c") return ctrlCPress();
      // `$good-code` + `,` → `$good-code,` (the space the completion added is dropped)
      const glued = skillSpaceAt.current;
      skillSpaceAt.current = -1;
      if (glued > 0 && key.sequence && /^[,.;:!?)\]}]$/.test(key.sequence) && !key.ctrl && !key.meta) {
        const text = promptRef.current;
        if (cursorOf(text) === glued && text[glued - 1] === " ") {
          key.preventDefault();
          return editPrompt(text.slice(0, glued - 1) + key.sequence + text.slice(glued), glued);
        }
      }
      if (key.name === "tab" && !key.ctrl && !key.meta && !key.shift) {
        // the buffer itself: promptRef syncs a tick after each key
        let text = promptRef.current;
        try {
          text = textareaRef.current?.editorView.getText() ?? text;
        } catch {
          // renderer torn down
        }
        if (ATTACH_ARGS.test(text)) {
          key.preventDefault();
          return completeAttachPath(text);
        }
      }

      if (!dismissedRef.current && isPaletteText(promptRef.current, cursorOf(promptRef.current))) {
        // `/` and `$` completion: App owns the keys while the popover is open
        const options = paletteFor(promptRef.current);
        if (options.length === 0) return;
        if (key.name === "escape") return escapePress();
        if (key.name === "up") return setPaletteIdx(Math.max(0, paletteIdxRef.current - 1));
        if (key.name === "down") return setPaletteIdx(Math.min(options.length - 1, paletteIdxRef.current + 1));
        if (key.name === "return" || key.name === "enter" || key.name === "tab" || key.name === "kpenter") {
          const option = options[Math.min(paletteIdxRef.current, options.length - 1)];
          if (option) completeOption(option);
          return;
        }
        // The panel keeps the textarea unfocused: edit the buffer at the cursor ourselves
        // (a `$skill` can sit in the middle of the phrase).
        const text = promptRef.current;
        const cursor = cursorOf(text);
        if (key.name === "backspace") {
          if (cursor === 0) return;
          return editPrompt(text.slice(0, cursor - 1) + text.slice(cursor), cursor - 1);
        }
        const ch = key.sequence;
        if (ch && ch.length === 1 && !key.ctrl && !key.meta && ch >= " ") return editPrompt(text.slice(0, cursor) + ch + text.slice(cursor), cursor + 1);
        return;
      }

      if (key.name === "escape") return escapePress();
      // ↑ on the first line / ↓ on the last line browse this session's sent prompts
      // (inside a multi-line prompt they keep moving the cursor between lines).
      if ((key.name === "up" || key.name === "down") && !key.ctrl && !key.meta && !key.shift) {
        const area = textareaRef.current;
        const row = area?.logicalCursor.row ?? 0;
        const lastRow = Math.max(0, (area?.lineCount ?? 1) - 1);
        const recalled =
          key.name === "up"
            ? row === 0
              ? historyRef.current.prev(promptRef.current)
              : null
            : row === lastRow
              ? historyRef.current.next()
              : null;
        if (recalled !== null) {
          key.preventDefault();
          applyPromptText(recalled);
          // a recalled `/cmd` or `$skill` must not open the palette (it would take over ↑/↓)
          if (isPaletteText(recalled)) setPaletteDismissed(true);
          return;
        }
      }
      // Keep the palette query in sync with the textarea (onContentChange is not
      // reliable across bindings, so re-read the buffer right after each key).
      setTimeout(() => {
        let text = "";
        try {
          text = textareaRef.current?.editorView.getText() ?? "";
        } catch {
          return; // renderer torn down between the key and the sync
        }
        syncPromptText(text);
      }, 0);
      return; // the prompt input owns the other keys
    }

    // normal mode: transcript navigation (in a worker's session Esc goes back to the main chat)
    if (key.name === "escape" && dispatcherRef.current && viewTaskRef.current) return backToMain();
    if (key.name === "escape") return escapePress();
    if (key.ctrl && key.name === "c") return ctrlCPress();
    if (key.name === "i" || key.name === "return" || key.name === "enter") return setInputFocused(true);
    if (key.name === "q") return quit();
    if (key.name === "e" && pairItems.length) {
      const target = pairItems[Math.min(Math.max(focusIdx, 0), pairItems.length - 1)]?.toolIndex;
      if (target !== undefined) {
        setFlipped((prev) => {
          const next = new Set(prev);
          if (next.has(target)) next.delete(target);
          else next.add(target);
          return next;
        });
      }
      return;
    }
    if (key.name === "j" || key.name === "down") return setFocusIdx((f) => Math.min(f + 1, Math.max(pairItems.length - 1, 0)));
    if (key.name === "k" || key.name === "up") return setFocusIdx((f) => Math.max(f - 1, 0));
    if (key.name === "pageup") {
      followRef.current = false;
      return scrollRef.current?.scrollBy(-scrollStep);
    }
    if (key.name === "pagedown") {
      followRef.current = true;
      return scrollRef.current?.scrollBy(scrollStep);
    }
    if (key.name === "g" && key.shift) {
      followRef.current = true;
      setAnchor(null);
      scrollRef.current?.scrollBy(1_000_000);
      // re-align once the window has re-rendered (its height may have changed)
      setTimeout(() => {
        try {
          scrollRef.current?.scrollBy(1_000_000);
        } catch {
          // renderable torn down between the key and the re-align
        }
      }, 0);
      return;
    }
    if (key.name === "g") {
      followRef.current = false;
      // page one window of older items in (the hint line says how much is left)
      setAnchor(Math.max(0, start - mountedItems));
      scrollRef.current?.scrollBy(-1_000_000);
      setTimeout(() => {
        try {
          scrollRef.current?.scrollBy(-1_000_000);
        } catch {
          // renderable torn down between the key and the re-align
        }
      }, 0);
      return;
    }
  });

  const focusedPair = Math.min(Math.max(focusIdx, 0), Math.max(pairItems.length - 1, 0));
  const displayStatus = props.statusOverride ?? deriveStatus(status, events);
  const busy = Boolean(live.current.run) && !exitedRef.current;
  const toggle = useCallback(
    (key: number) =>
      setFlipped((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
    [],
  );
  // Stable per-block closures: memoized cards must not see a new prop identity per render.
  const togglesRef = useRef(new Map<number, () => void>());
  const onToggleFor = (key: number) => {
    let fn = togglesRef.current.get(key);
    if (!fn) {
      fn = () => toggle(key);
      togglesRef.current.set(key, fn);
    }
    return fn;
  };

  // Compact bottom stack: prompt (grows with the text) · single status line, nothing below.
  const attachRows = attachmentsBarRows(staged, attachHint, uploading);
  const bottomRows = 2 + promptRows + 1 + attachRows;
  // PgUp/PgDn travel half a screen (at least 12 rows) — quick without being jumpy.
  const scrollStep = Math.max(12, Math.floor(dims.height / 2));
  const modalAreaHeight = Math.max(4, dims.height - bottomRows);

  const overlayNode =
    overlayState === "model" ? (
      <ModelPicker
        current={modelOverride ?? info.model ?? props.runSpec?.model ?? DEFAULT_MODEL}
        models={modelOptions}
        areaHeight={modalAreaHeight}
        onPick={applyModel}
        onCancel={() => setOverlay("none")}
      />
    ) : overlayState === "mcp" && mcpStep ? (
      <McpPanel step={mcpStep} servers={mcpServers} presets={mcp.MCP_PRESETS} areaHeight={modalAreaHeight} now={mcpNow} />
    ) : overlayState === "connect" && connectStep ? (
      <ConnectWizard step={connectStep} providers={PROVIDERS} areaHeight={modalAreaHeight} />
    ) : overlayState === "settings" ? (
      settingsGroup === JEV_GROUP ? (
        <JevSettings settings={settings} onChange={changeSettings} onDone={doneSettings} />
      ) : (
        <SettingsPanel settings={settings} group={settingsGroup} onChange={changeSettings} onDone={doneSettings} />
      )
    ) : overlayState === "tasks" ? (
      <TasksModal
        tasks={queueState.tasks}
        filter={tasksUi.filter}
        selectedIndex={tasksUi.index}
        confirmCancel={tasksUi.confirm}
        note={tasksUi.note}
        link={queueLink === "connecting" ? "connecting…" : queueLink === "error" ? "not reachable" : queueLink === "polling" ? "polling" : undefined}
        areaHeight={modalAreaHeight}
        onPick={(task) => openTask(task.id)}
      />
    ) : overlayState === "workspaces" ? (
      <WorkspacesModal
        rows={wsRows}
        step={wsStep}
        current={remoteWorkspace ? `${hostLabel(remoteWorkspace.hostId)}:${remoteWorkspace.path}` : shortPath(cwd)}
        currentId={remoteWorkspace ? remoteWorkspace.id : wsRows.find((row) => !row.remote && row.workspace.path === cwd)?.workspace.id}
        hostLabel={hostLabel}
        areaHeight={modalAreaHeight}
        onPick={(row) => {
          if (!row.remote) return switchWorkspace(row.workspace);
          const refused = pickWorkspace(row);
          if (refused) setWsStep({ kind: "list", index: Math.max(0, wsRowsRef.current.indexOf(row)), note: refused });
        }}
      />
    ) : overlayState === "help" ? (
      <HelpPanel />
    ) : overlayState === "resume" ? (
      <SessionModal
        sessions={resumeRows}
        query={resumeQuery}
        page={Math.min(resumePage, Math.max(0, resumePages - 1))}
        pages={resumePages}
        selectedIndex={Math.min(resumeIdx, Math.max(resumeRows.length - 1, 0))}
        onPick={openSession}
        previewing={resumePreview}
        onPreview={setResumePreview}
        areaHeight={modalAreaHeight}
        previewScrollRef={previewScrollRef}
      />
    ) : null;

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={colors.bg}>
      <scrollbox
          ref={scrollRef}
          stickyStart="bottom"
          scrollAcceleration={wheelAccel}
          verticalScrollbarOptions={{ visible: false }}
          width="100%"
          height={Math.max(6, dims.height - bottomRows - (paletteOpen ? Math.min(paletteOptions.length, PALETTE_ROWS) + 2 : 0))}
          contentOptions={CONTENT_OPTIONS}
        >
          {start > 0 ? (
            <text key="history-hint" fg={colors.faint}>
              ↑ {start} earlier entries hidden · press g to load more
            </text>
          ) : null}
          {items.map((item) => {
            if (item.kind === "event") {
              const event = events[item.index];
              if (!event) return null;
              if (event.type === "task") return <TaskCard key={item.index} text={event.text} />;
              if (event.type === "assistant") return <AssistantCard key={item.index} text={event.text} />;
              if (event.type === "notice")
                return <NoticeLine key={item.index} text={event.text} interruptType={event.interruptType} />;
              if (event.type === "error") return <ErrorBanner key={item.index} text={event.text} />;
              if (event.type === "thinking")
                return <ThinkingCard key={item.index} text={event.text} seconds={event.seconds} mode={settings.outputMode} />;
              // `Submitted` just repeats the final answer rendered above — show only real errors.
              if (event.type === "exit" && event.exitStatus !== "Submitted")
                return <ExitBanner key={item.index} exitStatus={event.exitStatus} submission={event.submission} />;
              if (event.type === "observation")
                return (
                  <StepCard
                    key={item.index}
                    returncode={event.returncode}
                    output={event.output}
                    exceptionInfo={event.exceptionInfo}
                    mode={settings.outputMode}
                    flipped={flipped.has(item.index)}
                    focused={false}
                    onToggle={onToggleFor(item.index)}
                  />
                );
              return null;
            }
            const tool = events[item.toolIndex];
            const obs = item.observationIndex !== null ? events[item.observationIndex] : null;
            const pairFocus = pairRank.get(item.toolIndex) ?? -1;
            return (
              <StepCard
                key={item.toolIndex}
                index={pairFocus + 1}
                name={tool?.type === "tool_call" ? tool.name : undefined}
                command={tool?.type === "tool_call" ? tool.command : undefined}
                returncode={obs?.type === "observation" ? obs.returncode : null}
                output={obs?.type === "observation" ? obs.output : ""}
                exceptionInfo={obs?.type === "observation" ? obs.exceptionInfo : ""}
                mode={settings.outputMode}
                flipped={flipped.has(item.toolIndex)}
                focused={pairFocus === focusedPair}
                onToggle={onToggleFor(item.toolIndex)}
              />
            );
          })}
          {compacting ? (
            <text fg={colors.accent}>Compacting... {compacting === "manual" ? "(summarizing the conversation)" : compacting === "overflow" ? "(the context overflowed)" : "(the context is almost full)"}</text>
          ) : displayStatus === "running" ? (
            <ThinkingCard text="" seconds={0} mode={settings.outputMode} live />
          ) : null}
        </scrollbox>
      {paletteOpen ? (
        <CommandPalette
          options={paletteOptions}
          selectedIndex={Math.min(paletteIdx, paletteOptions.length - 1)}
          onPick={completeOption}
        />
      ) : null}
      <AttachmentsBar files={staged} hint={attachHint} uploading={uploading} />
      <PromptBar
        focused={inputFocused && overlayState === "none" && !paletteOpen}
        busy={busy}
        closeArmed={closeArmed}
        rows={promptRows}
        textareaRef={textareaRef}
        onSend={send}
        onTextChange={syncPromptText}
        onWrapRows={setPromptWrapRows}
        placeholder={dispatcher ? (viewTask ? `redirect ${viewTask}: tell its worker what to change…` : "ask the dispatcher: each request becomes a background task…") : remoteWorkspace ? `runs on ${hostLabel(remoteWorkspace.hostId)} in ${remoteWorkspace.path} (through the web server)…` : undefined}
      />
      <StatusLine
        model={(modelOverride ?? info.model ?? props.runSpec?.model ?? DEFAULT_MODEL) || "default model"}
        path={remoteWorkspace ? `${hostLabel(remoteWorkspace.hostId)}:${remoteWorkspace.path}` : shortPath(cwd)}
        branch={remoteWorkspace ? null : branch}
        status={displayStatus}
        startedAt={turnStartedAt}
        compacting={Boolean(compacting)}
        verifying={verifying}
        workspace={remoteWorkspace ? `${remoteWorkspace.name} @ ${hostLabel(remoteWorkspace.hostId)}` : workspaceLabel}
        view={dispatcher ? (viewTask ? `task ${viewTask}${viewed ? ` · ${oneLine(viewed.title, 28)} (${viewed.status})` : ""}` : "main chat") : undefined}
        queue={dispatcher ? (queueLink === "connecting" ? "queue: connecting…" : queueLink === "error" ? "queue offline" : queueBadge(queueState.tasks) || (queueLink === "polling" ? "queue: polling" : "")) : remoteWorkspace ? (queueLink === "connecting" ? "server: connecting…" : queueLink === "error" ? "server offline" : queueLink === "polling" ? "server: polling" : undefined) : undefined}
      />
      {overlayNode ? <Modal areaHeight={modalAreaHeight}>{overlayNode}</Modal> : null}
    </box>
  );
}
