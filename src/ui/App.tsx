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
import { StartScreen } from "./components/StartScreen";
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
  /** Run mode: start immediately (skips the StartScreen). */
  runSpec?: TaskSpec;
  /** Force the header status (for screenshot scenes); otherwise derived from the run. */
  statusOverride?: "running" | "done" | "error";
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
  const [phase, setPhase] = useState<"start" | "run" | "view">(staticMode || props.viewPath ? "view" : props.runSpec ? "run" : "start");
  const [status, setStatus] = useState<"running" | "done" | "error">(
    props.statusOverride ?? (staticMode || props.viewPath ? "done" : "running"),
  );
  const [errorText, setErrorText] = useState("");
  const [focusIdx, setFocusIdx] = useState(0);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [tick, setTick] = useState(0);
  const [modelOverride, setModelOverride] = useState<string | undefined>(undefined);
  const [cmdBuffer, setCmdBufferState] = useState<string | null>(null);
  const [pickerOpen, setPickerOpenState] = useState(false);
  // Key handlers can fire several times before React re-renders; mirror the two values
  // they read/write into refs so state is never stale inside a batch of keystrokes.
  const cmdRef = useRef<string | null>(null);
  const pickerRef = useRef(false);
  const setCmdBuffer = (value: string | null) => {
    cmdRef.current = value;
    setCmdBufferState(value);
  };
  const setPickerOpen = (value: boolean) => {
    pickerRef.current = value;
    setPickerOpenState(value);
  };
  const dims = useTerminalDimensions();
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const live = useRef<{ watch?: WatchHandle; run?: MiniRun }>({});

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
    setPhase("run");
    setStatus("running");
    const run = spawnMini({ ...spec, model: spec.model || modelOverride });
    live.current.run = run;
    live.current.watch = watchTrajectory(run.session.trajPath, applySnapshot);
    run.exited.then((code) => {
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
    setCmdBuffer(null);
    setModelOverride(model);
    const liveRun = live.current.run;
    liveRun?.switchModel(model);
    setEvents((prev) => [
      ...prev,
      {
        type: "notice",
        text: liveRun ? `model → ${model} (from next step)` : `model → ${model} (next run)`,
        interruptType: "model",
      },
    ]);
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
    if (phase === "start") return;

    if (pickerRef.current) {
      if (key.name === "escape") {
        setPickerOpen(false);
        setCmdBuffer(null);
      }
      return; // the Select owns the other keys
    }

    if (cmdRef.current !== null) {
      if (key.name === "escape") return setCmdBuffer(null);
      if (key.name === "backspace") {
        const current = cmdRef.current ?? "";
        return setCmdBuffer(current.length > 0 ? current.slice(0, -1) : null);
      }
      if (key.name === "return" || key.name === "enter") {
        const typed = (cmdRef.current ?? "").trim();
        setCmdBuffer(null);
        const command = typed.toLowerCase();
        if (command === "model") return setPickerOpen(true);
        if (command.startsWith("model ")) {
          const model = typed.slice("model ".length).trim();
          if (model) return applyModel(model);
        }
        return setEvents((prev) => [
          ...prev,
          { type: "notice", text: `unknown command: /${typed}`, interruptType: "mini-tui" },
        ]);
      }
      const ch = key.sequence;
      if (ch && ch.length === 1 && !key.ctrl && !key.meta && ch >= " ") return setCmdBuffer((cmdRef.current ?? "") + ch);
      return;
    }

    if (key.name === "/" || key.sequence === "/") return setCmdBuffer("");
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
  void exitEvent;

  const hint = pickerOpen
    ? "model picker"
    : cmdBuffer !== null
      ? `/${cmdBuffer}▏`
      : phase === "run"
        ? status === "running"
          ? "follow"
          : (info.exitStatus ?? status)
        : props.viewPath
          ? "view"
          : undefined;

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={colors.bg}>
      <Header
        model={modelOverride ?? info.model ?? props.runSpec?.model ?? DEFAULT_MODEL}
        step={step}
        cost={info.cost}
        status={status}
        spinner={SPINNER[tick % SPINNER.length]}
      />
      {phase === "start" ? (
        <StartScreen cwd={props.cwd} defaultModel={modelOverride ?? DEFAULT_MODEL} onSubmit={startRun} />
      ) : pickerOpen ? (
        <ModelPicker current={modelOverride ?? info.model ?? DEFAULT_MODEL} onPick={applyModel} onCancel={() => setPickerOpen(false)} />
      ) : (
        <scrollbox ref={scrollRef} stickyScroll stickyStart="bottom" width="100%" height={Math.max(6, dims.height - 6)}>
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
      <StatusBar hint={hint} />
    </box>
  );
}
