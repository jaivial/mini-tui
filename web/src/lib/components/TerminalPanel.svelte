<script lang="ts">
  import { untrack } from "svelte";
  import { RotateCcw, X, Eraser } from "@lucide/svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import "@xterm/xterm/css/xterm.css";
  import Button from "./Button.svelte";
  import { hub } from "../hub";
  import { TermSession, termIdFor } from "../termClient";
  import { ui } from "../stores/ui.svelte";

  /**
   * An interactive terminal in the pane's right sidebar: a real shell (in a PTY on the server) in the
   * session's folder, or on its remote host over ssh. Everything travels on the tab's one hub socket.
   * Hiding the panel or reloading the page does not end the shell; "Restart" does.
   */
  let {
    paneId,
    sessionId,
    title = "",
    onclose,
  }: { paneId: string; sessionId: string | null; title?: string; onclose: () => void } = $props();

  let host = $state<HTMLDivElement | null>(null);
  let status = $state<"connecting" | "live" | "exited" | "error">("connecting");
  let where = $state("");
  let message = $state("");
  let term: Terminal | null = null;
  let fit: FitAddon | null = null;
  let session: TermSession | null = null;

  const id = $derived(termIdFor(paneId, sessionId));

  /** The app's palette, read from its CSS variables, so the terminal matches the theme. */
  function theme() {
    const css = getComputedStyle(document.documentElement);
    const v = (n: string, f: string) => css.getPropertyValue(n).trim() || f;
    return {
      background: v("--color-surface", "#1b1a17"),
      foreground: v("--color-ink", "#e8e6e3"),
      cursor: v("--color-brand", "#f54e00"),
      cursorAccent: v("--color-surface", "#1b1a17"),
      selectionBackground: v("--color-brand-soft", "rgba(245,78,0,0.25)"),
    };
  }

  function start(termId: string, sid: string | null) {
    if (!host) return;
    const t = new Terminal({
      fontFamily: '"JetBrains Mono Variable", ui-monospace, Menlo, monospace',
      fontSize: Math.round(12.5 * ui.textScale),
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
      theme: theme(),
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(host);
    term = t;
    fit = f;
    try {
      f.fit();
    } catch {
      /* not laid out yet */
    }
    status = "connecting";
    message = "";
    session = new TermSession(hub, termId, sid, {
      opened: (info) => {
        where = info.title;
        status = info.alive ? "live" : "exited";
        // Coming back to a running shell: show what it printed while you were away.
        t.reset();
        if (info.replay) t.write(info.replay);
      },
      data: (chunk) => t.write(chunk),
      exit: (code) => {
        status = "exited";
        t.write(`\r\n\x1b[2m[process exited${code !== null ? ` with code ${code}` : ""}. Press Restart for a new shell]\x1b[0m\r\n`);
      },
      error: (m) => {
        status = "error";
        message = m;
      },
    });
    t.onData((d) => session?.input(d));
    t.onResize(({ cols, rows }) => session?.resize(cols, rows));
    session.open(t.cols, t.rows);
    t.focus();
  }

  function stop() {
    session?.detach();
    session = null;
    term?.dispose();
    term = null;
    fit = null;
  }

  // (Re)start whenever the terminal changes: another session in the pane means another shell.
  $effect(() => {
    const termId = id;
    const sid = sessionId;
    if (!host) return;
    untrack(() => start(termId, sid));
    return () => untrack(stop);
  });

  // Keep it sized to the panel.
  $effect(() => {
    if (!host) return;
    const ro = new ResizeObserver(() => {
      try {
        fit?.fit();
      } catch {
        /* hidden */
      }
    });
    ro.observe(host);
    return () => ro.disconnect();
  });

  // Follow the text size and the light/dark theme.
  $effect(() => {
    const size = Math.round(12.5 * ui.textScale);
    ui.theme;
    ui.palette;
    untrack(() => {
      if (!term) return;
      term.options.fontSize = size;
      term.options.theme = theme();
      try {
        fit?.fit();
      } catch {
        /* hidden */
      }
    });
  });

  function restart() {
    const termId = id;
    const sid = sessionId;
    session?.close();
    session = null;
    term?.dispose();
    term = null;
    setTimeout(() => start(termId, sid), 100);
  }

  export function focus() {
    term?.focus();
  }
</script>

<div class="flex min-h-0 flex-1 flex-col">
  <div class="flex min-h-9 shrink-0 items-center gap-1.5 border-b border-line/80 py-1 pr-1.5 pl-3.5 text-[11.5px]">
    <span
      class="size-1.5 shrink-0 rounded-full {status === 'live' ? 'bg-ok' : status === 'connecting' ? 'pulse-live bg-warn' : 'bg-err'}"
      aria-hidden="true"
    ></span>
    <span class="min-w-0 flex-1 truncate font-mono text-ink-faint" title={where}>
      {status === "connecting" ? "Starting a shell" : status === "error" ? "Not connected" : status === "exited" ? "Exited" : where || title}
    </span>
    <span class="sr-only" role="status" aria-live="polite">{status === "live" ? "Terminal ready" : status === "exited" ? "The shell exited" : status === "error" ? message : ""}</span>
    <Button variant="ghost" size="icon-sm" icon={Eraser} title="Clear the screen" aria-label="Clear the terminal" onclick={() => { term?.clear(); term?.focus(); }} />
    <Button variant="ghost" size="icon-sm" icon={RotateCcw} title="Restart: end this shell and start a new one" aria-label="Restart the terminal" onclick={restart} />
    <Button variant="ghost" size="icon-sm" icon={X} title="Hide (the shell keeps running)" aria-label="Hide the terminal panel" onclick={onclose} />
  </div>
  {#if status === "error"}
    <div class="m-2.5 rounded-md bg-err/10 px-3 py-2 text-[12px] text-err" role="alert">{message}</div>
  {/if}
  <!-- The terminal itself: xterm.js handles keys, selection, copy, paste and screen readers (its own
       accessible text layer). The padding sits outside the fitted area so the last row is never cut. -->
  <div class="term-box min-h-0 flex-1 bg-surface px-2 pt-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))]">
    <div bind:this={host} class="h-full w-full" data-terminal={id} role="application" aria-label="Terminal{where ? ` in ${where}` : ''}"></div>
  </div>
</div>

<style>
  .term-box :global(.xterm) {
    height: 100%;
  }
  .term-box :global(.xterm-viewport) {
    background-color: transparent !important;
  }
</style>
