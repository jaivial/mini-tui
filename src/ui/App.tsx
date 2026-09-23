import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard, useSelectionHandler, useTerminalDimensions } from "@opentui/react";
import type { Database } from "bun:sqlite";
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";

import { colors, applyTheme, DEFAULT_THEME } from "./theme";
import { StatusLine } from "./components/StatusLine";
import { TaskCard } from "./components/TaskCard";
import { StepCard } from "./components/StepCard";
import { AssistantCard } from "./components/AssistantCard";
import { NoticeLine } from "./components/NoticeLine";
import { ExitBanner } from "./components/ExitBanner";
import { ErrorBanner } from "./components/ErrorBanner";
import { PromptBar } from "./components/PromptBar";
import { ModelPicker, MODELS } from "./components/ModelPicker";
import { SettingsPanel } from "./components/SettingsPanel";
import { HelpPanel } from "./components/HelpPanel";
import { Modal } from "./components/Modal";
import { SessionModal } from "./components/SessionModal";
import { CommandPalette, buildOptions, matchOptions, type CommandOption } from "./components/CommandPalette";
import { ConnectWizard } from "./components/ConnectWizard";
import type { ConnectStep } from "../connect";
import { filterModels } from "../connect";
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
import { messagesToEvents, parseInfo } from "../traj/parse";
import { slimMessage } from "../traj/slim";
import { readTrajectory, watchTrajectory, type WatchHandle } from "../traj/watch";
import { spawnMini, tailLog, type MiniRun, type TaskSpec } from "../mini/spawn";
import { DEFAULT_MODEL } from "../config";
import { copyText } from "../clipboard";
import { gitBranch, shortPath } from "../git";
import { WheelSpeed } from "../scroll";
import {
  DEFAULT_DB_PATH,
  PAGE_SIZE,
  countSessions,
  createSession,
  fallbackTitle,
  listSessions,
  openDb,
  saveTranscript,
  writeResumeFile,
  type SessionRecord,
} from "../sessions";
import { generateTitle } from "../title";
import { PromptHistory } from "../history";
import { SKILLS_DIR, expandSkillPrompt, listSkills, parseSkillPrompt } from "../skills";
import { loadSettings, saveSettings, type Settings } from "../settings";
import type { RunEvent, RunInfo, Trajectory, TrajectoryMessage } from "../traj/schema";

const COMMAND_OPTIONS = buildOptions(MODELS);
/** Prompts starting with these open the completion palette: `/` commands, `$` skills. */
const isPaletteText = (text: string) => text.startsWith("/") || text.startsWith("$");
const ESC_DOUBLE_MS = 800;
/** Window for the second ctrl+c that closes the TUI (the first one only clears the prompt). */
const CTRL_C_DOUBLE_MS = 1500;
/** Transcript saves while a run streams: at most one per this interval (plus one per turn). */
const SAVE_EVERY_MS = 30_000;
/** Quiet time before a save (batches the burst of snapshots a single step produces). */
const SAVE_SETTLE_MS = 1000;
/**
 * How many transcript items stay mounted at once. Each mounted item owns native text
 * buffers (~1 MB in practice: every rendered line is a full terminal-width row of
 * cells), so mounting a whole long run grows into the GBs. `g` pages older items in.
 */
const MOUNTED_ITEMS = 120;
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
  /** Skills folder for `$skill` prompts (tests); defaults to `~/.claude/skills`. */
  skillsDir?: string;
  /** Override clipboard writes (tests); defaults to OSC 52 + tmux buffer + native tools. */
  onCopy?: (text: string) => void;
  /** Observe double-Esc interrupts (tests). */
  onInterrupt?: () => void;
  /** Override the provider connection test (tests); defaults to a real one-token query. */
  testModel?: (modelName: string, key: string) => Promise<boolean>;
  onQuit?: () => void;
}

interface Pair {
  toolIndex: number;
  observationIndex: number | null;
}

type Item =
  | { kind: "event"; index: number }
  | { kind: "pair"; toolIndex: number; observationIndex: number | null };

/** Group each tool call with its observation (FIFO, `tool_call_id` preferred). */
/** Value-level message identity across re-parses (trajectory files are re-read whole). */
function sameMessage(a: TrajectoryMessage | undefined, b: TrajectoryMessage | undefined): boolean {
  return (
    Boolean(a && b) &&
    a?.role === b?.role &&
    String(a?.content ?? "") === String(b?.content ?? "") &&
    a?.tool_call_id === b?.tool_call_id
  );
}

export function buildItems(events: RunEvent[]): Item[] {
  const pairs: Pair[] = [];
  const freePairs: Pair[] = [];
  const byId = new Map<string, Pair[]>();

  events.forEach((event, index) => {
    if (event.type !== "tool_call") return;
    const pair: Pair = { toolIndex: index, observationIndex: null };
    pairs.push(pair);
    if (event.id) {
      const queue = byId.get(event.id);
      if (queue) queue.push(pair);
      else byId.set(event.id, [pair]);
    } else freePairs.push(pair);
  });

  events.forEach((event, index) => {
    if (event.type !== "observation") return;
    const queue = (event.toolCallId && byId.get(event.toolCallId)) || [];
    const pair = queue.shift() ?? freePairs.shift();
    if (queue.length === 0 && event.toolCallId) byId.delete(event.toolCallId);
    if (pair) pair.observationIndex = index;
  });

  const claimed = new Set(pairs.map((p) => p.observationIndex).filter((i): i is number => i !== null));
  const pairAt = new Map(pairs.map((p) => [p.toolIndex, p] as const));
  const items: Item[] = [];
  events.forEach((event, index) => {
    if (event.type === "tool_call") {
      const pair = pairAt.get(index);
      if (pair) items.push({ kind: "pair", toolIndex: pair.toolIndex, observationIndex: pair.observationIndex });
      return;
    }
    if (event.type === "observation" && claimed.has(index)) return;
    items.push({ kind: "event", index });
  });
  return items;
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
  const last = events[events.length - 1];
  if (last?.type === "exit") return !last.exitStatus || last.exitStatus === "Submitted" ? "done" : "error";
  if (last?.type === "error") return "error";
  return status;
}

export function App(props: AppProps) {
  const staticMode = Boolean(props.events);
  const [events, setEvents] = useState<RunEvent[]>(props.events ?? []);
  const [info, setInfo] = useState<RunInfo>(props.info ?? { cost: 0, apiCalls: 0 });
  const [status, setStatus] = useState<RunStatus>(
    props.statusOverride ?? (props.runSpec ? "running" : staticMode || props.viewPath ? "done" : "idle"),
  );
  const [focusIdx, setFocusIdx] = useState(0);
  const [flipped, setFlipped] = useState<Set<number>>(new Set());
  /** Top of the mounted transcript window when reading history (null = follow the live tail). */
  const [anchor, setAnchor] = useState<number | null>(null);
  const [modelOverride, setModelOverride] = useState<string | undefined>(undefined);
  const [settings, setSettings] = useState<Settings>(() => {
    const loaded = props.initialSettings ?? loadSettings();
    applyTheme(loaded.theme ?? DEFAULT_THEME);
    return loaded;
  });
  const [settingsGroup, setSettingsGroup] = useState(0);
  const [inputFocused, setInputFocusedState] = useState(true);
  const [overlayState, setOverlayState] = useState<"none" | "model" | "settings" | "help" | "resume" | "connect">("none");
  /** ctrl+c was pressed once: the prompt placeholder says a second press closes. */
  const [closeArmed, setCloseArmed] = useState(false);
  const [promptText, setPromptTextState] = useState("");
  const [paletteDismissed, setPaletteDismissedState] = useState(false);
  const [paletteIdx, setPaletteIdxState] = useState(0);
  const [resumeQuery, setResumeQueryState] = useState("");
  const [resumePage, setResumePageState] = useState(0);
  const [resumeIdx, setResumeIdxState] = useState(0);
  const [resumeRows, setResumeRows] = useState<SessionRecord[]>([]);
  const [resumePages, setResumePages] = useState(0);
  const [connectStep, setConnectStepState] = useState<ConnectStep | null>(null);
  const [connections, setConnections] = useState(() => loadConnections());
  // Key handlers can fire several times before React re-renders; mirror what they
  // read/write into refs so state is never stale inside a batch of keystrokes.
  const inputRefocus = useRef(true);
  const overlayRef = useRef<"none" | "model" | "settings" | "help" | "resume" | "connect">("none");
  const exitedRef = useRef(false);
  const interruptedRef = useRef(false);
  const promptRef = useRef("");
  const dismissedRef = useRef(false);
  const paletteIdxRef = useRef(0);
  const lastEscAt = useRef(0);
  const lastCtrlCAt = useRef(0);
  const historyRef = useRef(new PromptHistory());
  const followRef = useRef(true);
  /** Start of the current turn, as state so the status line restarts its timer. */
  const [turnStartedAt, setTurnStartedAt] = useState(0);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<TextareaRenderable | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const messagesRef = useRef<TrajectoryMessage[]>([]);
  const dbRef = useRef<Database | null>(null);
  const resumeQueryRef = useRef("");
  const resumePageRef = useRef(0);
  const resumeIdxRef = useRef(0);
  const resumeRowsRef = useRef<SessionRecord[]>([]);
  const connectRef = useRef<ConnectStep | null>(null);
  const commandOptionsRef = useRef<CommandOption[]>([]);
  const branch = useMemo(() => gitBranch(props.cwd), [props.cwd]);

  const setInputFocused = (value: boolean) => {
    inputRefocus.current = value;
    setInputFocusedState(value);
  };
  const setOverlay = (value: "none" | "model" | "settings" | "help" | "resume" | "connect") => {
    overlayRef.current = value;
    setOverlayState(value);
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
      })),
    [skillsDir],
  );
  const skillOptionsRef = useRef<CommandOption[]>([]);
  skillOptionsRef.current = skillOptions;
  /** Palette rows for the prompt text: commands after `/`, skills after `$`. */
  const paletteFor = (text: string): CommandOption[] =>
    text.startsWith("/")
      ? matchOptions(text, commandOptionsRef.current)
      : text.startsWith("$")
        ? matchOptions(text, skillOptionsRef.current)
        : [];

  const paletteOptions = !paletteDismissed ? paletteFor(promptText) : [];
  const paletteOpen = paletteOptions.length > 0 && inputFocused && overlayState === "none";
  // Soft-wrapped rows: long lines continue on the next row and grow the box (up to 8).
  const promptContentWidth = Math.max(12, dims.width - 4);
  const promptRows = Math.min(
    8,
    promptText.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil((line.length + 1) / promptContentWidth)), 0),
  );

  /** Replace the prompt buffer and park the cursor at its end (typing continues after it). */
  const writePrompt = (text: string) => {
    textareaRef.current?.setText(text);
    textareaRef.current?.gotoBufferEnd();
  };

  const applyPromptText = (text: string) => {
    writePrompt(text);
    setPromptText(text);
    if (!isPaletteText(text)) setPaletteDismissed(false);
    setPaletteIdx(0);
  };

  const completeOption = (option: CommandOption) => {
    writePrompt(option.insert);
    setPromptText(option.insert);
    setPaletteDismissed(true);
    setPaletteIdx(0);
    setInputFocused(true);
  };

  /** Messages are append-only per run: parse only what's new since the last snapshot. */
  const consumedRef = useRef(0);
  const applySnapshot = (traj: Trajectory) => {
    const messages = traj.messages ?? [];
    // Only continue incrementally when the file grew from what we already consumed —
    // a replaced file (e.g. `view --follow` on another run's output) restarts from zero.
    const from = consumedRef.current;
    const prev = messagesRef.current;
    const contiguous = from > 0 && messages.length >= from && sameMessage(prev[from - 1], messages[from - 1]);
    const startFrom = contiguous ? from : 0;
    const fresh = messagesToEvents(messages, { showSystem: props.showSystem }, startFrom);
    // Events are built: keep only the slim copy of the new messages (heavy extras dropped).
    const kept = startFrom === 0 ? [] : prev.slice(0, startFrom);
    for (let i = startFrom; i < messages.length; i++) kept.push(slimMessage(messages[i]!));
    messagesRef.current = kept;
    consumedRef.current = messages.length;
    setEvents((prevEvents) => (startFrom === 0 ? fresh : fresh.length ? [...prevEvents, ...fresh] : prevEvents));
    setInfo(parseInfo(traj));
  };

  useEffect(() => {
    if (staticMode) return;
    if (props.viewPath) {
      if (props.follow) {
        live.current.watch = watchTrajectory(props.viewPath, applySnapshot);
      } else {
        const traj = readTrajectory(props.viewPath);
        if (traj) applySnapshot(traj);
        else setEvents([{ type: "notice", text: `Could not read trajectory: ${props.viewPath}` }]);
      }
    } else if (props.runSpec) {
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
      const total = countSessions(db(), props.cwd, resumeQuery);
      const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      const page = Math.min(resumePage, pages - 1);
      const rows = listSessions(db(), props.cwd, resumeQuery, page);
      resumeRowsRef.current = rows;
      setResumeRows(rows);
      setResumePages(pages);
    } catch {
      resumeRowsRef.current = [];
      setResumeRows([]);
      setResumePages(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlayState, resumeQuery, resumePage]);

  const startRun = (spec: TaskSpec) => {
    setStatus("running");
    exitedRef.current = false;
    interruptedRef.current = false;
    setTurnStartedAt(Date.now());
    const run = spawnMini({
      ...spec,
      model: spec.model || modelOverride,
      env: modelEnv(spec.model || modelOverride || DEFAULT_MODEL, connections),
    });
    live.current = { run };
    consumedRef.current = 0; // fresh trajectory: events rebuild from its first message
    live.current.watch = watchTrajectory(run.session.trajPath, applySnapshot);
    run.exited.then((code) => {
      if (live.current.run !== run) return; // superseded (e.g. `/new`): don't touch the new session
      exitedRef.current = true;
      live.current.watch?.stop();
      const traj = readTrajectory(run.session.trajPath);
      if (traj) applySnapshot(traj);
      if (interruptedRef.current) {
        setStatus("interrupted"); // the user asked for this stop — not an error
      } else if (code === 0) {
        setStatus("done");
      } else {
        setStatus("error");
        // Post the raw log tail into the thread at the failure point: as a transcript item it
        // scrolls up with the conversation instead of sticking to the bottom of the chat.
        const tail = tailLog(run.session.logPath);
        if (tail) setEvents((prev) => [...prev, { type: "error", text: tail }]);
      }
    });
  };

  /** Double Esc: interrupt the run in flight (SIGINT through `MiniRun.interrupt`). */
  const interruptRun = () => {
    if (props.onInterrupt) props.onInterrupt();
    const run = live.current.run;
    if (!run || exitedRef.current) return;
    interruptedRef.current = true;
    run.interrupt();
  };

  const openSession = (record: SessionRecord) => {
    setOverlay("none");
    setResumeQuery("");
    sessionIdRef.current = record.id;
    try {
      const restoredEvents = JSON.parse(record.events_json) as RunEvent[];
      setEvents(restoredEvents);
      historyRef.current.reset(restoredEvents.flatMap((event) => (event.type === "task" ? [event.text] : [])));
      const restored = JSON.parse(record.info_json) as RunInfo;
      setInfo({ ...restored, cost: restored.cost ?? 0, apiCalls: restored.apiCalls ?? 0 });
      messagesRef.current = JSON.parse(record.messages_json) as TrajectoryMessage[];
      consumedRef.current = messagesRef.current.length;
    } catch {
      setEvents([{ type: "notice", text: "could not restore that session" }]);
    }
    setStatus("done");
    setInputFocused(true);
  };

  /** `/new`: stop whatever runs and start a blank session (model and settings stay). */
  const newSession = () => {
    latestSave.current(); // flush the throttled save
    live.current.watch?.stop();
    live.current.run?.kill();
    live.current = {};
    exitedRef.current = true;
    interruptedRef.current = false;
    sessionIdRef.current = null;
    messagesRef.current = [];
    consumedRef.current = 0;
    setTurnStartedAt(0);
    followRef.current = true;
    historyRef.current.reset();
    togglesRef.current.clear();
    setEvents([]);
    setInfo({ cost: 0, apiCalls: 0 });
    setStatus("idle");
    setFocusIdx(0);
    setFlipped(new Set());
    setAnchor(null);
    setOverlay("none");
    setInputFocused(true);
  };

  const applyModel = (model: string) => {
    setOverlay("none");
    setModelOverride(model);
    const liveRun = live.current.run;
    liveRun?.switchModel(model);
    const id = sessionIdRef.current;
    if (persist && id) {
      try {
        db().query("UPDATE sessions SET model = ?, updated_at = ? WHERE id = ?").run(model, Date.now(), id);
      } catch {
        // persistence is best-effort
      }
    }
    setEvents((prev) => [
      ...prev,
      {
        type: "notice",
        text: liveRun && !exitedRef.current ? `model → ${model} (from next step)` : `model → ${model} (next run)`,
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

  const send = (text: string) => {
    const trimmed = text.trim();
    setPromptText("");
    setPaletteDismissed(false);
    setPaletteIdx(0);
    if (!trimmed) return;
    historyRef.current.push(trimmed);
    const command = trimmed.replace(/^\//, "").toLowerCase();
    if (command === "model") return setOverlay("model");
    if (command === "settings" || command === "config") {
      setSettingsGroup(0);
      return setOverlay("settings");
    }
    if (command === "help" || command === "h") return setOverlay("help");
    if (command === "resume" || command === "sessions") return setOverlay("resume");
    if (command === "connect") {
      setConnectStep({ kind: "provider", index: 0 });
      return setOverlay("connect");
    }
    if (command === "quit" || command === "exit" || command === "q") return quit();
    if (command === "new" || command === "clear") return newSession();
    if (command.startsWith("model ")) {
      const model = trimmed.replace(/^\//, "").slice("model ".length).trim();
      if (model) return applyModel(model);
      return;
    }
    // `$skill request`: mini gets the skill's SKILL.md instructions ahead of the request.
    const skillCall = parseSkillPrompt(trimmed);
    const task = skillCall ? expandSkillPrompt(trimmed, skillsDir) : trimmed;
    if (task === null) {
      applyPromptText(trimmed); // keep the prompt so a typo is one edit away
      setEvents((prev) => [...prev, { type: "notice", text: `no skill named $${skillCall?.name} in ${shortPath(skillsDir)}` }]);
      return;
    }
    if (props.onSend) {
      props.onSend(task);
      return;
    }
    const liveRun = live.current.run;
    if (liveRun && !exitedRef.current) {
      liveRun.sendUserMessage(task);
      setTurnStartedAt(Date.now()); // a new turn: the working timer starts over
      return;
    }
    if (!sessionIdRef.current) {
      const id = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      sessionIdRef.current = id;
      const model = modelOverride ?? DEFAULT_MODEL;
      if (persist) {
        try {
          createSession(db(), { id, cwd: props.cwd, model, task: trimmed });
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
    startRun({ task, model: modelOverride, cwd: props.cwd, resumePath });
  };


  // Follow-the-bottom when the transcript grows (OpenTUI's sticky scroll blanks out
  // for short content, so it only turns on when content exceeds the viewport).
  // `followRef` detaches the auto-follow once the user scrolls up.
  useEffect(() => {
    const timer = setTimeout(() => {
      const scroll = scrollRef.current;
      if (!scroll) return;
      try {
        const tall = (scroll.content?.height ?? 0) > (scroll.viewport?.height ?? 1);
        scroll.stickyScroll = tall;
        if (tall && followRef.current) scroll.scrollBy(1_000_000);
      } catch {
        // renderable torn down between render and this check
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [events]);

  // Sliding window over the transcript: only `MOUNTED_ITEMS` items are mounted at a time
  // (native text buffers make each mounted item cost ~1 MB). By default it follows the live
  // tail; `g` pins the top (`anchor`) to page older items in, `G` releases it.
  const allItems = useMemo(() => buildItems(events), [events]);
  const tailStart = Math.max(0, allItems.length - MOUNTED_ITEMS);
  const start = Math.min(anchor ?? tailStart, tailStart);
  const items = allItems.slice(start, start + MOUNTED_ITEMS);
  const pairItems = items.filter((item): item is Extract<Item, { kind: "pair" }> => item.kind === "pair");
  const pairRank = new Map(pairItems.map((p, i) => [p.toolIndex, i] as const));

  const quit = () => {
    latestSave.current(); // the throttled save may be pending: flush before leaving
    live.current.watch?.stop();
    live.current.run?.kill(); // quitting interrupts any run in flight
    if (props.onQuit) props.onQuit();
    else process.exit(0);
  };

  /** Esc: double press interrupts the run in flight; single press toggles prompt/navigation. */
  const escapePress = () => {
    const now = Date.now();
    if (now - lastEscAt.current < ESC_DOUBLE_MS) return interruptRun();
    lastEscAt.current = now;
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

  useKeyboard((key) => {
    if (overlayRef.current === "connect") {
      // the BYOK wizard owns the keys (its inputs are display-only)
      const step = connectRef.current;
      if (!step) return;
      if (step.kind === "testing") return; // the connection test is in flight

      if (step.kind === "provider") {
        if (key.name === "escape") return setOverlay("none");
        if (key.name === "up") return setConnectStep({ ...step, index: Math.max(0, step.index - 1) });
        if (key.name === "down") return setConnectStep({ ...step, index: Math.min(PROVIDERS.length - 1, step.index + 1) });
        if (key.name === "return" || key.name === "enter" || key.name === "tab" || key.name === "kpenter") {
          return setConnectStep({ kind: "key", def: PROVIDERS[step.index], value: "" });
        }
        return;
      }

      if (step.kind === "key") {
        if (key.name === "escape") return setConnectStep({ kind: "provider", index: 0 });
        if (key.name === "backspace") return setConnectStep({ ...step, value: step.value.slice(0, -1) });
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
      if (key.name === "escape") {
        setOverlay("none");
        setInputFocused(true);
        return;
      }
      if (key.name === "up") return setResumeIdx(Math.max(0, resumeIdxRef.current - 1));
      if (key.name === "down") return setResumeIdx(Math.min(Math.max(rows.length - 1, 0), resumeIdxRef.current + 1));
      if (key.name === "pageup") return setResumePage(Math.max(0, resumePageRef.current - 1));
      if (key.name === "pagedown") return setResumePage(resumePageRef.current + 1);
      if (key.name === "return" || key.name === "enter" || key.name === "tab" || key.name === "kpenter") {
        const record = rows[Math.min(resumeIdxRef.current, Math.max(rows.length - 1, 0))];
        if (record) openSession(record);
        return;
      }
      if (key.name === "backspace") return setResumeQuery(resumeQueryRef.current.slice(0, -1));
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
      // Tab moves between the two groups; the focused select owns the other keys
      if (key.name === "tab" || key.name === "left" || key.name === "right") {
        return setSettingsGroup((group) => (group + 1) % 2);
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

      if (!dismissedRef.current && isPaletteText(promptRef.current)) {
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
        if (key.name === "backspace") return applyPromptText(promptRef.current.slice(0, -1));
        const ch = key.sequence;
        if (ch && ch.length === 1 && !key.ctrl && !key.meta && ch >= " ") return applyPromptText(promptRef.current + ch);
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
        setPromptText(text);
        if (!isPaletteText(text)) setPaletteDismissed(false);
        else if (text.length <= 1) {
          setPaletteDismissed(false);
          setPaletteIdx(0);
        }
      }, 0);
      return; // the prompt input owns the other keys
    }

    // normal mode: transcript navigation
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
      setAnchor(Math.max(0, start - MOUNTED_ITEMS));
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
  const bottomRows = 2 + promptRows + 1;
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
    ) : overlayState === "connect" && connectStep ? (
      <ConnectWizard step={connectStep} providers={PROVIDERS} areaHeight={modalAreaHeight} />
    ) : overlayState === "settings" ? (
      <SettingsPanel settings={settings} group={settingsGroup} onChange={changeSettings} onDone={doneSettings} />
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
      />
    ) : null;

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={colors.bg}>
      <scrollbox
          ref={scrollRef}
          stickyStart="bottom"
          scrollAcceleration={wheelAccel}
          width="100%"
          height={Math.max(6, dims.height - bottomRows - (paletteOpen ? paletteOptions.length + 2 : 0))}
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
        </scrollbox>
      {paletteOpen ? (
        <CommandPalette
          options={paletteOptions}
          selectedIndex={Math.min(paletteIdx, paletteOptions.length - 1)}
          onPick={completeOption}
        />
      ) : null}
      <PromptBar
        focused={inputFocused && overlayState === "none" && !paletteOpen}
        busy={busy}
        closeArmed={closeArmed}
        rows={promptRows}
        textareaRef={textareaRef}
        onSend={send}
        onTextChange={(text) => {
          setPromptText(text);
          if (!isPaletteText(text)) setPaletteDismissed(false);
          else if (text.length <= 1) {
            setPaletteDismissed(false);
            setPaletteIdx(0);
          }
        }}
      />
      <StatusLine
        model={(modelOverride ?? info.model ?? props.runSpec?.model ?? DEFAULT_MODEL) || "default model"}
        path={shortPath(props.cwd)}
        branch={branch}
        status={displayStatus}
        startedAt={turnStartedAt}
      />
      {overlayNode ? <Modal areaHeight={modalAreaHeight}>{overlayNode}</Modal> : null}
    </box>
  );
}
