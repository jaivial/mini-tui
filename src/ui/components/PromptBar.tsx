import type { RefObject } from "react";
import type { TextareaRenderable } from "@opentui/core";

import { colors } from "../theme";

// Claude-Code style: Enter sends; Alt+Enter / Ctrl+J insert a newline (Shift+Enter too,
// on terminals that report it through the kitty keyboard protocol).
const PROMPT_KEY_BINDINGS = [
  { name: "return", shift: false, ctrl: false, meta: false, action: "submit" },
  { name: "return", meta: true, action: "newline" },
  { name: "return", shift: true, action: "newline" },
  { name: "kpenter", action: "submit" },
  { name: "linefeed", action: "newline" },
];

/** Multi-line prompt bar pinned to the bottom: always one Enter away. */
export function PromptBar(props: {
  focused: boolean;
  busy: boolean;
  rows: number;
  textareaRef: RefObject<TextareaRenderable | null>;
  onSend: (text: string) => void;
  onTextChange: (text: string) => void;
}) {
  const hint = props.busy ? "continue the conversation…" : "what should mini do?";
  return (
    <box
      borderStyle="rounded"
      borderColor={props.focused ? colors.borderActive : colors.border}
      paddingX={1}
    >
      <textarea
        ref={props.textareaRef}
        focused={props.focused}
        height={Math.max(1, Math.min(3, props.rows))}
        keyBindings={PROMPT_KEY_BINDINGS as never}
        placeholder={hint}
        textColor={colors.text}
        placeholderColor={colors.faint}
        backgroundColor={colors.bg}
        onContentChange={() => props.onTextChange(props.textareaRef.current?.editorView.getText() ?? "")}
        onSubmit={() => {
          const text = (props.textareaRef.current?.editorView.getText() ?? "").replace(/\n+$/, "");
          props.textareaRef.current?.setText("");
          props.onSend(text);
        }}
      />
    </box>
  );
}
