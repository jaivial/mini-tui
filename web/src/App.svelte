<script lang="ts">
  import { tick, untrack } from "svelte";
  import { Plus, X, CalendarClock, Network, Server, Settings, RotateCcw, Keyboard } from "@lucide/svelte";
  import SessionSidebar from "./lib/components/SessionSidebar.svelte";
  import { findToggle, focusableWithin, nextStop } from "./lib/drawerModal";
  import ChatPane from "./lib/components/ChatPane.svelte";
  import PaneTree from "./lib/components/PaneTree.svelte";
  import Toasts from "./lib/components/Toasts.svelte";
  import type { MenuRow } from "./lib/components/HeaderMenu.svelte";
  import { history, sidebarHistory } from "./lib/stores/history.svelte";
  import { folderStore } from "./lib/stores/folders.svelte";
  import { catalog } from "./lib/stores/catalog.svelte";
  import { store } from "./lib/stores/sessions.svelte";
  import { panes } from "./lib/stores/panes.svelte";
  import { unknown } from "./lib/unknownSessions";
  import { agentTree } from "./lib/stores/agentTree.svelte";
  import { paneStatus } from "./lib/paneStatus";
  import { ui } from "./lib/stores/ui.svelte";
  import { tasks } from "./lib/stores/tasks.svelte";
  import { plans } from "./lib/stores/plans.svelte";
  import { hub } from "./lib/hub";
  import { toasts } from "./lib/stores/toast.svelte";
  import { api } from "./lib/api";
  import { MAX_PANES, roomToSplit, type Dir } from "./lib/panes";
  import { paneAt, type MoveDir, type Shape } from "./lib/paneLayout";
  import { TEXT_SCALES, UI_SCALES, percent, stepScale } from "./lib/scale";
  import type { HistoryItem } from "./lib/types";
  import { boardRows, type TaskWhere } from "./lib/tasks";
  import type { SessionPlan, SessionTask } from "./lib/types";
  import { FinishWatcher, finishMessage } from "./lib/finish";

  /**
   * The shell: sessions sidebar, the panes, and the app-wide panels. Each pane is a whole chat
   * (`ChatPane`); this file only lays them out, routes app-wide actions and owns the shortcuts.
   *
   * Wide screens split panes side by side / stacked, tmux style. Below `TABS` the screen is too small
   * for two readable chats, so the same panes become tabs, one on screen at a time: nothing is lost
   * when a window is narrowed, and a split layout comes back when it widens again.
   */
  const NARROW = 900;
  const TABS = 760;
  /** The smallest a pane may be split to: below this a chat and its prompt bar stop being usable. */
  const MIN_PANE = { w: 340, h: 280 };

  let narrow = $state(false);
  let tabbed = $state(false);
  let sidebarOpen = $state(true);
  // Desktop sidebar width, dragged by the rail's right edge. Only a floor: the user may take all the width they want.
  const SIDEBAR_KEY = "mini-tui.sidebarW";
  let sidebarW = $state(Number(localStorage.getItem(SIDEBAR_KEY)) || 288);
  function startResize(e: PointerEvent) {
    e.preventDefault();
    const startX = e.clientX, startW = sidebarW;
    // Pointer deltas are screen pixels; the width is CSS pixels, which the interface size setting scales.
    const k = ui.appliedUiScale || 1;
    const move = (m: PointerEvent) => { sidebarW = Math.max(200, Math.min(window.innerWidth / k - 60, startW + (m.clientX - startX) / k)); };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      localStorage.setItem(SIDEBAR_KEY, String(Math.round(sidebarW)));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  let layout = $state<HTMLElement | null>(null);
  let layoutW = $state(0);
  let layoutH = $state(0);

  $effect(() => {
    // Media queries see CSS pixels of the window, before the app's own zoom: divide it back out, so
    // at 140% interface size a 1000px window behaves like the ~714px one it now looks like.
    const apply = () => {
      const w = window.innerWidth / ui.appliedUiScale;
      const wasNarrow = narrow;
      narrow = w <= NARROW;
      tabbed = w <= TABS;
      if (narrow !== wasNarrow || !untrack(() => layoutW)) sidebarOpen = !narrow;
    };
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  });

  // The layout's size in the app's own (zoomed) pixels, for "is there room to split this pane?".
  $effect(() => {
    if (!layout) return;
    const ro = new ResizeObserver(() => {
      layoutW = layout!.clientWidth;
      layoutH = layout!.clientHeight;
    });
    ro.observe(layout);
    return () => ro.disconnect();
  });

  let hostsOpen = $state(false);
  /** The window's task board (every session's task card), in its drawer on the right. */
  let tasksOpen = $state(false);
  let teamMapOpen = $state(false);
  /** The board as the hub last pushed it. The watch below keeps this reactive copy fresh. */
  let taskCards = $state<SessionTask[]>([]);
  let planList = $state<SessionPlan[]>([]);
  let tasksLive = $state(false);
  let settingsOpen = $state(false);
  let settingsTab = $state("general");
  let helpOpen = $state(false);
  let resumeOpen = $state(false);
  let openingId = $state("");

  // The modals are code-split and imported the first time each is opened (the Team map drags
  // @xyflow/svelte, ~216 kB with its CSS, that no boot needs). Holders stay null until then,
  // which keeps the `{#if}` render sites honest: nothing mounts before its chunk arrives.
  type ModalOf<T> = T extends { default: infer C } ? C : never;
  // The routines drawer is code-split for the same reason (E28): the board, the queue and the
  // channels are 8 KB of gzip that a visit which never opens the drawer has no use for. Unlike the
  // chunk itself, the holder never goes back to null — TasksPanel latches its board with `seen` so
  // that reopening it does not rebuild every card, and unmounting would throw that away.
  let TasksPanel = $state<ModalOf<typeof import("./lib/components/TasksPanel.svelte")> | null>(null);
  let TeamMapModal = $state<ModalOf<typeof import("./lib/components/TeamMapModal.svelte")> | null>(null);
  let RemoteHostsModal = $state<ModalOf<typeof import("./lib/components/RemoteHostsModal.svelte")> | null>(null);
  let SettingsModal = $state<ModalOf<typeof import("./lib/components/SettingsModal.svelte")> | null>(null);
  let HelpModal = $state<ModalOf<typeof import("./lib/components/HelpModal.svelte")> | null>(null);
  let ResumeModal = $state<ModalOf<typeof import("./lib/components/ResumeModal.svelte")> | null>(null);
  $effect(() => {
    // Load on first open, and once more on demand if a later open races the fetch.
    if (tasksOpen && !TasksPanel) void import("./lib/components/TasksPanel.svelte").then((m) => (TasksPanel = m.default));
    if (teamMapOpen && !TeamMapModal) void import("./lib/components/TeamMapModal.svelte").then((m) => (TeamMapModal = m.default));
    if (hostsOpen && !RemoteHostsModal) void import("./lib/components/RemoteHostsModal.svelte").then((m) => (RemoteHostsModal = m.default));
    if (settingsOpen && !SettingsModal) void import("./lib/components/SettingsModal.svelte").then((m) => (SettingsModal = m.default));
    if (helpOpen && !HelpModal) void import("./lib/components/HelpModal.svelte").then((m) => (HelpModal = m.default));
    if (resumeOpen && !ResumeModal) void import("./lib/components/ResumeModal.svelte").then((m) => (ResumeModal = m.default));
  });
  let loading = $state(true);
  const refs: Record<string, { focusComposer: () => void; focusNotes: () => void; focusTerminal: () => void } | undefined> = $state({});

  $effect(() => {
    untrack(() => void catalog.warm());
    // Skills added on disk while the page was in the background show up when you come back.
    const onVisible = () => {
      if (document.visibilityState === "visible") catalog.refreshSkills();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  });

  // Once per page: connect and load. Only the load itself is reactive; everything below it is read
// under `untrack`, so a state change elsewhere never drops the session sockets and reloads the list.
  $effect(() => {
    // The task board is watched for as long as the app is open: the header menu glances at it and
    // the panel opens it, and both must show what the agents last wrote, at once.
    const unwatch = tasks.watch((list) => (taskCards = list));
    const unplan = plans.watch((list) => (planList = list));
    const unhub = hub.onState((s) => (tasksLive = s === "live"));
    untrack(() => {
    store.connect();
    store
      .load()
      .then(() => askUnknown())
      .then(() => {
        // First visit (no saved layout): open the latest session, as the app always has.
        if (!panes.restored && !panes.focused.sessionId) {
          const first = store.list.find((s) => !s.parentId && !s.id.includes("~"));
          if (first) panes.show(panes.focusedId, first.id);
        }
      })
      .catch((error) => toasts.push("Could not reach the mini-tui server", { detail: (error as Error).message, tone: "err" }))
      .finally(() => (loading = false));
    });
    return () => {
      unwatch();
      unplan();
      unhub();
      store.close();
    };
  });

  // Each pane streams its own session over its own socket; the focused one is also "active".
  $effect(() => {
    store.setVisible(tabbed ? [panes.focused.sessionId].filter((s): s is string => !!s).concat(panes.shown) : panes.shown);
    store.setActive(panes.focused.sessionId);
  });

  /**
   * The sessions a pane shows that this tab has not loaded, asked about instead of guessed (E52).
   * "Not in my list" is not "it is gone": the workspace is shared with every tab and device, and
   * another one can open a saved session from the Resume panel that this tab has never heard of.
   * Only the server's "I do not hold it" (404) turns a pane into a new chat — an idle tab used to
   * clear the pane and write that back ~20 ms later, undoing the click in the tab that made it.
   */
  /** A question that proved nothing is asked again (see `done`); this is the nudge. */
  let askTick = $state(0);
  function askUnknown(): Promise<string[]> {
    const ask = unknown.pick(panes.shown, (id) => !!store.sessions[id]);
    const done = (gone: string[]): string[] => {
      unknown.answer(ask, gone);
      // The sweep runs every time, not only when this question found something: a pane can start
      // showing an id this tab already learned is gone (a window coming back from the shelf, another
      // tab's click), and then there is no question left to ask — only the verdict to apply. A
      // session this tab holds is never swept, whatever a stale verdict says.
      panes.forgetMissing((id) => !!store.sessions[id] || !unknown.isGone(id));
      // An answer that proved nothing (the server busy, the network, a promise that rejected) frees
      // its ids: ask again in a little while instead of leaving the pane blank for good (E52).
      if (ask.some((id) => !unknown.isGone(id) && !store.sessions[id])) setTimeout(() => (askTick += 1), 5_000);
      return gone;
    };
    // A rejected restore is a question with no answer, not a lost one: `done` frees its ids.
    return ask.length ? store.restore(ask).then(done, () => done([])) : Promise.resolve(done([]));
  }

  // A session the server no longer holds (deleted, or closed from another tab) leaves its pane as a
  // new chat; one this tab merely has not loaded is asked about, above.
  $effect(() => {
    void askTick;
    const ids = panes.shown;
    // Every key is read (`filter`, not `some`): Svelte tracks `$state` reads per key, and a
    // short-circuit never subscribes the ids behind the first unknown one.
    const missing = ids.filter((id) => !store.sessions[id]);
    if (loading || !missing.length) return;
    untrack(() => void askUnknown());
  });

  // ---- "Session finished" toasts, with View to open it.
  const finishes = new FinishWatcher();
  // Every running turn is noted on the panes that show it, so its finish can show as "done" on the
  // window rows' dots (in this window or another) until that pane is clicked.
  $effect(() => {
    for (const s of Object.values(store.sessions)) if (s.status === "running") untrack(() => panes.noteRunning(s.id, s.startedAt));
  });
  $effect(() => {
    for (const s of Object.values(store.sessions)) {
      const finish = finishes.observe(s.id, s.status, s.startedAt);
      if (!finish) continue;
      untrack(() => announceFinish(finish.id, finish.status));
    }
  });

  /**
   * A finish is announced unless you are already looking at it: the session in the focused pane, with
   * the tab visible. A session in another pane is still announced (you may be typing elsewhere).
   */
  function announceFinish(id: string, status: "done" | "error" | "interrupted") {
    const session = store.sessions[id];
    if (!session) return;
    const watching = panes.focused.sessionId === id && document.visibilityState === "visible";
    if (watching) return;
    const msg = finishMessage(status, session.title, session.exitStatus);
    if (!msg) return;
    toasts.push(msg.title, { detail: msg.detail, tone: msg.tone, action: { label: "View", run: () => view(id) } });
  }

  /** View: show the session in a pane (the one already showing it, else the focused pane) and focus it. */
  function view(id: string) {
    if (!store.sessions[id]) return;
    const target = panes.show(panes.paneOf(id)?.id ?? panes.focusedId, id);
    if (narrow) sidebarOpen = false;
    void tick().then(() => refs[target]?.focusComposer());
  }

  const canSplit = (paneId: string, dir: Dir) => panes.canSplit && (tabbed || roomToSplit(panes.tree, paneId, dir, layoutW, layoutH, MIN_PANE));
  /**
   * Rearranging panes is judged by the space the layout is really drawn at: a pane at the left edge of
   * a narrow window has nothing to trade places with, and the menu row then says so. In the tabbed
   * layout (below 760px) one pane is on screen at a time, so there is nothing to rearrange.
   */
  const canMovePane = (paneId: string, dir: MoveDir) => !tabbed && panes.canMove(paneId, dir, layoutW, layoutH);
  const paneMoves = (paneId: string): Record<MoveDir, boolean> => ({ left: canMovePane(paneId, "left"), right: canMovePane(paneId, "right"), up: canMovePane(paneId, "up"), down: canMovePane(paneId, "down") });
  const paneLayouts = $derived<Record<Shape, boolean>>({ row: panes.canArrange("row"), col: panes.canArrange("col"), grid: panes.canArrange("grid") });
  /** Move a pane one place, then keep the keyboard where the pane it became is. */
  function movePaneDir(paneId: string, dir: MoveDir) {
    if (!panes.move(paneId, dir, layoutW, layoutH)) return;
    void tick().then(() => refs[panes.focusedId]?.focusComposer());
  }
  /** A whole new shape for the panes of this window, with the reason when it cannot happen. */
  function arrange(shape: Shape) {
    if (!panes.arrange(shape)) toasts.push("Nothing to rearrange", { detail: shape === "grid" ? "A grid needs 4 panes." : "A second pane to lay out.", tone: "info" });
    else void tick().then(() => refs[panes.focusedId]?.focusComposer());
  }
  /**
   * Dragging a pane. Pointer events, not the HTML5 drag: they work the same under a finger, and they
   * can be driven by a test. While the pointer is down and has left the grip, the pane it is over is
   * the drop target; letting go trades the two, if it is another pane.
   */
  let dragFrom = $state("");
  let dragTarget = $state("");
  /**
   * The phone drawer. It covers the whole screen, so it behaves as the modal it is: Escape closes
   * it, Tab stays inside it, and the page behind is inert. See `lib/drawerModal.ts` for why each of
   * those is needed and what the rules are.
   */
  let drawer: HTMLElement | null = $state(null);

  /** Where a phone swipe that should dismiss the full-screen bots list started. */
  let swipeFrom: { x: number; y: number } | null = null;

  /*
   * Opening the drawer moves focus into it. The toggle that opened it is in the header, which the
   * drawer now covers, so leaving focus there would put the keyboard on an invisible control.
   */
  $effect(() => {
    if (!sidebarOpen || !narrow || !drawer) return;
    focusableWithin(drawer)[0]?.focus();
  });

  function dragStart(paneId: string, event: PointerEvent) {
    if (event.button !== 0 || tabbed || panes.count < 2) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    dragFrom = paneId;
    panes.focus(paneId);
    trackDrag(event);
  }
  function trackDrag(event: PointerEvent) {
    if (!dragFrom || !layout) return;
    dragTarget = paneAt(event.clientX, event.clientY, layout);
  }
  function dragEnd(event: PointerEvent) {
    if (!dragFrom) return;
    const onto = dragTarget;
    const from = dragFrom;
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    dragFrom = dragTarget = "";
    if (!onto || onto === from || !panes.drop(from, onto)) return;
    void tick().then(() => refs[panes.focusedId]?.focusComposer());
  }
  function split(paneId: string, dir: Dir) {
    if (!panes.canSplit) {
      toasts.push(`At most ${MAX_PANES} panes`, { detail: "Close one to open another.", tone: "info" });
      return;
    }
    if (!canSplit(paneId, dir)) {
      toasts.push(dir === "row" ? "Not enough room to split right" : "Not enough room to split down", {
        detail: "Widen the window, hide the sidebar, or use a smaller interface size.",
        tone: "info",
      });
      return;
    }
    const fresh = panes.split(paneId, dir);
    if (fresh) void tick().then(() => refs[fresh]?.focusComposer());
  }

  function closePane(paneId: string) {
    if (!panes.close(paneId)) return;
    queueMicrotask(() => refs[panes.focusedId]?.focusComposer());
  }

  /** Sidebar click: show it in the focused pane, or focus the pane already showing it. */
  function openInFocused(sessionId: string) {
    const target = panes.show(panes.focusedId, sessionId);
    if (narrow) sidebarOpen = false;
    queueMicrotask(() => refs[target]?.focusComposer());
  }

  function newChat() {
    panes.show(panes.focusedId, null);
    if (narrow) sidebarOpen = false;
    queueMicrotask(() => refs[panes.focusedId]?.focusComposer());
  }

  async function resume(item: HistoryItem) {
    if (openingId) return;
    if (store.sessions[item.id]) {
      openInFocused(item.id);
      resumeOpen = false;
      return;
    }
    openingId = item.id;
    try {
      const session = await api.openHistory(item.id);
      store.adopt(session);
      history.markOpen(item.id, true);
      resumeOpen = false;
      openInFocused(session.id);
    } catch (error) {
      toasts.push("Could not open that session", { detail: (error as Error).message, tone: "err" });
      void history.load(history.query);
    } finally {
      openingId = "";
    }
  }

  async function deleteSaved(item: HistoryItem) {
    try {
      await api.deleteHistory(item.id);
      store.remove(item.id);
      history.remove(item.id);
      sidebarHistory.remove(item.id);
      folderStore.remove(item.id);
      void folderStore.refresh();
      panes.forgetMissing((id) => id !== item.id);
      toasts.push(`Deleted “${item.title}”`, { tone: "info" });
    } catch (error) {
      toasts.push("Could not delete it", { detail: (error as Error).message, tone: "err" });
      throw error;
    }
  }

  async function closeSession(id: string) {
    await api.close(id).catch(() => {});
    store.remove(id);
    panes.forgetMissing((sid) => sid !== id);
  }

  /** v5-A: rename a session from the sidebar (double-click or the row's pencil).
   * Optimistic — the row shows the new name at once; a refusal reverts and says so. */
  async function renameBot(id: string, title: string) {
    const before = store.sessions[id];
    if (!before) return;
    store.sessions[id] = { ...before, title };
    try {
      await api.setTitle(id, title);
    } catch (error) {
      store.sessions[id] = before;
      toasts.push("Could not rename it", { detail: (error as Error).message, tone: "err" });
    }
  }

  function app(action: "settings" | "providers" | "skills" | "resume" | "help" | "hosts") {
    if (action === "resume") resumeOpen = true;
    else if (action === "help") helpOpen = true;
    else if (action === "hosts") hostsOpen = true;
    else {
      settingsTab = action === "settings" ? "general" : action;
      settingsOpen = true;
    }
  }

  const paneLabel = (id: string) => {
    const s = panes.panes[id]?.sessionId;
    return `pane ${panes.numberOf(id)}${s && store.sessions[s] ? ` (${store.sessions[s]!.title || "Untitled"})` : ""}`;
  };
  /**
   * Where a session is on screen, for the task board: the pane showing it (its number in the
   * reading order). Null when no pane shows the session. The window is gone from the UI as of v6,
   * so a row no longer names one — the pane is what you actually see.
   */
  const whereOf = (id: string): TaskWhere | null => {
    const pane = panes.paneOf(id);
    if (!pane) return null;
    return { pane: panes.numberOf(pane.id) };
  };
  /** The task board's rows: every session with a task card, with where it lives on screen. */
  const taskRows = $derived(boardRows(taskCards, (id) => store.sessions[id]?.title ?? "", whereOf));

  /**
   * The app-wide rows of the header's three-dots popover — what the sidebar's footer used to own
   * (Routines, Team map, hosts, settings) plus Resume and Help. One list, one menu: the pane's own
   * rows are built in ChatPane and these are appended to them.
   */
  const appRows = $derived.by((): MenuRow[] => [
    { id: "routines", label: "Routines", note: taskCards.length ? `${taskCards.length} task ${taskCards.length === 1 ? "card" : "cards"}` : "No task cards yet", icon: CalendarClock, group: "Workspace", run: () => (tasksOpen = true) },
    { id: "team", label: "Team map", note: liveTeam ? `${liveTeam} working` : "The delegation graph", icon: Network, group: "Workspace", run: () => (teamMapOpen = true) },
    { id: "hosts", label: "Remote hosts", note: hostsNote(), icon: Server, group: "Workspace", run: () => (hostsOpen = true) },
    { id: "resume", label: "Resume a session", note: "Every saved session, searchable", icon: RotateCcw, group: "Workspace", run: () => (resumeOpen = true) },
    { id: "settings", label: "Settings", note: "Ctrl/⌘ ,", icon: Settings, group: "Workspace", run: () => app("settings") },
    { id: "help", label: "Keyboard & help", note: "Shortcuts and commands", icon: Keyboard, group: "Workspace", run: () => (helpOpen = true) },
  ]);
  const hostsNote = () => {
    const on = store.hosts.filter((h) => h.online).length;
    return store.hosts.length ? `${on} of ${store.hosts.length} online` : "None connected";
  };
  /** Delegates working anywhere in the team: the Team map row's pulse. */
  const liveTeam = $derived(Object.values(agentTree.trees).reduce((n, t) => n + t.live, 0));

  function scaleBy(dir: 1 | -1, text: boolean) {
    if (text) ui.setTextScale(stepScale(ui.textScale, dir, TEXT_SCALES));
    else ui.setUiScale(stepScale(ui.uiScale, dir, UI_SCALES));
    toasts.push(text ? `Text size ${percent(ui.textScale)}` : `Interface size ${percent(ui.uiScale)}`, { tone: "info" });
  }

  /**
   * Shortcuts. Ctrl/Cmd+K new chat (in the focused pane), Ctrl/Cmd+, settings, Ctrl/Cmd+B sidebar,
   * Ctrl+\ split right, Ctrl+Shift+\ split down, Alt+X close pane, Alt+1..9 and 0, or Ctrl/Cmd+Alt+arrows,
   * move between panes, Ctrl/Cmd+Shift+. notes, Ctrl/Cmd+= / - / 0 interface size (with Shift: text).
   * None of them collide with typing: every one needs Ctrl, Cmd or Alt.
   */
  function onkey(event: KeyboardEvent) {
    handleKey(event);
    // A shortcut the app took is finished here. Letting it travel on would hand it to the field it
    // came from, which a split or a window switch may have just unmounted: that field then reads its
    // own state after being destroyed (Svelte's "derived_inert": stale values).
    if (event.defaultPrevented) event.stopPropagation();
  }

  /**
   * Close the phone drawer and hand focus back to the control that opened it.
   *
   * The toggle is named, not remembered: focusing "whatever had focus before" would put the keyboard
   * back on the chat the drawer was covering, which is where the user just came from and does not
   * expect to be returned to.
   */
  function closeDrawer() {
    if (!sidebarOpen) return;
    sidebarOpen = false;
    queueMicrotask(() => { if (layout) findToggle(layout)?.focus(); });
  }

  function handleKey(event: KeyboardEvent) {
    const mod = event.metaKey || event.ctrlKey;
    // Inside the terminal, the shell owns Ctrl+letters (Ctrl+K kills a line, Ctrl+B moves back...):
    // only the pane shortcuts that cannot mean anything to a shell (Ctrl+`, Alt+digit, Ctrl+Alt+arrows,
    // Ctrl+\ is SIGQUIT so it is left alone too) reach the app from there.
    if ((event.target as HTMLElement | null)?.closest?.(".xterm")) {
      const paneKey = (event.ctrlKey && event.code === "Backquote") || (event.altKey && !mod && /^Digit([1-9]|0)$/.test(event.code)) || (mod && event.altKey && event.key.startsWith("Arrow"));
      if (!paneKey) return;
    }
    const key = event.key;
    const code = event.code;
    if (sidebarOpen && narrow && key === "Escape") {
      // A full-screen sheet with no keyboard way out is a trap: Escape is the one close every modal
      // is expected to have. It runs before the pane shortcuts so it always wins while it is up.
      event.preventDefault();
      closeDrawer();
    } else if (sidebarOpen && narrow && code === "Tab" && drawer) {
      // Tab has to walk the drawer's own controls and come back round. Letting it continue would
      // step into the chat painted behind the sheet: real stops, zero pixels, so the keyboard cursor
      // vanishes and Enter presses something nobody can see.
      const stop = nextStop(focusableWithin(drawer), event.target as Element | null, event.shiftKey);
      if (!stop) return;
      event.preventDefault();
      stop.focus();
    } else if (mod && !event.altKey && key.toLowerCase() === "k") {
      event.preventDefault();
      newChat();
    } else if (mod && key === ",") {
      event.preventDefault();
      app("settings");
    } else if (mod && !event.shiftKey && key.toLowerCase() === "b") {
      event.preventDefault();
      sidebarOpen = !sidebarOpen;
    } else if (event.ctrlKey && code === "Backslash") {
      event.preventDefault();
      split(panes.focusedId, event.shiftKey ? "col" : "row");
    } else if (event.altKey && !mod && code === "KeyX") {
      event.preventDefault();
      closePane(panes.focusedId);
    } else if (event.altKey && !mod && /^Digit([1-9]|0)$/.test(code)) {
      const n = code === "Digit0" ? 10 : Number(code.slice(5));
      const id = panes.order[n - 1];
      if (id) {
        event.preventDefault();
        panes.focus(id);
        refs[id]?.focusComposer();
      }
    } else if (mod && event.altKey && (key === "ArrowRight" || key === "ArrowDown" || key === "ArrowLeft" || key === "ArrowUp")) {
      event.preventDefault();
      panes.cycle(key === "ArrowRight" || key === "ArrowDown" ? 1 : -1);
      refs[panes.focusedId]?.focusComposer();
    } else if (event.ctrlKey && !event.metaKey && code === "Backquote") {
      // Ctrl+` (as in VS Code): the pane's terminal. Handled here, before xterm, so it also closes it.
      event.preventDefault();
      refs[panes.focusedId]?.focusTerminal();
    } else if (mod && event.shiftKey && code === "Period") {
      event.preventDefault();
      const p = panes.focused;
      panes.toggleNotes(p.id);
      if (p.notesOpen) void tick().then(() => refs[p.id]?.focusNotes());
    } else if (mod && !event.altKey && (code === "Equal" || code === "NumpadAdd" || code === "Minus" || code === "NumpadSubtract" || code === "Digit0" || code === "Numpad0")) {
      // The app's own zoom, so the browser's does not also stack on top of it.
      event.preventDefault();
      if (code === "Digit0" || code === "Numpad0") {
        if (event.shiftKey) ui.setTextScale(1);
        else ui.setUiScale(1);
        toasts.push(event.shiftKey ? "Text size 100%" : "Interface size 100%", { tone: "info" });
      } else scaleBy(code === "Equal" || code === "NumpadAdd" ? 1 : -1, event.shiftKey);
    }
  }
</script>

<!-- Capture phase: app shortcuts win over a focused terminal, which would otherwise take every key. -->
<svelte:window onkeydowncapture={onkey} />

<div class="relative flex h-full w-full overflow-hidden bg-canvas text-ink">
  <!--
    The phone drawer IS the screen (v6), so there is no backdrop to press: it sits behind a
    full-width rail at a higher z-index and nothing of it can ever be hit. The swipe that lived on
    it has been on the rail itself since, and Escape now closes it for the keyboard (see
    `lib/drawerModal.ts`). What is left of the old backdrop is nothing to render.
  -->
  {#if sidebarOpen}
    <div
      bind:this={drawer}
      class="enter-1 {narrow ? 'absolute inset-0 z-50' : 'relative z-10 shrink-0'}"
      style={narrow ? undefined : `width:${sidebarW}px`}
      role={narrow ? "dialog" : undefined}
      aria-modal={narrow ? "true" : undefined}
      aria-label={narrow ? "Bots" : undefined}
      onpointerdown={(e) => narrow && (swipeFrom = { x: e.clientX, y: e.clientY })}
      onpointerup={(e) => {
        const from = swipeFrom;
        swipeFrom = null;
        // A swipe down or right from anywhere over the rail closes it, like a sheet. It rides on the
        // rail because on a phone the rail is the screen: a backdrop behind it is unreachable.
        if (narrow && from && (e.clientY - from.y > 64 || e.clientX - from.x > 64)) closeDrawer();
      }}
    >
      <SessionSidebar
        full={narrow}
        onnew={newChat}
        onclosesession={closeSession}
        onhidesidebar={() => (sidebarOpen = false)}
        onopen={openInFocused}
        onrenamebot={(id, title) => renameBot(id, title)}
        {openingId}
        taskCards={taskCards}
        paneOf={(id) => {
          const p = panes.paneOf(id);
          return p ? panes.numberOf(p.id) : 0;
        }}
        focusedSession={panes.focused.sessionId}
        {loading}
      />
      {#if !narrow}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_noninteractive_element_interactions -->
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          class="absolute inset-y-0 -right-1 z-40 w-2 cursor-col-resize hover:bg-[var(--accent,#6aa)]/30 active:bg-[var(--accent,#6aa)]/40"
          onpointerdown={startResize}
          ondblclick={() => { sidebarW = 288; localStorage.setItem(SIDEBAR_KEY, "288"); }}
        ></div>
      {/if}
    </div>
  {/if}

  <!--
    Inert, not just unpainted. The drawer covers this, so its stops are still focusable and still
    clickable underneath: without `inert` a screen reader reads the conversation the sheet is hiding
    and the keyboard walks into it (the Tab loop above stops that for keys, not for a reader).
  -->
  <div class="flex min-w-0 flex-1 flex-col pt-[env(safe-area-inset-top)]" inert={sidebarOpen && narrow}>
    {#if tabbed && panes.count > 1}
      <!-- Narrow screens: the panes are tabs. Same panes, same order, same numbers as the split view. -->
      <div class="flex shrink-0 items-center gap-1 border-b border-line/80 px-2 py-1.5">
      <div class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overscroll-x-contain [scrollbar-width:none]" role="tablist" aria-label="Panes">
        {#each panes.order as id, i (id)}
          {@const sid = panes.panes[id]?.sessionId}
          {@const s = sid ? store.sessions[sid] : null}
          <div class="flex shrink-0 items-center rounded-md {panes.focusedId === id ? 'bg-raised text-ink' : 'text-ink-muted'}">
            <button
              type="button"
              role="tab"
              id="tab-{id}"
              aria-selected={panes.focusedId === id}
              aria-controls="panel-{id}"
              class="interactive flex min-h-9 max-w-44 cursor-pointer items-center gap-1.5 rounded-md py-1 pr-1 pl-2.5 text-[12.5px] pointer-coarse:min-h-11"
              onclick={() => panes.focus(id)}
              {@attach (el) => { if (panes.focusedId === id) el.scrollIntoView({ block: "nearest", inline: "nearest" }); }}
            >
              <span class="tnum text-[11px] text-ink-faint">{i + 1}</span>
              <span class="truncate">{s?.title || "New chat"}</span>
              {#if s?.status === "running"}<span class="pulse-live size-1.5 shrink-0 rounded-full bg-brand" aria-label="running"></span>{/if}
            </button>
            <button
              type="button"
              class="interactive grid size-7 shrink-0 cursor-pointer place-items-center rounded-md hover:bg-overlay pointer-coarse:size-11"
              aria-label="Close pane {i + 1}"
              title="Close pane"
              onclick={() => closePane(id)}
            ><X size={13} strokeWidth={2} aria-hidden="true" /></button>
          </div>
        {/each}
      </div>
        <button
          type="button"
          class="interactive grid size-9 shrink-0 cursor-pointer place-items-center rounded-md text-ink-muted hover:bg-raised hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:size-11"
          aria-label="New pane"
          title={panes.canSplit ? "New pane" : `At most ${MAX_PANES} panes`}
          disabled={!panes.canSplit}
          onclick={() => split(panes.focusedId, "row")}
        ><Plus size={15} strokeWidth={2} aria-hidden="true" /></button>
      </div>
    {/if}

    <div bind:this={layout} class="flex min-h-0 min-w-0 flex-1">
      {#snippet paneView(id: string)}
        {@const pane = panes.panes[id]}
        {#if pane}
          <div
            class="flex min-h-0 min-w-0 flex-1"
            id="panel-{id}"
            role={tabbed && panes.count > 1 ? "tabpanel" : undefined}
            aria-labelledby={tabbed && panes.count > 1 ? `tab-${id}` : undefined}
          >
            <ChatPane
              bind:this={refs[id]}
              {pane}
              number={panes.numberOf(id)}
              total={panes.count}
              tabs={tabbed}
              first={tabbed || panes.order[0] === id}
              {loading}
              canRight={canSplit(id, "row")}
              canDown={canSplit(id, "col")}
              ontogglesidebar={() => (sidebarOpen = !sidebarOpen)}
              onapp={app}
              onsplit={(dir) => split(id, dir)}
              onclosepane={() => closePane(id)}
              moves={paneMoves(id)}
              onmovepane={(dir) => movePaneDir(id, dir)}
              ondragpane={!tabbed && panes.count > 1 ? (event) => dragStart(id, event) : undefined}
              ondragmove={trackDrag}
              ondragend={dragEnd}
              dragging={dragFrom === id}
              layouts={paneLayouts}
              onarrange={arrange}
              appActions={appRows}
            />
          </div>
        {/if}
      {/snippet}

      {#if tabbed}
        {#key panes.focusedId}
          {@render paneView(panes.focused.id)}
        {/key}
      {:else}
        <PaneTree node={panes.tree} pane={paneView} onresize={(sid, r) => panes.resize(sid, r)} label={paneLabel} dropFrom={dragFrom} dropTarget={dragTarget} />
      {/if}
    </div>
  </div>
</div>

{#if TasksPanel}<TasksPanel open={tasksOpen} rows={taskRows} live={tasksLive} plans={planList} onclose={() => (tasksOpen = false)} />{/if}
{#if TeamMapModal}<TeamMapModal bind:open={teamMapOpen} onopensession={openInFocused} />{/if}
{#if RemoteHostsModal}<RemoteHostsModal bind:open={hostsOpen} />{/if}
{#if SettingsModal}<SettingsModal bind:open={settingsOpen} bind:tab={settingsTab} onclose={() => (settingsOpen = false)} />{/if}
{#if HelpModal}<HelpModal bind:open={helpOpen} />{/if}
{#if ResumeModal}<ResumeModal bind:open={resumeOpen} opening={openingId} onopen={resume} ondelete={deleteSaved} />{/if}
<Toasts />

<style>
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  :global(.enter-1),
  :global(.enter-3) {
    animation: rise 320ms cubic-bezier(0.2, 0, 0, 1) both;
  }
  :global(.enter-1) {
    animation-delay: 0ms;
  }
  :global(.enter-3) {
    animation-delay: 200ms;
  }
  @media (prefers-reduced-motion: reduce) {
    :global(.enter-1),
    :global(.enter-3) {
      animation: none;
    }
  }
</style>
