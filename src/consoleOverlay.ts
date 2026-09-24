import type { CliRenderer, KeyEvent } from "@opentui/core";

/**
 * OpenTUI pops its built-in console overlay open on every uncaught error / unhandled
 * rejection (`openConsoleOnError` defaults to true), but the overlay ships with no key to
 * close it — once it appeared mid-conversation it stayed stuck over the transcript.
 *
 * Title shown on the overlay so the way out is always visible.
 */
export const CONSOLE_TITLE = "Console — esc to close · ctrl+\\ toggle";

/** True when the key should toggle the console (ctrl+\ — unused elsewhere in the app). */
function isToggleKey(key: KeyEvent): boolean {
  return key.ctrl && (key.name === "\\" || key.name === "backslash" || key.sequence === "\x1c");
}

/**
 * Give the console overlay a way out: `esc` closes it while it is open (the key is then
 * swallowed so the app underneath does not also react), and `ctrl+\` toggles it at will.
 * Registered ahead of the React listeners so it wins even while a modal is up.
 */
export function installConsoleClose(renderer: CliRenderer): () => void {
  const onKey = (key: KeyEvent) => {
    const terminalConsole = renderer.console;
    if (isToggleKey(key)) {
      if (terminalConsole.visible) terminalConsole.hide();
      else terminalConsole.show();
      renderer.requestRender();
      key.preventDefault();
      key.stopPropagation();
      return;
    }
    if (key.name === "escape" && terminalConsole.visible) {
      terminalConsole.hide();
      renderer.requestRender();
      key.preventDefault();
      key.stopPropagation();
    }
  };
  renderer.keyInput.prependListener("keypress", onKey);
  return () => {
    renderer.keyInput.off("keypress", onKey);
  };
}
