import { useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { InputRenderable } from "@opentui/core";

import { colors } from "../theme";
import type { TaskSpec } from "../../mini/spawn";

const FIELDS = ["task", "model", "specs"] as const;

export function StartScreen(props: { cwd: string; defaultModel?: string; onSubmit: (spec: TaskSpec) => void }) {
  const [focus, setFocus] = useState(0);
  const taskRef = useRef<InputRenderable>(null);
  const modelRef = useRef<InputRenderable>(null);
  const specsRef = useRef<InputRenderable>(null);

  useKeyboard((key) => {
    if (key.name === "tab" || (key.ctrl && key.name === "n")) setFocus((f) => (f + 1) % FIELDS.length);
    else if (key.name === "back_tab" || (key.ctrl && key.name === "p")) setFocus((f) => (f + FIELDS.length - 1) % FIELDS.length);
    else if (key.name === "escape") process.exit(0);
  });

  const submit = () => {
    const task = (taskRef.current?.value ?? "").trim();
    if (!task) return;
    const model = (modelRef.current?.value ?? "").trim();
    const specs = (specsRef.current?.value ?? "").trim();
    props.onSubmit({
      task,
      model: model || undefined,
      specs: specs ? specs.split(/\s+/) : undefined,
      cwd: props.cwd,
    });
  };

  return (
    <box
      borderStyle="rounded"
      borderColor={colors.border}
      title="mini-tui — new run"
      titleColor={colors.accent}
      padding={1}
      gap={1}
    >
      <text fg={colors.dim}>cwd: {props.cwd}</text>
      <text fg={focus === 0 ? colors.accent : colors.text}>task</text>
      <input
        ref={taskRef}
        placeholder="what should mini do? (Enter to launch)"
        focused={focus === 0}
        onSubmit={submit}
      />
      <text fg={focus === 1 ? colors.accent : colors.text}>model (empty = mini default)</text>
      <input ref={modelRef} placeholder={props.defaultModel || "xiaomi/mimo-v2.6-flash"} focused={focus === 1} onSubmit={submit} />
      <text fg={focus === 2 ? colors.accent : colors.text}>extra -c config specs (space separated, optional)</text>
      <input ref={specsRef} placeholder="e.g. agent.cost_limit=0" focused={focus === 2} onSubmit={submit} />
      <text fg={colors.dim}>Tab/ctrl+n and ctrl+p switch fields · Enter launches · Esc quits</text>
    </box>
  );
}
