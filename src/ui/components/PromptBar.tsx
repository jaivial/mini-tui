import { useEffect, useRef, type RefObject } from "react";
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
  /** First ctrl+c landed: the (now empty) prompt says a second one closes. */
  closeArmed?: boolean;
  rows: number;
  textareaRef: RefObject<TextareaRenderable | null>;
  onSend: (text: string) => void;
  onTextChange: (text: string) => void;
  /** Rows the text wraps into at the textarea's width (word wrap, wide chars): the box height. */
  onWrapRows?: (rows: number) => void;
}) {
  /** Report the wrapped row count and, when it all fits, show it from the top (the textarea
   * scrolled a row it wrapped before the box grew, and kept it scrolled after growing). */
  const reported = useRef(0);
  const reportRows = () => {
    const area = props.textareaRef.current;
    if (!area) return;
    const view = area.editorView;
    const rows = Math.max(1, view.getTotalVirtualLineCount());
    const viewport = view.getViewport();
    if (viewport.offsetY > 0 && rows <= viewport.height) {
      view.setViewport(viewport.offsetX, 0, viewport.width, viewport.height, false);
      area.requestRender();
    }
    if (rows === reported.current) return;
    reported.current = rows;
    props.onWrapRows?.(rows);
  };
  const reportRef = useRef(reportRows);
  reportRef.current = reportRows;
  // A width change (terminal resize) re-wraps the text with no content change, and the
  // textarea's onResize neither calls onSizeChange nor emits "resize": hook it directly.
  useEffect(() => {
    // onResize is protected on the renderable: reach it through a narrow view
    const area = props.textareaRef.current as unknown as { onResize: (width: number, height: number) => void } | null;
    if (!area) return;
    const original = area.onResize;
    area.onResize = function (width, height) {
      original.call(this, width, height);
      reportRef.current();
    };
    return () => {
      area.onResize = original;
    };
  }, [props.textareaRef]);
  const hint = props.closeArmed
    ? "ctrl+c again to close"
    : props.busy
      ? "continue the conversation…"
      : "what should mini do?";
  return (
    <box
      borderStyle="rounded"
      borderColor={props.focused ? colors.borderActive : colors.border}
      paddingX={1}
    >
      <textarea
        ref={props.textareaRef}
        focused={props.focused}
        height={Math.max(1, props.rows)}
        wrapMode="word"
        keyBindings={PROMPT_KEY_BINDINGS as never}
        placeholder={hint}
        textColor={colors.text}
        placeholderColor={colors.faint}
        backgroundColor={colors.bg}
        onContentChange={() => {
          reportRows();
          props.onTextChange(props.textareaRef.current?.editorView.getText() ?? "");
        }}
        onSubmit={() => {
          const text = (props.textareaRef.current?.editorView.getText() ?? "").replace(/\n+$/, "");
          props.textareaRef.current?.setText("");
          props.onSend(text);
        }}
      />
    </box>
  );
}
