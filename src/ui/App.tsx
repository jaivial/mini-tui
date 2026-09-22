import { useEffect, useRef, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { ScrollBoxRenderable } from "@opentui/core";

import { colors, markdownSyntaxStyle } from "./theme";
import { Header } from "./components/Header";
import { TaskCard } from "./components/TaskCard";
import { ToolCallCard } from "./components/ToolCallCard";
import { ObservationCard } from "./components/ObservationCard";
import { NoticeLine } from "./components/NoticeLine";
import { ExitBanner } from "./components/ExitBanner";
import { StatusBar } from "./components/StatusBar";
import { PromptBar } from "./components/PromptBar";
import { ModelPicker } from "./components/ModelPicker";
import { messagesToEvents, parseInfo } from "../traj/parse";
import { readTrajectory, watchTrajectory, type WatchHandle } from "../traj/watch";
import { spawnMini, tailLog, type MiniRun, type TaskSpec } from "../mini/spawn";
import { DEFAULT_MODEL } from "../config";
import type { RunEvent, RunInfo, Trajectory } from "../traj/schema";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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
  const [inputFocused, setInputFocusedState] = useState(true);
  const [pickerOpen, setPickerOpenState] = useState(false);
  const [hintText, setHintText] = useState<string | undefined>(undefined);
  // Key handlers can fire several times before React re-renders; mirror what they
  // read/write into refs so state is never stale inside a batch of keystrokes.
  const inputRefocus = useRef(true);
  const pickerRef = useRef(false);
  const exitedRef = useRef(false);
  const setInputFocused = (value: boolean) => {
    inputRefocus.current = value;
    setInputFocusedState(value);
  };
  const setPickerOpen = (value: boolean) => {
    pickerRef.current = value;
    setPickerOpenState(value);
  };
  const dims = useTerminalDimensions();
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const live = useRef<{ watch?: WatchHandle; run?: MiniRun }>({});

  const applySnapshot = (traj: Trajectory) => {
    const parsed = messagesToEvents(traj.messages ?? [], { showSystem: props.showSystem });
    setEvents(parsed);
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
    setPickerOpen(false);
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

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const command = trimmed.replace(/^\//, "").toLowerCase();
    if (command === "model") return setPickerOpen(true);
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

  const items = buildItems(events);
  const pairItems = items.filter((item): item is Extract<Item, { kind: "pair" }> => item.kind === "pair");

  const quit = () => {
    live.current.watch?.stop();
    live.current.run?.kill();
    if (props.onQuit) props.onQuit();
    else process.exit(0);
  };

  useKeyboard((key) => {
    if (pickerRef.current) {
      if (key.name === "escape") {
        setPickerOpen(false);
        setInputFocused(true);
      }
      return; // the Select owns the other keys
    }

    if (inputRefocus.current) {
      if (key.name === "escape") return setInputFocused(false);
      if (key.ctrl && key.name === "c") return quit();
      return; // the prompt input owns the other keys
    }

    // normal mode: transcript navigation
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
    if (key.name === "pageup") return scrollRef.current?.scrollBy(-10);
    if (key.name === "pagedown") return scrollRef.current?.scrollBy(10);
    if (key.name === "g" && key.shift) return scrollRef.current?.scrollBy(1_000_000);
    if (key.name === "g") return scrollRef.current?.scrollBy(-1_000_000);
  });

  const step = events.filter((event) => event.type === "assistant").length;
  const focusedPair = Math.min(Math.max(focusIdx, 0), Math.max(pairItems.length - 1, 0));
  const exitEvent = events.find((event) => event.type === "exit") as Extract<RunEvent, { type: "exit" }> | undefined;
  const displayStatus = props.statusOverride ?? (exitEvent ? "done" : status);
  const busy = Boolean(live.current.run) && !exitedRef.current;

  const hint =
    hintText ??
    (pickerOpen
      ? "model picker"
      : inputFocused
        ? busy
          ? "typing · Enter continues the conversation"
          : "typing · Enter launches"
        : "normal · i type · q quit");

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={colors.bg}>
      <Header
        model={modelOverride ?? info.model ?? props.runSpec?.model ?? DEFAULT_MODEL}
        step={step}
        cost={info.cost}
        status={displayStatus}
        spinner={SPINNER[tick % SPINNER.length]}
      />
      {pickerOpen ? (
        <ModelPicker current={modelOverride ?? info.model ?? DEFAULT_MODEL} onPick={applyModel} onCancel={() => setPickerOpen(false)} />
      ) : (
        <scrollbox ref={scrollRef} stickyScroll stickyStart="bottom" width="100%" height={Math.max(6, dims.height - 12)}>
          {items.map((item) => {
            if (item.kind === "event") {
              const event = events[item.index];
              if (!event) return null;
              if (event.type === "task") return <TaskCard key={item.index} text={event.text} />;
              if (event.type === "assistant")
                return (
                  <box key={item.index} borderStyle="rounded" borderColor={colors.border} title="assistant" titleColor={colors.accent} paddingX={1}>
                    <markdown content={event.text} syntaxStyle={markdownSyntaxStyle} streaming />
                  </box>
                );
              if (event.type === "notice") return <NoticeLine key={item.index} text={event.text} interruptType={event.interruptType} />;
              if (event.type === "exit") return <ExitBanner key={item.index} exitStatus={event.exitStatus} submission={event.submission} />;
              return null;
            }
            const tool = events[item.toolIndex];
            const obs = item.observationIndex !== null ? events[item.observationIndex] : null;
            const pairFocus = pairItems.findIndex((p) => p.toolIndex === item.toolIndex);
            return (
              <box key={item.toolIndex} flexDirection="column" gap={0}>
                {tool && tool.type === "tool_call" ? (
                  <ToolCallCard
                    index={pairFocus + 1}
                    name={tool.name}
                    command={tool.command}
                    focused={pairFocus === focusedPair}
                  />
                ) : null}
                {obs && obs.type === "observation" ? (
                  <ObservationCard
                    returncode={obs.returncode}
                    output={obs.output}
                    exceptionInfo={obs.exceptionInfo}
                    expanded={expanded.has(item.toolIndex)}
                    focused={pairFocus === focusedPair}
                  />
                ) : null}
              </box>
            );
          })}
          {errorText ? (
            <box borderStyle="single" borderColor={colors.err} title="mini.log tail" titleColor={colors.err} paddingX={1}>
              <text fg={colors.err}>{errorText}</text>
            </box>
          ) : null}
        </scrollbox>
      )}
      <PromptBar focused={inputFocused && !pickerOpen} busy={busy} onSend={send} />
      <StatusBar hint={hint} />
    </box>
  );
}
