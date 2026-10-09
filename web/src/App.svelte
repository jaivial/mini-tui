<script lang="ts">
  import { tick, untrack } from "svelte";
  import { Plus, X } from "@lucide/svelte";
  import SessionSidebar from "./lib/components/SessionSidebar.svelte";
  import ChatPane from "./lib/components/ChatPane.svelte";
  import PaneTree from "./lib/components/PaneTree.svelte";
  import HelpModal from "./lib/components/HelpModal.svelte";
  import ResumeModal from "./lib/components/ResumeModal.svelte";
  import RemoteHostsModal from "./lib/components/RemoteHostsModal.svelte";
  import SettingsModal from "./lib/components/SettingsModal.svelte";
  import TasksPanel from "./lib/components/TasksPanel.svelte";
  import Toasts from "./lib/components/Toasts.svelte";
  import { history, sidebarHistory } from "./lib/stores/history.svelte";
  import { folderStore } from "./lib/stores/folders.svelte";
  import { catalog } from "./lib/stores/catalog.svelte";
  import { store } from "./lib/stores/sessions.svelte";
  import { panes } from "./lib/stores/panes.svelte";
import { windows } from "./lib/stores/windows.svelte";
  import { paneStatus, statusLabel } from "./lib/paneStatus";
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
  import { boardRows, windowTasks, type TaskWhere } from "./lib/tasks";
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
  /** The board as the hub last pushed it. The watch below keeps this reactive copy fresh. */
  let taskCards = $state<SessionTask[]>([]);
  let planList = $state<SessionPlan[]>([]);
  let tasksLive = $state(false);
  let settingsOpen = $state(false);
  let settingsTab = $state("general");
  let helpOpen = $state(false);
  let resumeOpen = $state(false);
  let openingId = $state("");
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

  // Once per page: connect and load. Reading `windows.activeId` here makes this effect re-run on a
  // window switch — it would drop every session socket and reload the list. Only the `createdId`
  // hand-off below wants to be reactive, and it is read under `untrack` with the rest.
  $effect(() => {
    // The task board is watched for as long as the app is open: the window's button glances at it
    // on hover and the panel opens it, and both must show what the agents last wrote, at once.
    const unwatch = tasks.watch((list) => (taskCards = list));
    const unplan = plans.watch((list) => (planList = list));
    const unhub = hub.onState((s) => (tasksLive = s === "live"));
    untrack(() => {
    store.connect();
    store
      .load()
      .then(() => store.restore(panes.shown))
      .then(() => {
        panes.forgetMissing((id) => !!store.sessions[id]);
        // First visit (no saved layout): open the latest session, as the app always has.
        if (windows.createdId) {
          // A window that has just been asked for: it starts empty, with one new chat.
          windows.takeCreated();
          panes.openBlank();
        } else if (!panes.restored && !panes.focused.sessionId && store.list[0]) panes.show(panes.focusedId, store.list[0].id);
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

  // A session that disappears (deleted, or closed from another tab) leaves its pane as a new chat.
  $effect(() => {
    const ids = panes.shown;
    if (loading) return;
    const gone = ids.filter((id) => !store.sessions[id]);
    if (gone.length) untrack(() => panes.forgetMissing((id) => !!store.sessions[id]));
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
  /** A window is born with one pane, so a move into a fresh one is never at the pane limit. */
  const movePane = (paneId: string, to: string | "new", name?: string) => {
    const went = panes.sendTo(paneId, to, name);
    if (!went) toasts.push("That window is full", { detail: `At most ${MAX_PANES} panes in a window.`, tone: "info" });
    else void tick().then(() => refs[panes.focusedId]?.focusComposer());
    return went;
  };

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

  /** A new chat already set to run in `cwd` (on `hostId`, for a remote folder), in the focused pane. */
  function newChatIn(cwd: string, hostId?: string) {
    const pane = panes.focused;
    panes.show(pane.id, null);
    const host = hostId && store.hosts.some((h) => h.id === hostId) ? hostId : "local";
    pane.draft = { ...pane.draft, targetId: host, cwd };
    if (narrow) sidebarOpen = false;
    void tick().then(() => refs[pane.id]?.focusComposer());
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
  /** Where a pane can go: the other windows, and a new one. */
  const moveTargets = $derived(windows.list.filter((w) => w.id !== windows.activeId).map((w) => ({ id: w.id, label: windows.label(w.id, (wid) => panes.paneCount(wid)) })));
  /**
   * Where a session is on screen, for the task board: the pane showing it (its number in the
   * reading order) and the window that pane lives in. Null when no pane shows the session.
   */
  const whereOf = (id: string): TaskWhere | null => {
    const pane = panes.paneOf(id);
    if (!pane) return null;
    const w = panes.windowOf(id);
    return { pane: panes.numberOf(pane.id), window: w ? windows.label(w, (wid) => panes.paneCount(wid)) : windows.label(windows.activeId, (wid) => panes.paneCount(wid)) };
  };
  /** The task board's rows: every session with a task card, with where it lives on screen. */
  const taskRows = $derived(boardRows(taskCards, (id) => store.sessions[id]?.title ?? "", whereOf));
  /** The card of a session, by id: what each pane's row in the sidebar's popover reads. */
  const taskOf = $derived.by(() => new Map(taskCards.map((t) => [t.id, t])));
  /**
   * Each window's own tasks, one for the icon on its sidebar row: its panes in reading order, each
   * with the session it shows and that session's card (a pane with no session, or a session with no
   * card yet, is a row that says so). The popover's title is the window's general task.
   */
  const tasksByWindow = $derived(
    Object.fromEntries(
      windows.list.map((w) => [
        w.id,
        windowTasks(
          windows.label(w.id, (wid) => panes.paneCount(wid)),
          panes.panesIn(w.id).map((p) => {
            const s = p.sessionId ? store.sessions[p.sessionId] : null;
            return { sessionId: p.sessionId, sessionTitle: s?.title || "New chat", task: (p.sessionId ? taskOf.get(p.sessionId) : undefined) ?? null };
          }),
        ),
      ]),
    ),
  );

  /** The sidebar's window list: name or number, pane count, and which is on screen. */
  const windowRows = $derived(
    windows.list.map((w) => ({
      id: w.id,
      label: windows.label(w.id, (wid) => panes.paneCount(wid)),
      name: w.name,
      panes: panes.paneCount(w.id),
      active: w.id === windows.activeId,
      // One dot per pane, in reading order: live, done (until clicked) or idle.
      dots: panes.panesIn(w.id).map((p) => {
        const s = p.sessionId ? store.sessions[p.sessionId] : null;
        const status = paneStatus(s, p);
        return { id: p.id, status, label: `${s?.title || "New chat"}: ${statusLabel(status, s?.status === "error")}`, error: status === "done" && s?.status === "error" };
      }),
    })),
  );
  /** Another window on screen: these panes are shelved with their prompts, that window's come back. */
  function switchWindow(id: string) {
    if (id === windows.activeId) return;
    panes.switchTo(id);
    queueMicrotask(() => refs[panes.focusedId]?.focusComposer());
  }
  /** A new window: it opens empty (one new chat) and takes the focus. */
  function newWindow() {
    windows.create();
    if (narrow) sidebarOpen = false;
    panes.openBlank();
    queueMicrotask(() => refs[panes.focusedId]?.focusComposer());
  }

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
    if (mod && !event.altKey && key.toLowerCase() === "k") {
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
  {#if sidebarOpen && narrow}
    <button class="absolute inset-0 z-40 cursor-default bg-black/40" aria-label="Close sidebar" onclick={() => (sidebarOpen = false)}></button>
  {/if}
  {#if sidebarOpen}
    <div class="enter-1 {narrow ? 'absolute inset-y-0 left-0 z-50' : 'relative'}">
      <SessionSidebar
        onnew={newChat}
        onsettings={() => app("settings")}
        onopenhosts={() => (hostsOpen = true)}
        onclosesession={closeSession}
        onhidesidebar={() => (sidebarOpen = false)}
        onopen={openInFocused}
        onopenhistory={resume}
        onresume={() => (resumeOpen = true)}
        onnewin={newChatIn}
        openingId={openingId}
        windows={windowRows}
        onwindow={(id) => switchWindow(id)}
        onnewwindow={() => newWindow()}
        onrename={(id, name) => windows.rename(id, name)}
        onclosewindow={(id) => {
          panes.dropWindow(id);
          windows.remove(id);
        }}
        ontasks={() => (tasksOpen = true)}
        windowTasks={tasksByWindow}
        inOtherWindow={(id) => {
          const w = panes.windowOf(id);
          return w && w !== windows.activeId ? windows.label(w, (wid) => panes.paneCount(wid)) : "";
        }}
        paneOf={(id) => {
          const p = panes.paneOf(id);
          return p ? panes.numberOf(p.id) : 0;
        }}
        focusedSession={panes.focused.sessionId}
        {loading}
      />
    </div>
  {/if}

  <div class="flex min-w-0 flex-1 flex-col pt-[env(safe-area-inset-top)]">
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
              windows={moveTargets}
              onmove={(to, name) => movePane(id, to, name)}
              moves={paneMoves(id)}
              onmovepane={(dir) => movePaneDir(id, dir)}
              ondragpane={!tabbed && panes.count > 1 ? (event) => dragStart(id, event) : undefined}
              ondragmove={trackDrag}
              ondragend={dragEnd}
              dragging={dragFrom === id}
              layouts={paneLayouts}
              onarrange={arrange}
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

<TasksPanel open={tasksOpen} rows={taskRows} live={tasksLive} plans={planList} onclose={() => (tasksOpen = false)} />
<RemoteHostsModal bind:open={hostsOpen} />
<SettingsModal bind:open={settingsOpen} bind:tab={settingsTab} onclose={() => (settingsOpen = false)} />
<HelpModal bind:open={helpOpen} />
<ResumeModal bind:open={resumeOpen} opening={openingId} onopen={resume} ondelete={deleteSaved} />
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
