import type { ReactNode } from "react";

/**
 * True modal overlay: absolutely positioned and centered over the transcript area,
 * so panels never push the prompt bar (or anything else) around — even on short
 * terminals, where content is expected to fit/scroll inside the panel instead.
 */
export function Modal(props: { areaHeight: number; children: ReactNode }) {
  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height={props.areaHeight}
      zIndex={100}
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
    >
      {props.children}
    </box>
  );
}
