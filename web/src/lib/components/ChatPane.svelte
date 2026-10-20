<script lang="ts">
  import { tick } from "svelte";
  import { GripVertical, PanelLeft, WifiOff, SquarePen, SquareSlash, Sparkles, RotateCcw, NotebookPen, SquareTerminal, Network, Columns2, Rows2, LayoutGrid, SquareSplitHorizontal, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, X, Plus, Trash2, CalendarClock, Settings, Server, Keyboard, MoonStar } from "@lucide/svelte";
  import Button from "./Button.svelte";
  import SessionHeader from "./SessionHeader.svelte";
  import HeaderMenu, { type MenuRow } from "./HeaderMenu.svelte";
  import SubagentStrip from "./SubagentStrip.svelte";
  import Transcript from "./Transcript.svelte";
  import Composer from "./Composer.svelte";
  import Lightbox from "./Lightbox.svelte";
  import Skeleton from "./Skeleton.svelte";
  import FloatingMascot from "./FloatingMascot.svelte";
  import PixelLoader from "./PixelLoader.svelte";
  import Spinner from "./Spinner.svelte";
  // The terminal (xterm.js, ~290 KB) is loaded the first time a terminal is opened, not with the app.
  const TerminalPanel = () => import("./TerminalPanel.svelte");
  // Notes and Agents are code-split like the terminal (E28): together they are 12 KB of gzip that
  // no first visit can reach — the side panel is closed in a fresh pane and stays closed until
  // somebody opens it. Their chunks arrive on the first open, which is why the focus request for
  // them has to survive (see `sidePanelFocus.ts`).
  const NotesPanel = () => import("./NotesPanel.svelte");
  const AgentsPanel = () => import("./AgentsPanel.svelte");
  import { catalog } from "../stores/catalog.svelte";
  import { store } from "../stores/sessions.svelte";
  import { panes, type Pane, type SideTab } from "../stores/panes.svelte";
  import { toasts } from "../stores/toast.svelte";
  import { api } from "../api";
  import { parseCommand } from "../completion";
  import { splitSent } from "../promptMemory";
  import { paneStatus } from "../paneStatus";
  import { sideWidthStyle } from "../sidePanel";
  import { deliverSideFocus } from "../sidePanelFocus";
  import { followTranscript, isAtBottom } from "../threadScroll";

  /**
   * One pane: a chat (a session, or a new chat until its first message) with its own header, transcript,
   * prompt bar and notes. Everything it holds lives in the pane store, so a split that remounts it loses
   * nothing. Commands and the model picker act on this pane; app-wide things (settings, resume, help)
   * go up through `onapp`.
   *
   * From v6 the pane's own controls are no longer a row of icon buttons beside the title: they are the
   * rows of ONE popover, hung off a three-dots button in the header (`menuRows`). Nothing was dropped —
   * split, notes, agents, terminal, layout, close pane, close session, palette, settings, help, resume
   * and the team map are all still here, just collected in one place.
   */
  let {
    pane,
    number,
    total,
    tabs = false,
    first = true,
    loading = false,
    canRight = true,
    canDown = true,
    ontogglesidebar,
    onapp,
    onsplit,
    onclosepane,
    moves,
    onmovepane,
    layouts,
    onarrange,
    ondragpane,
    /** The pointer left the grip: this pane is the one being dragged. */
    ondragmove,
    ondragend,
    dragging = false,
    /** v6: the app-level actions the header menu carries (Routines, Team map, hosts, settings…). */
    appActions = [],
  }: {
    pane: Pane;
    number: number;
    total: number;
    /** Phone and small tablet: panes are tabs, one on screen at a time. */
    tabs?: boolean;
    /** The first pane (in reading order) carries the sidebar toggle. */
    first?: boolean;
    loading?: boolean;
    canRight?: boolean;
    canDown?: boolean;
    ontogglesidebar: () => void;
    onapp: (action: "settings" | "providers" | "skills" | "resume" | "help" | "hosts") => void;
    onsplit: (dir: "row" | "col") => void;
    onclosepane: () => void;
    /** Which directions have a neighbour to trade places with. */
    moves?: { left: boolean; right: boolean; up: boolean; down: boolean };
    onmovepane?: (dir: "left" | "right" | "up" | "down") => void;
    /** Which whole-layout shapes the panes here can take. */
    layouts?: { row: boolean; col: boolean; grid: boolean };
    onarrange?: (shape: "row" | "col" | "grid") => void;
    /** Pointer down on the grip: this pane is being dragged. Omitted: nothing to drag it onto. */
    ondragpane?: (event: PointerEvent) => void;
    ondragmove?: (event: PointerEvent) => void;
    ondragend?: (event: PointerEvent) => void;
    dragging?: boolean;
    /** App-wide rows the header shows under this pane's own (built by App.svelte). */
    appActions?: MenuRow[];
  } = $props();

  const session = $derived(pane.sessionId ? (store.sessions[pane.sessionId] ?? null) : null);
  const focused = $derived(panes.focusedId === pane.id);
  const link = $derived(session ? (store.links[session.id] ?? "idle") : "idle");

  /** The pane's left edge, in the same viewport pixels a pointer reports (the zoom included). */
  let host = $state<HTMLElement | null>(null);
  let paneLeft = $state(0);
  $effect(() => {
    if (!host) return;
    const read = () => (paneLeft = host!.getBoundingClientRect().left);
    read();
    // A split dragged, a pane moved or the sidebar hidden all slide the pane's left edge.
    const ro = new ResizeObserver(read);
    ro.observe(host);
    return () => ro.disconnect();
  });

  let composer = $state<{ focus: () => void } | null>(null);
  let notes = $state<{ focus: () => void } | null>(null);
  let terminal = $state<{ focus: () => void } | null>(null);
  let scroller = $state<HTMLElement | null>(null);
  let modelOpen = $state(false);
  let sending = $state(false);
  let switchingModel = $state(false);

  export function focusComposer() {
    composer?.focus();
  }
  export function focusNotes() {
    wantSideFocus = "notes";
    void tick().then(focusSide);
  }

  // ↑/↓ memory: seeded from the session's own prompts once its transcript is here (a reload, /resume
  // or a sidebar pick keeps the history), and kept as is while the pane stays on the same session.
  $effect(() => {
    const id = pane.sessionId;
    if (id === pane.memoryOf) return;
    if (id && !store.hydrated[id] && !(store.sessions[id]?.events.length)) return; // wait for the snapshot
    const names = catalog.commands.map((c) => c.name);
    const tasks = id ? (store.sessions[id]?.events ?? []).flatMap((e) => (e.type === "task" ? [splitSent(e.text, names)] : [])) : [];
    // A new chat's first message creates its session: keep what was typed in the draft pane.
    if (!(pane.memoryOf === null && id && pane.memory.size && tasks.length <= pane.memory.size)) pane.memory.reset(tasks);
    pane.memoryOf = id;
  });

  /**
   * False while the reader is viewing history: a jump-to-latest button stays in the transcript
   * viewport until the newest messages are back in view.
   */
  let atBottom = $state(true);
  /** What the pin effect remembers: whose transcript it was following. */
  let pinnedSession: string | null = null;

  // Follow the stream only while the reader is already following it (see lib/threadScroll.ts).
  // Unconditional pinning threw anyone reading history back to the bottom on every single delta.
  $effect(() => {
    // The pass runs on the frame AFTER the transcript renders, and this is the load-bearing line of
    // the whole fix. `$effect` fires when `events.length` changes — which is BEFORE the browser has
    // laid the new rows out, so measuring here reads the OLD geometry: the reader still at the
    // bottom, `scrollHeight` still short. Measured on the build that did that: the wheel had put the
    // reader at 0, the pass still measured them at the bottom, and the pin dragged them back.
    // `tick()` flushes the DOM first, so the measurement is of what is actually on screen.
    // `hydrated` is in the dependency list on purpose: the first pass fires while the pane is still
    // the loading skeleton (measured: it pinned to the skeleton height of 715 px at t=96 ms, a
    // no-op, and then nothing else changed `events.length`, so the transcript stayed at its top).
    // The transcript only has a height worth pinning once the snapshot has landed.
    const ready = session ? store.hydrated[session.id] || session.events.length > 0 : true;
    session?.events.length;
    if (!ready) return;
    void tick().then(() => pinPass());
  });

  function pinPass() {
    const id = session?.id ?? null;
    // Note the session change BEFORE the scroller guard, but do NOT record it here: this effect runs
    // several times before the scroller binds, and consuming "the first pass" on a pass that could
    // not measure anything left a restored session opening at its TOP. Recording and measuring are
    // one decision; a pass that cannot measure must not count as one.
    const switched = pinnedSession !== null && pinnedSession !== id;
    if (!scroller) return;
    // The reader's position is MEASURED, not read from the cached flag: `onScroll` writes that flag
    // through Svelte, which applies it asynchronously, so a delta landing in the same task as the
    // wheel would be judged against a stale `true` and pin anyway. The DOM is the truth here.
    const geometry = { scrollHeight: scroller.scrollHeight, scrollTop: scroller.scrollTop, clientHeight: scroller.clientHeight };
    const { follow, atBottom: next } = followTranscript(geometry, { atBottom: isAtBottom(geometry), prevSession: pinnedSession }, id, switched);
    pinnedSession = id;
    if (follow) scroller.scrollTop = scroller.scrollHeight;
    // The jump lands at the end, so the button goes with it even though no scroll event fires.
    atBottom = next;
  }

  function onScroll() {
    if (!scroller) return;
    atBottom = isAtBottom({ scrollHeight: scroller.scrollHeight, scrollTop: scroller.scrollTop, clientHeight: scroller.clientHeight });
  }
  function jumpToLatest() {
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
    // The reader is following again: the next delta must keep following them.
    atBottom = true;
    pinnedSession = session?.id ?? null;
  }

  // Where a NEW chat can run. An existing chat already runs somewhere, so it shows no choice.
  const targets = $derived(session ? [] : store.hosts.map((h) => ({ id: h.id, label: h.label })));
  $effect(() => {
    if (pane.draft.targetId !== "local" && !store.hosts.some((h) => h.id === pane.draft.targetId)) pane.draft.targetId = "local";
  });

  const currentModel = $derived(session ? session.model : pane.draft.model || catalog.settings?.lastModel || "");
  const modelNote = $derived(
    !session ? "Used for your first message." : session.target === "remote" ? "Applies from the next turn." : session.status === "running" ? "Applies from the next step." : "Applies to your next message.",
  );

  /**
   * A subagent (or the parent of one) in this pane. The server knows it as a saved session: open
   * it from the history, which also follows its agent live while it runs.
   */
  async function openSubagent(id: string) {
    try {
      if (!store.sessions[id]) store.adopt(await api.openHistory(id));
      panes.show(pane.id, id);
    } catch (error) {
      toasts.push("Could not open that session", { detail: (error as Error).message, tone: "err" });
    }
  }

  function newChat() {
    panes.show(pane.id, null);
    queueMicrotask(() => composer?.focus());
  }

  async function runCommand(text: string): Promise<boolean> {
    const cmd = parseCommand(text, catalog.commands);
    if (!cmd) return false;
    if (!cmd.known) {
      toasts.push(`Unknown command /${cmd.name}`, { detail: "Type / to see the commands. Send it as a message with a leading space.", tone: "err" });
      return true;
    }
    switch (cmd.name) {
      case "new":
        newChat();
        break;
      case "model":
        if (cmd.arg) await pickModel(cmd.arg);
        else modelOpen = true;
        break;
      case "compact":
        if (!session) toasts.push("Nothing to compact yet", { detail: "Send a message first.", tone: "info" });
        else await api.compact(session.id).catch((e) => toasts.push("Could not compact", { detail: (e as Error).message, tone: "err" }));
        break;
      case "subagents": {
        const kids = session?.subagents ?? [];
        if (!kids.length) toasts.push("No subagents yet", { detail: "The agent starts them with `mini-agent-rs agent spawn` (Rust agent). They appear above the transcript.", tone: "info" });
        else if (cmd.arg) {
          const hit = kids.find((k) => k.name === cmd.arg);
          if (hit) await openSubagent(hit.sessionId);
          else toasts.push(`No subagent named ${cmd.arg}`, { detail: kids.map((k) => k.name).join(", "), tone: "err" });
        } else toasts.push(`${kids.length} subagent${kids.length === 1 ? "" : "s"}`, { detail: kids.map((k) => `${k.name}: ${k.state}${k.exitStatus ? ` (${k.exitStatus})` : ""} · ${k.steps} steps`).join("\n"), tone: "info" });
        break;
      }
      case "split":
        onsplit(cmd.arg === "down" || cmd.arg === "v" ? "col" : "row");
        break;
      case "terminal":
        panes.toggleSide(pane.id, "terminal", true);
        wantSideFocus = "terminal";
        void tick().then(focusSide);
        break;
      case "notes":
        panes.toggleNotes(pane.id, true);
        wantSideFocus = "notes";
        void tick().then(focusSide);
        break;
      case "resume":
      case "settings":
      case "skills":
      case "help":
        onapp(cmd.name);
        break;
      case "connect":
        onapp("providers");
        break;
    }
    pane.prompt = "";
    pane.chips = [];
    return true;
  }

  async function send(message: string) {
    const text = message.trim();
    const current = session;
    const atts = pane.attachments;
    if ((!text && !atts.length) || sending) return;
    // A pane can name a session this tab has not loaded yet (another tab just opened it). That is
    // NOT a new chat: creating one here would replace the session in the shared workspace, undoing
    // the other tab's click — the E52 bug through the composer. Wait for the session instead.
    if (!current && pane.sessionId) {
      toasts.push("Still opening that session…", { detail: "It is loading from the server; try again in a moment.", tone: "info" });
      return;
    }
    // Files alone are still a message: the names travel as the text, the ids as metadata.
    const sent = text || `📎 ${atts.map((a) => a.name).join(", ")}`;
    sending = true;
    try {
      if (await runCommand(sent)) return;
      if (!current) {
        // The first message creates the session, on the target and model chosen in this pane's draft.
        // v6: there is no folder to choose any more — every chat starts in the operator's home, so
        // `cwd` travels empty and the server fills in ~.
        const host = store.hosts.find((h) => h.id === pane.draft.targetId);
        // Read the draft now: showing the new session resets the pane's draft.
        const draft = { ...pane.draft };
        try {
          const created = await api.create({
            prompt: sent,
            target: host ? "remote" : "local",
            hostId: host?.id,
            // Send the model the composer SHOWS (currentModel), not only an explicit draft pick:
            // omitting it lets the server fall back to the shared last-model file, which any other
            // session may have flipped since this page read it - the run then uses a different
            // model than the one displayed (seen live: button said MiniMax-M3.1-Flash, the run
            // went out on MiniMax-M3.1-Flash-Preview and got a 401).
            model: currentModel || undefined,
            attachments: atts,
          });
          store.adopt(created);
          panes.show(pane.id, created.id);
          if (draft.model) void catalog.loadSettings();
        } catch (error) {
          toasts.push("Could not start the chat", { detail: (error as Error).message, tone: "err" });
          return;
        }
        pane.prompt = "";
        pane.chips = [];
        pane.attachments = [];
        return;
      }
      await api.send(current.id, sent, atts);
      pane.prompt = "";
      pane.chips = [];
      pane.attachments = [];
    } catch (error) {
      // The text stays in the box, so a failed send is never a lost message.
      toasts.push("Could not send", { detail: (error as Error).message, tone: "err" });
    } finally {
      sending = false;
    }
  }

  async function pickModel(id: string) {
    const current = session;
    if (!current) {
      pane.draft.model = id;
      return;
    }
    if (switchingModel || id === current.model) return;
    switchingModel = true;
    const previous = current.model;
    current.model = id;
    try {
      await api.setModel(current.id, id);
    } catch (error) {
      current.model = previous;
      toasts.push("Model switch failed", { detail: (error as Error).message, tone: "err" });
    } finally {
      switchingModel = false;
    }
  }

  async function interrupt() {
    if (!session) return;
    await api.interrupt(session.id).catch((e) => toasts.push("Could not stop", { detail: (e as Error).message, tone: "err" }));
  }

  async function closeSession() {
    if (!session) return;
    const id = session.id;
    await api.close(id).catch(() => {});
    store.remove(id);
    panes.show(pane.id, null);
  }

  /** Opening moves focus into the panel (after it has rendered); closing leaves it on the button. */
  async function toggleSide(tab: SideTab) {
    panes.toggleSide(pane.id, tab);
    if (!pane.notesOpen) return;
    wantSideFocus = tab;
    await tick();
    focusSide();
  }
  const toggleNotes = () => toggleSide("notes");
  export function focusTerminal() {
    void toggleSide("terminal");
  }
  const sideOpen = (tab: SideTab) => pane.notesOpen && pane.sideTab === tab;
  let agentsPanel = $state<{ focus: () => void } | null>(null);

  /**
   * A side panel whose chunk has not landed yet. Opening one asks for focus there, and the panel
   * mounts a round trip later, so the request waits here instead of being dropped: measured, the
   * naive split left focus on the prompt bar on every sample up to 3.5 s with the panel open.
   */
  let wantSideFocus = $state<SideTab | null>(null);
  /** Deliver the pending request to whichever panel is mounted, spending it only if one takes it. */
  function focusSide() {
    const out = deliverSideFocus(wantSideFocus, { notes, agents: agentsPanel, terminal });
    wantSideFocus = out.request;
  }
  // Re-runs whenever a panel binds (the `{#await}` block resolving is the late case) or the request
  // changes, which is what makes the wait self-clearing without polling.
  $effect(() => {
    notes;
    agentsPanel;
    terminal;
    focusSide();
  });
  /** Agents this session started (the strip's roster): the menu row shows how many work. */
  const agentCount = $derived(session?.subagents?.length ?? 0);
  const MOVES = { left: false, right: false, up: false, down: false };
  const LAYOUTS = { row: false, col: false, grid: false };

  /**
   * Everything this pane can do, as the rows of the header's one popover. This is the old
   * `PaneMenu`'s item list (plus notes/agents/terminal, which were separate buttons beside the
   * title) moved here: same actions, same disabled reasons, one menu instead of two.
   *
   * The app-wide rows (Routines, Team map, hosts, settings, resume, help) are appended from
   * `appActions`, which App.svelte builds — the sidebar used to own those and no longer does.
   */
  const paneRows = $derived.by((): MenuRow[] => [
    { id: "new", label: "New chat here", note: "Ctrl/⌘ K", icon: Plus, group: "This bot", run: newChat },
    ...(agentCount
      ? [{ id: "agents", label: `Agents (${agentCount})`, note: sideOpen("agents") ? "Hide the panel" : "Show the panel", icon: Network, run: () => toggleSide("agents") }]
      : []),
    { id: "notes", label: sideOpen("notes") ? "Hide notes" : "Notes", note: "Ctrl/⌘ ⇧ .", icon: NotebookPen, run: toggleNotes },
    { id: "terminal", label: sideOpen("terminal") ? "Hide terminal" : "Terminal", note: "Ctrl `", icon: SquareTerminal, run: () => toggleSide("terminal") },
    ...(tabs
      ? [{ id: "split", label: "New pane", note: !panes.canSplit ? "At most 12 panes" : "Ctrl \\", icon: SquareSplitHorizontal, disabled: !panes.canSplit, run: () => onsplit("row") }]
      : [
          { id: "split-r", label: "Split right", note: !panes.canSplit ? "At most 12 panes" : canRight ? "Ctrl \\" : "Too narrow to split", icon: Columns2, disabled: !panes.canSplit || !canRight, run: () => onsplit("row") },
          { id: "split-d", label: "Split down", note: !panes.canSplit ? "At most 12 panes" : canDown ? "Ctrl ⇧ \\" : "Too short to split", icon: Rows2, disabled: !panes.canSplit || !canDown, run: () => onsplit("col") },
        ]),
    ...(onmovepane
      ? ([
          ["left", "Move pane left", "pane left of this one", ArrowLeft],
          ["right", "Move pane right", "pane right of this one", ArrowRight],
          ["up", "Move pane up", "pane above this one", ArrowUp],
          ["down", "Move pane down", "pane below this one", ArrowDown],
        ] as const).map(([dir, label, why, icon]) => ({
          id: `pane-${dir}`,
          label,
          note: (moves ?? MOVES)[dir] ? "" : `No ${why}`,
          icon,
          disabled: !(moves ?? MOVES)[dir],
          group: "Move pane",
          run: () => onmovepane(dir),
        }))
      : []),
    ...(onarrange
      ? [
          { id: "lay-row", label: "Lay out in a row", icon: Columns2, disabled: !(layouts ?? LAYOUTS).row, note: (layouts ?? LAYOUTS).row ? "" : "Needs 2 panes", group: "Layout", run: () => onarrange("row") },
          { id: "lay-col", label: "Lay out in a column", icon: Rows2, disabled: !(layouts ?? LAYOUTS).col, note: (layouts ?? LAYOUTS).col ? "" : "Needs 2 panes", group: "Layout", run: () => onarrange("col") },
          { id: "lay-grid", label: "Lay out in a grid", icon: LayoutGrid, disabled: !(layouts ?? LAYOUTS).grid, note: (layouts ?? LAYOUTS).grid ? "" : "Needs 4 panes", group: "Layout", run: () => onarrange("grid") },
        ]
      : []),
    { id: "close-pane", label: "Close pane", note: total > 1 ? "Alt X" : "The last pane stays", icon: X, disabled: total <= 1, group: "This bot", run: onclosepane },
    ...(session ? [{ id: "close-session", label: "Close session", note: "Stops it and drops it from the list", icon: Trash2, danger: true, run: closeSession }] : []),
    ...appActions,
  ]);
</script>

{#snippet grip()}
  {#if ondragpane}
    <!-- The drag handle stays IN the header: it is a pointer target, not a command, and a popover
         row cannot be dragged out of the card. Everything that is a command moved into the menu. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <span
      role="button"
      tabindex="0"
      aria-label="Drag pane {number} to swap it with another"
      aria-keyshortcuts="Enter"
      title="Drag to another pane to swap them"
      class="grid size-8 shrink-0 cursor-grab place-items-center rounded-sm text-ink-muted hover:bg-raised hover:text-ink active:cursor-grabbing pointer-coarse:size-11 pointer-coarse:rounded-md"
      class:is-dragging={dragging}
      data-dragging={dragging ? "true" : undefined}
      onpointerdown={ondragpane}
      onpointermove={ondragmove}
      onpointerup={ondragend}
      onpointercancel={ondragend}
      onkeydown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onmovepane?.("right");
      }}
    >
      <GripVertical size={14} strokeWidth={1.75} aria-hidden="true" />
    </span>
  {/if}
{/snippet}

<!--
  The pane is a query container: its header and prompt bar lay themselves out for the pane's width.
  Focus is shown by a brand hairline on the pane's edge (and `aria-current`), not by motion.
-->
<section
  bind:this={host}
  class="pane relative flex min-h-0 min-w-0 flex-1 bg-canvas"
  class:is-focused={focused && total > 1}
  aria-label="Pane {number}{session ? `: ${session.title || 'Untitled'}` : ': new chat'}"
  aria-current={focused && total > 1 ? "true" : undefined}
  data-pane={pane.id}
  onfocusin={() => panes.focus(pane.id)}
  onpointerdown={() => {
    panes.focus(pane.id);
    // The first click after a turn finished: its "done" dot in the sidebar turns "idle".
    if (paneStatus(session, pane) === "done") panes.acknowledge(pane.id);
  }}
>
  <div class="flex min-h-0 min-w-0 flex-1 flex-col">
    {#if session}
      <!--
          The header is the identity plus ONE three-dots button. The grip stays beside it (it is a
          drag target, not a command) and everything else — notes, agents, terminal, split, layout,
          close pane/session, and the app-wide modals — is a row in that one popover.
        -->
      <div class="relative z-30">
        <SessionHeader
          {session}
          ontoggleSidebar={ontogglesidebar}
          rows={paneRows}
          showSidebarToggle={first}
          paneTools={grip}
        />
        <SubagentStrip {session} onopen={openSubagent} />
      </div>

      <!-- The composer has its own row, so expanded drafts never cover the transcript. -->
      <div class="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <div class="relative min-h-0 flex-1">
          <main bind:this={scroller} onscroll={onScroll} class="relative z-0 h-full min-h-0 overflow-y-auto overscroll-contain px-4 py-5 pane-sm:px-3 pane-sm:py-4">
            <!-- Normal flow keeps the final message above the composer at every draft height. -->
            <div class="mx-auto max-w-3xl pb-3">
              {#if !store.hydrated[session.id] && !session.events.length}
                <div class="flex flex-col gap-4 py-2" role="status" aria-label="Loading conversation">
                  <Skeleton class="h-4 w-2/5" />
                  <Skeleton class="h-16 w-full" />
                  <Skeleton class="h-4 w-3/5" />
                  <Skeleton class="h-10 w-full" />
                </div>
              {:else}
                {#key session.id}
                  <Transcript events={session.events} partial={session.partial} onsubmit={(message) => send(message)} />
                {/key}
                {#if !session.events.length}
                  <div class="py-16 text-center">
                    <p class="text-[13px] text-ink-muted">Nothing here yet.</p>
                    <p class="mt-1 text-[12px] text-ink-muted">Send a prompt to start this session.</p>
                  </div>
                {/if}
              {/if}
            </div>
          </main>
          {#if !atBottom && session.events.length}
            <button
              type="button"
              class="absolute bottom-3 left-1/2 z-25 grid size-11 -translate-x-1/2 cursor-pointer place-items-center rounded-full border border-line/60 bg-raised/80 text-ink-muted shadow-[0_8px_24px_-8px_oklch(0_0_0/0.3)] backdrop-blur-md transition-colors duration-(--duration-fast) ease-(--ease-standard) hover:text-ink"
              aria-label="Scroll to the latest message"
              onclick={jumpToLatest}
            >
              <ArrowDown size={18} strokeWidth={2} aria-hidden="true" />
            </button>
          {/if}

          <FloatingMascot id={session.id} docked />
        </div>

        {#if link === "reconnecting" || link === "connecting"}
          <div class="mx-auto mb-2 flex w-full max-w-3xl items-center gap-2 px-4 text-[12.5px] text-ink-muted pane-sm:px-3" role="status">
            <WifiOff size={13} strokeWidth={2} aria-hidden="true" />
            {link === "connecting" ? "Connecting to this session" : "Connection lost. Reconnecting"}<Spinner size={12} label="" />
          </div>
        {:else if session.status === "running"}
          <div class="mx-auto mb-2 w-full max-w-3xl px-4 pane-sm:px-3">
            <PixelLoader label={session.partial?.text ? "Writing" : session.partial?.thinking ? "Thinking" : "Working"} since={session.startedAt} />
          </div>
        {/if}

        <Composer
          bind:this={composer}
          bind:value={pane.prompt}
          bind:chips={pane.chips}
          bind:attachments={pane.attachments}
          draftKey={pane.sessionId ?? ""}
          bind:modelOpen
          running={session.status === "running"}
          {sending}
          model={currentModel}
          {switchingModel}
          {modelNote}
          onsend={send}
          oninterrupt={interrupt}
          onmodel={pickModel}
          memory={pane.memory}
        />
      </div>
    {:else}
      <!-- A new chat. Nothing exists on the server yet: the first message creates the session. -->
      <header class="relative z-30 flex min-h-13 shrink-0 items-center gap-1 border-b border-line/80 px-3.5 py-1.5">
        {#if first}
          <Button variant="ghost" size="icon-sm" icon={PanelLeft} title="Toggle sidebar" aria-label="Toggle sidebar" onclick={ontogglesidebar} />
        {/if}
        <h1 class="min-w-0 flex-1 truncate px-1 text-[13.5px] font-semibold">New chat</h1>
        {#if ondragpane}
          <!-- The grip is a drag target, not a command: it stays in the header, not in the menu. -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <span
            role="button"
            tabindex="0"
            aria-label="Drag pane {number} to swap it with another"
            aria-keyshortcuts="Enter"
            title="Drag to another pane to swap them"
            class="grid size-8 shrink-0 cursor-grab place-items-center rounded-sm text-ink-muted hover:bg-raised hover:text-ink active:cursor-grabbing pointer-coarse:size-11"
            class:is-dragging={dragging}
            data-dragging={dragging ? "true" : undefined}
            onpointerdown={ondragpane}
            onpointermove={ondragmove}
            onpointerup={ondragend}
            onpointercancel={ondragend}
            onkeydown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              onmovepane?.("right");
            }}
          >
            <GripVertical size={14} strokeWidth={1.75} aria-hidden="true" />
          </span>
        {/if}
        <HeaderMenu label="Bot menu" rows={paneRows} />
      </header>

      <div class="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <main class="relative z-0 flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto overscroll-contain px-4 py-8 pane-sm:px-3">
          <div class="enter-3 flex w-full max-w-xl flex-col items-center gap-5 text-center">
            <div class="grid size-11 place-items-center rounded-lg bg-brand text-brand-ink" aria-hidden="true"><SquarePen size={20} strokeWidth={2} /></div>
            <div>
              {#if pane.sessionId}
                <!-- A session this pane shows but this tab has not loaded yet (E52): not a new chat,
                     and the composer below refuses to make it one. -->
                <h2 class="text-[20px] font-semibold tracking-tight pane-xs:text-[17px]">Opening this session…</h2>
                <p class="mt-1.5 text-[13.5px] text-ink-muted">Loading it from the server. It is already there.</p>
              {:else}
                <h2 class="text-[20px] font-semibold tracking-tight pane-xs:text-[17px]">What should we work on?</h2>
                <p class="mt-1.5 text-[13.5px] text-ink-muted">
                  {pane.draft.targetId === "local" ? "Runs on this machine" : `Runs headless on ${store.hosts.find((h) => h.id === pane.draft.targetId)?.label ?? "the remote host"}`},
                  starting in your home folder.
                  The chat starts when you send your first message.
                </p>
              {/if}
            </div>
            {#if pane.sessionId}
              <Skeleton class="h-3 w-28" />
            {:else}
            <ul class="flex flex-wrap justify-center gap-2" aria-label="Starters">
              <li><button type="button" class="starter" onclick={() => { pane.prompt = "/"; pane.chips = []; composer?.focus(); }}><SquareSlash size={14} strokeWidth={1.75} aria-hidden="true" />Commands</button></li>
              <li><button type="button" class="starter" onclick={() => { pane.prompt = "$"; composer?.focus(); }}><Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />Skills</button></li>
              <li><button type="button" class="starter" onclick={() => onapp("resume")}><RotateCcw size={14} strokeWidth={1.75} aria-hidden="true" />Resume a session</button></li>
              <li><button type="button" class="starter" onclick={() => onapp("providers")}>Connect a provider</button></li>
            </ul>
            {/if}
            {#if loading}
              <Skeleton class="h-3 w-28" />
            {:else if store.list.length}
              <p class="tnum text-[12.5px] text-ink-muted">{store.open.length} open · {store.list.length} total</p>
            {/if}
          </div>
        </main>
        <!-- No session yet: the pane's own id picks the pet, stable across visits. -->
        <FloatingMascot id={pane.id} />

        <Composer
          bind:this={composer}
          bind:value={pane.prompt}
          bind:chips={pane.chips}
          bind:attachments={pane.attachments}
          draftKey={pane.sessionId ?? ""}
          bind:modelOpen
          {sending}
          {targets}
          targetId={pane.draft.targetId}
          ontarget={(id) => {
            // Another machine, another file system: a folder picked on one means nothing on the other.
            if (id !== pane.draft.targetId) pane.draft.cwd = "";
            pane.draft.targetId = id;
          }}
          model={currentModel}
          {modelNote}
          floating
          onsend={send}
          oninterrupt={interrupt}
          onmodel={pickModel}
          memory={pane.memory}
        />
      </div>
    {/if}
  </div>

  {#if pane.notesOpen}
    <!--
      The notes sidebar sits on the pane's right. In a wide pane it is a column beside the chat; in a
      narrow one it covers the chat (the chat is still one tap away), since two squeezed columns are
      worse than one full one.
    -->
    <div
      class="notes-slot flex min-h-0 shrink-0 flex-col border-l border-line/80 bg-surface"
      class:is-terminal={pane.sideTab === "terminal"}
      class:is-agents={pane.sideTab === "agents"}
      style={sideWidthStyle(pane.sideWidth)}
    >
      <!-- Two tabs, one panel: Notes and Terminal. Arrow keys move between them (roving tabindex). -->
      <div class="flex shrink-0 items-center gap-0.5 border-b border-line/80 px-1.5 pt-1" role="tablist" aria-label="Side panel">
        {#each [{ id: "notes", label: "Notes", icon: NotebookPen }, { id: "agents", label: "Agents", icon: Network }, { id: "terminal", label: "Terminal", icon: SquareTerminal }] as tab (tab.id)}
          {@const Icon = tab.icon}
          <button
            type="button"
            role="tab"
            id="{pane.id}-side-{tab.id}"
            aria-selected={pane.sideTab === tab.id}
            aria-controls="{pane.id}-side-panel"
            tabindex={pane.sideTab === tab.id ? 0 : -1}
            class="interactive -mb-px flex min-h-9 cursor-pointer items-center gap-1.5 border-b-2 px-2.5 text-[12.5px] font-medium pointer-coarse:min-h-11
              {pane.sideTab === tab.id ? 'border-brand text-ink' : 'border-transparent text-ink-muted hover:text-ink'}"
            onclick={() => panes.toggleSide(pane.id, tab.id as SideTab, true)}
            onkeydown={(e) => {
              if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
              e.preventDefault();
              const order: SideTab[] = ["notes", "agents", "terminal"];
              const at = order.indexOf(pane.sideTab);
              const next = order[(at + (e.key === "ArrowRight" ? 1 : order.length - 1)) % order.length]!;
              panes.toggleSide(pane.id, next, true);
              void tick().then(() => document.getElementById(`${pane.id}-side-${next}`)?.focus());
            }}
          ><Icon size={13} strokeWidth={1.75} aria-hidden="true" />{tab.label}</button>
        {/each}
      </div>
      <div id="{pane.id}-side-panel" role="tabpanel" aria-labelledby="{pane.id}-side-{pane.sideTab}" class="flex min-h-0 flex-1 flex-col">
        {#if pane.sideTab === "terminal"}
          {#await TerminalPanel()}
            <div class="flex flex-1 items-center justify-center gap-2 text-[12px] text-ink-muted" role="status"><Spinner size={12} label="" />Loading the terminal</div>
          {:then mod}
            <mod.default bind:this={terminal} paneId={pane.id} sessionId={session?.id ?? null} title={session?.cwd ?? ""} onclose={() => panes.toggleSide(pane.id, "terminal", false)} />
          {:catch}
            <div class="m-3 rounded-md bg-err/10 px-3 py-2 text-[12px] text-err" role="alert">Could not load the terminal. Reload the page and try again.</div>
          {/await}
        {:else if pane.sideTab === "agents"}
          {#await AgentsPanel()}
            <div class="flex flex-1 items-center justify-center gap-2 text-[12px] text-ink-muted" role="status"><Spinner size={12} label="" />Loading the agents panel</div>
          {:then mod}
            <mod.default bind:this={agentsPanel} sessionId={session?.id ?? null} onopen={openSubagent} onclose={() => panes.toggleSide(pane.id, "agents", false)} />
          {:catch}
            <div class="m-3 rounded-md bg-err/10 px-3 py-2 text-[12px] text-err" role="alert">Could not load the agents panel. Reload the page and try again.</div>
          {/await}
        {:else}
          {#await NotesPanel()}
            <div class="flex flex-1 items-center justify-center gap-2 text-[12px] text-ink-muted" role="status"><Spinner size={12} label="" />Loading the notes</div>
          {:then mod}
            <mod.default
              bind:this={notes}
              noteId={session?.id ?? null}
              title={session?.title ?? ""}
              onclose={() => panes.toggleNotes(pane.id, false)}
              width={pane.sideWidth}
              onresize={(px) => panes.setSideWidth(pane.id, px)}
              onreset={() => panes.resetSideWidth(pane.id)}
              {paneLeft}
            />
          {:catch}
            <div class="m-3 rounded-md bg-err/10 px-3 py-2 text-[12px] text-err" role="alert">Could not load the notes. Reload the page and try again.</div>
          {/await}
        {/if}
      </div>
    </div>
  {/if}

  <!-- One image viewer per pane: opened from any bubble's inline image above. -->
  <Lightbox />
</section>

<style>
  .pane {
    container: pane / inline-size;
  }
  /* Focus in a split layout: a brand hairline inside the pane's top edge, plus aria-current. */
  .pane.is-focused::after {
    content: "";
    position: absolute;
    inset: 0 0 auto 0;
    height: 2px;
    background: var(--color-brand);
    z-index: 35;
    pointer-events: none;
  }
  .notes-slot {
    /* The width the user dragged the panel to, else the panel's own default. */
    width: var(--side-w, clamp(16rem, 32%, 24rem));
  }
  /* The agent tree and its message timeline need room: wider than notes, unless dragged. */
  .notes-slot.is-agents {
    width: var(--side-w, clamp(20rem, 38%, 30rem));
  }
  /* A terminal needs columns: the sidebar is wider while it shows one. */
  .notes-slot.is-terminal {
    width: clamp(20rem, 44%, 40rem);
  }
  /* Both overrides below must list EVERY variant. They did not: `is-agents` was missing, and its
     own rule (`width: clamp(20rem, 38%, 30rem)`) is the more specific selector, so it kept winning
     and the agents panel stayed 320px wide over a 390px phone — 82% of the screen, with the chat
     and the composer pill left under it. A selector that is not in the list never gets overridden. */
  @container pane (width < 44rem) {
    .notes-slot,
    .notes-slot.is-agents,
    .notes-slot.is-terminal {
      position: absolute;
      inset: 0 0 0 auto;
      width: min(100%, 24rem);
      z-index: 36;
      box-shadow: -12px 0 32px -12px oklch(0 0 0 / 0.35);
    }
    /* A terminal wants every column it can get: in a narrow pane it takes the whole pane. */
    .notes-slot.is-terminal {
      width: 100%;
      border-left: 0;
    }
  }
  @container pane (width < 26rem) {
    .notes-slot,
    .notes-slot.is-agents,
    .notes-slot.is-terminal {
      width: 100%;
      border-left: 0;
    }
  }
  .starter {
    display: inline-flex;
    min-height: 2.25rem;
    cursor: pointer;
    align-items: center;
    gap: 0.375rem;
    border-radius: var(--radius-md);
    border: 1px solid var(--color-line);
    padding: 0 0.75rem;
    font-size: 12.5px;
    color: var(--color-ink-muted);
    transition-property: background-color, color, scale;
    transition-duration: 150ms;
    transition-timing-function: cubic-bezier(0.2, 0, 0, 1);
  }
  .starter:hover {
    background: var(--color-raised);
    color: var(--color-ink);
  }
  .starter:active {
    scale: 0.96;
  }
  @media (pointer: coarse) {
    .starter {
      min-height: 2.75rem;
    }
  }
</style>
