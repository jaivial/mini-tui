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
  import Toasts from "./lib/components/Toasts.svelte";
  import { history, sidebarHistory } from "./lib/stores/history.svelte";
  import { folderStore } from "./lib/stores/folders.svelte";
  import { catalog } from "./lib/stores/catalog.svelte";
  import { store } from "./lib/stores/sessions.svelte";
  import { panes } from "./lib/stores/panes.svelte";
  import { ui } from "./lib/stores/ui.svelte";
  import { toasts } from "./lib/stores/toast.svelte";
  import { api } from "./lib/api";
  import { roomToSplit, type Dir } from "./lib/panes";
  import { TEXT_SCALES, UI_SCALES, percent, stepScale } from "./lib/scale";
  import type { HistoryItem } from "./lib/types";
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
  let settingsOpen = $state(false);
  let settingsTab = $state("general");
  let helpOpen = $state(false);
  let resumeOpen = $state(false);
  let openingId = $state("");
  let loading = $state(true);
  const refs: Record<string, { focusComposer: () => void; focusNotes: () => void } | undefined> = $state({});

  $effect(() => {
    untrack(() => void catalog.warm());
  });

  // Once per page: connect and load. `untrack` keeps anything the store reads from becoming a
  // dependency, which would re-run this (closing every socket and reloading) on each change.
  $effect(() => {
    untrack(() => {
    store.connect();
    store
      .load()
      .then(() => {
        panes.forgetMissing((id) => !!store.sessions[id]);
        // First visit (no saved layout): open the latest session, as the app always has.
        if (!panes.restored && !panes.focused.sessionId && store.list[0]) panes.show(panes.focusedId, store.list[0].id);
      })
      .catch((error) => toasts.push("Could not reach the mini-tui server", { detail: (error as Error).message, tone: "err" }))
      .finally(() => (loading = false));
    });
    return () => store.close();
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

  function split(paneId: string, dir: Dir) {
    if (!panes.canSplit) {
      toasts.push("At most 6 panes", { detail: "Close one to open another.", tone: "info" });
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

  function scaleBy(dir: 1 | -1, text: boolean) {
    if (text) ui.setTextScale(stepScale(ui.textScale, dir, TEXT_SCALES));
    else ui.setUiScale(stepScale(ui.uiScale, dir, UI_SCALES));
    toasts.push(text ? `Text size ${percent(ui.textScale)}` : `Interface size ${percent(ui.uiScale)}`, { tone: "info" });
  }

  /**
   * Shortcuts. Ctrl/Cmd+K new chat (in the focused pane), Ctrl/Cmd+, settings, Ctrl/Cmd+B sidebar,
   * Ctrl+\ split right, Ctrl+Shift+\ split down, Alt+X close pane, Alt+1..6 or Ctrl/Cmd+Alt+arrows to
   * move between panes, Ctrl/Cmd+Shift+. notes, Ctrl/Cmd+= / - / 0 interface size (with Shift: text).
   * None of them collide with typing: every one needs Ctrl, Cmd or Alt.
   */
  function onkey(event: KeyboardEvent) {
    const mod = event.metaKey || event.ctrlKey;
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
    } else if (event.altKey && !mod && /^Digit[1-6]$/.test(code)) {
      const id = panes.order[Number(code.slice(5)) - 1];
      if (id) {
        event.preventDefault();
        panes.focus(id);
        refs[id]?.focusComposer();
      }
    } else if (mod && event.altKey && (key === "ArrowRight" || key === "ArrowDown" || key === "ArrowLeft" || key === "ArrowUp")) {
      event.preventDefault();
      panes.cycle(key === "ArrowRight" || key === "ArrowDown" ? 1 : -1);
      refs[panes.focusedId]?.focusComposer();
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

<svelte:window onkeydown={onkey} />

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
        paneOf={(id) => (panes.count > 1 ? (panes.paneOf(id) ? panes.numberOf(panes.paneOf(id)!.id) : 0) : 0)}
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
          title={panes.canSplit ? "New pane" : "At most 6 panes"}
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
            />
          </div>
        {/if}
      {/snippet}

      {#if tabbed}
        {#key panes.focusedId}
          {@render paneView(panes.focused.id)}
        {/key}
      {:else}
        <PaneTree node={panes.tree} pane={paneView} onresize={(sid, r) => panes.resize(sid, r)} label={paneLabel} />
      {/if}
    </div>
  </div>
</div>

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
