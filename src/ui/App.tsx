import { useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";

import { colors, markdownSyntaxStyle } from "./theme";
import { MetaRow } from "./components/MetaRow";
import { TaskCard } from "./components/TaskCard";
import { StepCard } from "./components/StepCard";
import { NoticeLine } from "./components/NoticeLine";
import { ExitBanner } from "./components/ExitBanner";
import { StatusBar } from "./components/StatusBar";
import { PromptBar } from "./components/PromptBar";
import { ModelPicker, MODELS } from "./components/ModelPicker";
import { SettingsPanel } from "./components/SettingsPanel";
import { HelpPanel } from "./components/HelpPanel";
import { CommandPalette, buildOptions, matchOptions, type CommandOption } from "./components/CommandPalette";
import { messagesToEvents, parseInfo } from "../traj/parse";
import { readTrajectory, watchTrajectory, type WatchHandle } from "../traj/watch";
import { spawnMini, tailLog, type MiniRun, type TaskSpec } from "../mini/spawn";
import { DEFAULT_MODEL } from "../config";
import { gitBranch, shortPath } from "../git";
import { loadSettings, saveSettings, type Settings } from "../settings";
import type { RunEvent, RunInfo, Trajectory } from "../traj/schema";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
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
  /** Force the header status (for screenshot scenes); otherwise derived from the run. */
  statusOverride?: "running" | "done" | "error";
  /** Override persisted settings (tests/screenshots). */
  initialSettings?: Settings;
  /** Persist settings changes to disk (tests set this to false). */
  persistSettings?: boolean;
  /** Override prompt submission (tests); otherwise runs a task or continues the run. */
  onSend?: (text: string) => void;
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
  const [status, setStatus] = useState<"running" | "done" | "error">(
    props.statusOverride ?? (staticMode || props.viewPath ? "done" : "running"),
  );
  const [errorText, setErrorText] = useState("");
  const [focusIdx, setFocusIdx] = useState(0);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [tick, setTick] = useState(0);
  const [modelOverride, setModelOverride] = useState<string | undefined>(undefined);
  const [settings, setSettings] = useState<Settings>(() => props.initialSettings ?? loadSettings());
  const [inputFocused, setInputFocusedState] = useState(true);
  const [overlayState, setOverlayState] = useState<"none" | "model" | "settings" | "help">("none");
  const [hintText, setHintText] = useState<string | undefined>(undefined);
  const [promptText, setPromptTextState] = useState("");
  const [paletteDismissed, setPaletteDismissedState] = useState(false);
  const [paletteIdx, setPaletteIdxState] = useState(0);
  // Key handlers can fire several times before React re-renders; mirror what they
  // read/write into refs so state is never stale inside a batch of keystrokes.
  const inputRefocus = useRef(true);
  const overlayRef = useRef<"none" | "model" | "settings" | "help">("none");
  const exitedRef = useRef(false);
  const promptRef = useRef("");
  const dismissedRef = useRef(false);
  const paletteIdxRef = useRef(0);
  const lastEscAt = useRef(0);
  const followRef = useRef(true);
  const textareaRef = useRef<TextareaRenderable | null>(null);
  const branch = useMemo(() => gitBranch(props.cwd), [props.cwd]);

  const setInputFocused = (value: boolean) => {
    inputRefocus.current = value;
    setInputFocusedState(value);
  };
  const setOverlay = (value: "none" | "model" | "settings" | "help") => {
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
  const dims = useTerminalDimensions();
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const live = useRef<{ watch?: WatchHandle; run?: MiniRun }>({});

  const paletteOptions = promptText.startsWith("/") && !paletteDismissed ? matchOptions(promptText, COMMAND_OPTIONS) : [];
  const paletteOpen = paletteOptions.length > 0 && inputFocused && overlayState === "none";

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

  const startRun = (spec: TaskSpec) => {
    setStatus("running");
    exitedRef.current = false;
    setHintText(undefined);
    const run = spawnMini({ ...spec, model: spec.model || modelOverride });
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

  const applyModel = (model: string) => {
    setOverlay("none");
    setModelOverride(model);
    const liveRun = live.current.run;
    liveRun?.switchModel(model);
    setHintText(`model → ${model}`);
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

  const applySettings = (next: Settings) => {
    setOverlay("none");
    setSettings(next);
    if (props.persistSettings !== false) saveSettings(next);
    setHintText(`output display → ${next.outputMode}`);
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
    if (command === "settings" || command === "config") return setOverlay("settings");
    if (command === "help" || command === "h") return setOverlay("help");
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
    } else {
      startRun({ task: trimmed, model: modelOverride, cwd: props.cwd });
      setHintText(undefined);
    }
  };

  useEffect(() => {
    if (status !== "running") return;
    const timer = setInterval(() => setTick((t) => (t + 1) % SPINNER.length), 120);
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

  useKeyboard((key) => {
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
        const options = matchOptions(promptRef.current, COMMAND_OPTIONS);
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
        setExpanded((prev) => {
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
      return scrollRef.current?.scrollBy(-10);
    }
    if (key.name === "pagedown") {
      followRef.current = true;
      return scrollRef.current?.scrollBy(10);
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

  const step = events.filter((event) => event.type === "assistant").length;
  const focusedPair = Math.min(Math.max(focusIdx, 0), Math.max(pairItems.length - 1, 0));
  const exitEvent = events.find((event) => event.type === "exit") as Extract<RunEvent, { type: "exit" }> | undefined;
  const displayStatus = props.statusOverride ?? (exitEvent ? "done" : status);
  const busy = Boolean(live.current.run) && !exitedRef.current;
  const toggle = (key: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const hint =
    hintText ??
    (overlayState === "model"
      ? "model picker"
      : overlayState === "settings"
        ? "settings"
        : overlayState === "help"
          ? "help"
          : inputFocused
            ? busy
              ? "typing · Enter continues the conversation"
              : "typing · Enter launches"
            : "normal · i type · q quit");

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={colors.bg}>
      {overlayState === "model" ? (
        <ModelPicker
          current={modelOverride ?? info.model ?? props.runSpec?.model ?? DEFAULT_MODEL}
          onPick={applyModel}
          onCancel={() => setOverlay("none")}
        />
      ) : overlayState === "settings" ? (
        <SettingsPanel settings={settings} onApply={applySettings} onCancel={() => setOverlay("none")} />
      ) : overlayState === "help" ? (
        <HelpPanel />
      ) : (
        <scrollbox
          ref={scrollRef}
          stickyStart="bottom"
          width="100%"
          height={Math.max(6, dims.height - 10 - paletteOptions.length)}
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
                    expanded={expanded.has(item.index)}
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
                expanded={expanded.has(item.toolIndex)}
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
      )}
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
      <MetaRow
        model={(modelOverride ?? info.model ?? props.runSpec?.model ?? DEFAULT_MODEL) || "default model"}
        path={shortPath(props.cwd)}
        branch={branch}
        step={step}
        cost={info.cost}
        status={displayStatus}
        spinner={SPINNER[tick % SPINNER.length]}
      />
      <StatusBar hint={hint} />
    </box>
  );
}
