import { useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard, useSelectionHandler, useTerminalDimensions } from "@opentui/react";
import type { Database } from "bun:sqlite";
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";

import { colors, markdownSyntaxStyle, applyTheme, DEFAULT_THEME } from "./theme";
import { StatusLine } from "./components/StatusLine";
import { TaskCard } from "./components/TaskCard";
import { StepCard } from "./components/StepCard";
import { NoticeLine } from "./components/NoticeLine";
import { ExitBanner } from "./components/ExitBanner";
import { StatusBar } from "./components/StatusBar";
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
import { loadSettings, saveSettings, type Settings } from "../settings";
import type { RunEvent, RunInfo, Trajectory, TrajectoryMessage } from "../traj/schema";

const COMMAND_OPTIONS = buildOptions(MODELS);
const ESC_DOUBLE_MS = 800;

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
  /** Override clipboard writes (tests); defaults to OSC 52 + tmux buffer + native tools. */
  onCopy?: (text: string) => void;
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
export function buildItems(events: RunEvent[]): Item[] {
  const pairs: Pair[] = [];
  const freePairs: Pair[] = [];
  const byId = new Map<string, Pair[]>();

  events.forEach((event, index) => {
    if (event.type !== "tool_call") return;
    const pair: Pair = { toolIndex: index, observationIndex: null };
    pairs.push(pair);
    if (event.id) byId.set(event.id, [...(byId.get(event.id) ?? []), pair]);
    else freePairs.push(pair);
  });

  events.forEach((event, index) => {
    if (event.type !== "observation") return;
    const queue = (event.toolCallId && byId.get(event.toolCallId)) || [];
    const pair = queue.shift() ?? freePairs.shift();
    if (queue.length === 0 && event.toolCallId) byId.delete(event.toolCallId);
    if (pair) pair.observationIndex = index;
  });

  const claimed = new Set(pairs.map((p) => p.observationIndex).filter((i): i is number => i !== null));
  const items: Item[] = [];
  events.forEach((event, index) => {
    if (event.type === "tool_call") {
      const pair = pairs.find((p) => p.toolIndex === index);
      if (pair) items.push({ kind: "pair", toolIndex: pair.toolIndex, observationIndex: pair.observationIndex });
      return;
    }
    if (event.type === "observation" && claimed.has(index)) return;
    items.push({ kind: "event", index });
  });
  return items;
}

export function App(props: AppProps) {
  const staticMode = Boolean(props.events);
  const [events, setEvents] = useState<RunEvent[]>(props.events ?? []);
  const [info, setInfo] = useState<RunInfo>(props.info ?? { cost: 0, apiCalls: 0 });
  const [status, setStatus] = useState<"running" | "done" | "error" | "idle">(
    props.statusOverride ?? (props.runSpec ? "running" : staticMode || props.viewPath ? "done" : "idle"),
  );
  const [errorText, setErrorText] = useState("");
  const [focusIdx, setFocusIdx] = useState(0);
  const [flipped, setFlipped] = useState<Set<number>>(new Set());
  const [tick, setTick] = useState(0);
  const [modelOverride, setModelOverride] = useState<string | undefined>(undefined);
  const [settings, setSettings] = useState<Settings>(() => {
    const loaded = props.initialSettings ?? loadSettings();
    applyTheme(loaded.theme ?? DEFAULT_THEME);
    return loaded;
  });
  const [settingsGroup, setSettingsGroup] = useState(0);
  const [inputFocused, setInputFocusedState] = useState(true);
  const [overlayState, setOverlayState] = useState<"none" | "model" | "settings" | "help" | "resume" | "connect">("none");
  const [hintText, setHintText] = useState<string | undefined>(undefined);
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
  const promptRef = useRef("");
  const dismissedRef = useRef(false);
  const paletteIdxRef = useRef(0);
  const lastEscAt = useRef(0);
  const followRef = useRef(true);
  const startedAtRef = useRef(0);
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

  const paletteOptions =
    promptText.startsWith("/") && !paletteDismissed ? matchOptions(promptText, commandOptionsRef.current) : [];
  const paletteOpen = paletteOptions.length > 0 && inputFocused && overlayState === "none";
  // Soft-wrapped rows: long lines continue on the next row and grow the box (up to 8).
  const promptContentWidth = Math.max(12, dims.width - 4);
  const promptRows = Math.min(
    8,
    promptText.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil((line.length + 1) / promptContentWidth)), 0),
  );

  const applyPromptText = (text: string) => {
    textareaRef.current?.setText(text);
    setPromptText(text);
    if (!text.startsWith("/")) setPaletteDismissed(false);
    setPaletteIdx(0);
  };

  const completeOption = (option: CommandOption) => {
    textareaRef.current?.setText(option.insert);
    setPromptText(option.insert);
    setPaletteDismissed(true);
    setPaletteIdx(0);
    setInputFocused(true);
  };

  const applySnapshot = (traj: Trajectory) => {
    messagesRef.current = traj.messages ?? [];
    setEvents(messagesToEvents(traj.messages ?? [], { showSystem: props.showSystem }));
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
        else setErrorText(`Could not read trajectory: ${props.viewPath}`);
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

  // Keep the session transcript saved (debounced) once a session exists.
  useEffect(() => {
    const id = sessionIdRef.current;
    if (!persist || !id) return;
    const timer = setTimeout(() => {
      try {
        saveTranscript(db(), id, events, info, messagesRef.current);
      } catch {
        // persistence is best-effort
      }
    }, 500);
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
    startedAtRef.current = Date.now();
    setHintText(undefined);
    const run = spawnMini({
      ...spec,
      model: spec.model || modelOverride,
      env: modelEnv(spec.model || modelOverride || DEFAULT_MODEL, connections),
    });
    live.current = { run };
    live.current.watch = watchTrajectory(run.session.trajPath, applySnapshot);
    run.exited.then((code) => {
      exitedRef.current = true;
      live.current.watch?.stop();
      const traj = readTrajectory(run.session.trajPath);
      if (traj) applySnapshot(traj);
      if (code === 0) {
        setStatus("done");
      } else {
        setStatus("error");
        setErrorText(tailLog(run.session.logPath));
      }
    });
  };

  const openSession = (record: SessionRecord) => {
    setOverlay("none");
    setResumeQuery("");
    sessionIdRef.current = record.id;
    try {
      setEvents(JSON.parse(record.events_json) as RunEvent[]);
      const restored = JSON.parse(record.info_json) as RunInfo;
      setInfo({ ...restored, cost: restored.cost ?? 0, apiCalls: restored.apiCalls ?? 0 });
      messagesRef.current = JSON.parse(record.messages_json) as TrajectoryMessage[];
    } catch {
      setHintText("could not restore that session");
    }
    setStatus("done");
    setHintText(`resumed → ${record.title}`);
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
    setHintText(patch.theme !== undefined ? `theme → ${next.theme}` : `output display → ${next.outputMode}`);
  };

  const doneSettings = () => {
    setOverlay("none");
    setHintText(`output display → ${settings.outputMode} · theme → ${settings.theme ?? DEFAULT_THEME}`);
    setInputFocused(true);
  };

  const send = (text: string) => {
    const trimmed = text.trim();
    setPromptText("");
    setPaletteDismissed(false);
    setPaletteIdx(0);
    if (!trimmed) return;
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
    if (command.startsWith("model ")) {
      const model = trimmed.replace(/^\//, "").slice("model ".length).trim();
      if (model) return applyModel(model);
      return;
    }
    if (props.onSend) {
      props.onSend(trimmed);
      return;
    }
    const liveRun = live.current.run;
    if (liveRun && !exitedRef.current) {
      liveRun.sendUserMessage(trimmed);
      setHintText("sent → continues the conversation from the next step");
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
    startRun({ task: trimmed, model: modelOverride, cwd: props.cwd, resumePath });
    setHintText(undefined);
  };

  useEffect(() => {
    if (status !== "running") return;
    const timer = setInterval(() => setTick((t) => (t + 1) % 1000), 120);
    return () => clearInterval(timer);
  }, [status]);

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

  const items = buildItems(events);
  const pairItems = items.filter((item): item is Extract<Item, { kind: "pair" }> => item.kind === "pair");

  const quit = () => {
    live.current.watch?.stop();
    live.current.run?.kill(); // quitting interrupts any run in flight
    if (props.onQuit) props.onQuit();
    else process.exit(0);
  };

  /** Esc: double press closes (interrupting the run), single press toggles prompt/navigation. */
  const escapePress = () => {
    const now = Date.now();
    if (now - lastEscAt.current < ESC_DOUBLE_MS) return quit();
    lastEscAt.current = now;
    return setInputFocused(!inputRefocus.current);
  };

  /** ctrl+c: clear the prompt; on an empty prompt (i.e. twice) close. */
  const ctrlCPress = () => {
    if (inputRefocus.current && promptRef.current) return applyPromptText("");
    return quit();
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
      setHintText(`copied ${text.length} chars → clipboard`);
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

      if (!dismissedRef.current && promptRef.current.startsWith("/")) {
        // slash completion: App owns the keys while the popover is open
        const options = matchOptions(promptRef.current, commandOptionsRef.current);
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
        if (!text.startsWith("/")) setPaletteDismissed(false);
        else if (text.length <= 1) {
          setPaletteDismissed(false);
          setPaletteIdx(0);
        }
      }, 0);
      return; // the prompt input owns the other keys
    }

    // normal mode: transcript navigation
    if (key.name === "escape") return escapePress();
    if (key.ctrl && key.name === "c") return quit();
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
      return scrollRef.current?.scrollBy(1_000_000);
    }
    if (key.name === "g") {
      followRef.current = false;
      return scrollRef.current?.scrollBy(-1_000_000);
    }
  });

  const focusedPair = Math.min(Math.max(focusIdx, 0), Math.max(pairItems.length - 1, 0));
  const exitEvent = events.find((event) => event.type === "exit") as Extract<RunEvent, { type: "exit" }> | undefined;
  const displayStatus = props.statusOverride ?? (exitEvent ? "done" : status);
  const busy = Boolean(live.current.run) && !exitedRef.current;
  const elapsedS = startedAtRef.current ? Math.floor((Date.now() - startedAtRef.current) / 1000) : 0;
  const toggle = (key: number) =>
    setFlipped((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Compact bottom stack: prompt (grows with the text) · single status line · hint.
  const bottomRows = 2 + promptRows + 1 + (hintText ? 1 : 0);
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
          height={Math.max(6, dims.height - bottomRows - paletteOptions.length)}
          contentOptions={{ gap: 1 }}
        >
          {items.map((item) => {
            if (item.kind === "event") {
              const event = events[item.index];
              if (!event) return null;
              if (event.type === "task") return <TaskCard key={item.index} text={event.text} />;
              if (event.type === "assistant")
                return (
                  <box key={item.index} paddingX={1} gap={0}>
                    <text fg={colors.faint}>assistant</text>
                    <markdown content={event.text} syntaxStyle={markdownSyntaxStyle} streaming />
                  </box>
                );
              if (event.type === "notice") return <NoticeLine key={item.index} text={event.text} interruptType={event.interruptType} />;
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
                    onToggle={() => toggle(item.index)}
                  />
                );
              return null;
            }
            const tool = events[item.toolIndex];
            const obs = item.observationIndex !== null ? events[item.observationIndex] : null;
            const pairFocus = pairItems.findIndex((p) => p.toolIndex === item.toolIndex);
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
                onToggle={() => toggle(item.toolIndex)}
              />
            );
          })}
          {errorText ? (
            <box paddingX={1} gap={0}>
              <text fg={colors.err}>mini.log tail</text>
              <text fg={colors.dim}>{errorText}</text>
            </box>
          ) : null}
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
        rows={promptRows}
        textareaRef={textareaRef}
        onSend={send}
        onTextChange={(text) => {
          setPromptText(text);
          if (!text.startsWith("/")) setPaletteDismissed(false);
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
        tick={tick}
        elapsedS={elapsedS}
      />
      <StatusBar hint={hintText} />
      {overlayNode ? <Modal areaHeight={modalAreaHeight}>{overlayNode}</Modal> : null}
    </box>
  );
}
