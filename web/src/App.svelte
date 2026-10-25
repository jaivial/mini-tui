<script lang="ts">
  import { tick, untrack } from "svelte";
  import { ArrowDown, ListTodo, SquarePen, Settings, Keyboard, WifiOff, ArrowLeft, Globe, Sparkles, ArrowUpRight } from "@lucide/svelte";
  import { fade } from "svelte/transition";
  import { dragSize, effectiveWidth, keySize, loadPanelSize, savePanelSize, type PanelSize } from "./lib/panelWidth";
  import { popIn, pressable, staggerChildren } from "./lib/motion";
  import Button from "./lib/components/Button.svelte";
  import Transcript from "./lib/components/Transcript.svelte";
  import Composer from "./lib/components/Composer.svelte";
  import Skeleton from "./lib/components/Skeleton.svelte";
  import Spinner from "./lib/components/Spinner.svelte";
  import PixelLoader from "./lib/components/PixelLoader.svelte";
  import Toasts from "./lib/components/Toasts.svelte";
  import QueuePanel from "./lib/components/QueuePanel.svelte";
  import BrowserPanel from "./lib/components/BrowserPanel.svelte";
  import { catalog } from "./lib/stores/catalog.svelte";
  import { store } from "./lib/stores/sessions.svelte";
  import { queue } from "./lib/stores/queue.svelte";
  import { toasts } from "./lib/stores/toast.svelte";
  import { api } from "./lib/api";
  import { parseCommand } from "./lib/completion";
  import { PromptMemory, splitSent } from "./lib/promptMemory";
  import { followTranscript, isAtBottom } from "./lib/threadScroll";
  import type { AttachmentRef } from "./lib/attachments";
  import type { Chip } from "./lib/chips";
  import type { EffortLevel } from "../../src/effort";

  /**
   * The whole app: ONE chat and the task queue beside it.
   *
   * The chat's agent is the dispatcher: everything sent here becomes tasks in the work queue (or a
   * redirect of a task in flight), and each task runs as its own background session. The panel on
   * the right lists them by state. No sidebar of sessions, no panes: one screen.
   */
  const NARROW = 900;
  let narrow = $state(false);
  let panelOpen = $state(true);
  /** What the right panel shows: the task queue, or the agents' browser. */
  let panelTab = $state<"tasks" | "browser">("tasks");
  let browserTab = $state("");
  let browserLive = $state(false);
  function showBrowser(tab = "") {
    browserLive = !!tab;
    if (tab) browserTab = tab;
    panelTab = "browser";
    panelOpen = true;
  }
  // A worker that needs a human in the browser (a captcha, a QR, a login): the panel opens on
  // its tab. The chat's notice carries the marker; see queueHost.ts.
  $effect(() => {
    const id = queue.main;
    const events = id ? (store.sessions[id]?.events ?? []) : [];
    const last = events[events.length - 1];
    if (last && last.type === "notice" && last.interruptType === "queue" && /\[\[browser(?::([A-Za-z0-9_-]+))?\]\]/.test(last.text)) {
      const m = /\[\[browser(?::([A-Za-z0-9_-]+))?\]\]/.exec(last.text);
      untrack(() => showBrowser(m?.[1] ?? ""));
    }
  });
  $effect(() => {
    const apply = () => {
      const was = narrow;
      narrow = window.innerWidth <= NARROW;
      if (narrow !== was) panelOpen = !narrow;
    };
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  });

  // ---- the right panel's width: any width up to the whole window (lib/panelWidth.ts)
  let panelSize = $state<PanelSize>(loadPanelSize());
  let shell = $state<HTMLElement | null>(null);
  let shellWidth = $state(0);
  let resizing = $state(false);
  const panelPx = $derived(effectiveWidth(panelSize, shellWidth || 1200));
  const panelFull = $derived(panelSize.full && !narrow);
  function setPanelSize(next: PanelSize) {
    panelSize = next;
    savePanelSize(next);
  }
  /** The pointer's x inside the shell, in the shell's own (zoom-corrected) pixels. */
  function shellX(event: PointerEvent): number {
    const rect = shell!.getBoundingClientRect();
    const scale = rect.width / (shell!.offsetWidth || rect.width);
    return (event.clientX - rect.left) / scale;
  }
  function startResize(event: PointerEvent) {
    if (event.button !== 0 || !shell) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    resizing = true;
    const move = (e: PointerEvent) => {
      panelSize = dragSize(shellX(e), shell!.offsetWidth);
    };
    const up = () => {
      resizing = false;
      savePanelSize(panelSize);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  }
  function resizeKey(event: KeyboardEvent) {
    const next = keySize(event.key, event.shiftKey, panelSize, shellWidth);
    if (!next) return;
    event.preventDefault();
    setPanelSize(next);
  }
  function toggleFull() {
    setPanelSize({ ...panelSize, full: !panelSize.full });
  }

  let loading = $state(true);
  let prompt = $state("");
  let chips = $state<Chip[]>([]);
  let attachments = $state<AttachmentRef[]>([]);
  let sending = $state(false);
  let modelOpen = $state(false);
  let draftModel = $state("");
  let switchingModel = $state(false);
  let effortBusy = $state(false);
  const memory = new PromptMemory();
  let composer = $state<{ focus: () => void } | null>(null);
  let scroller = $state<HTMLElement | null>(null);
  /** A worker's session opened from the task panel, read-only, in place of the chat. */
  let viewing = $state("");

  let settingsOpen = $state(false);
  let settingsTab = $state("general");
  let helpOpen = $state(false);
  type ModalOf<T> = T extends { default: infer C } ? C : never;
  let SettingsModal = $state<ModalOf<typeof import("./lib/components/SettingsModal.svelte")> | null>(null);
  let HelpModal = $state<ModalOf<typeof import("./lib/components/HelpModal.svelte")> | null>(null);
  $effect(() => {
    if (settingsOpen && !SettingsModal) void import("./lib/components/SettingsModal.svelte").then((m) => (SettingsModal = m.default));
    if (helpOpen && !HelpModal) void import("./lib/components/HelpModal.svelte").then((m) => (HelpModal = m.default));
  });

  const shownId = $derived(viewing || queue.main);
  const session = $derived(shownId ? (store.sessions[shownId] ?? null) : null);
  const link = $derived(session ? (store.links[session.id] ?? "idle") : "idle");
  const currentModel = $derived(store.sessions[queue.main]?.model || draftModel || catalog.settings?.lastModel || "");

  $effect(() => {
    untrack(() => void catalog.warm());
    store.connect();
    Promise.all([store.load(), queue.load()])
      .then(() => (queue.main && !store.sessions[queue.main] ? store.restore([queue.main]) : null))
      .catch((error) => toasts.push("Could not reach the mini-tui server", { detail: (error as Error).message, tone: "err" }))
      .finally(() => (loading = false));
    return () => store.close();
  });

  // The chat (and a worker opened from the panel) streams over its socket.
  $effect(() => {
    store.setVisible([queue.main, viewing].filter(Boolean));
    store.setActive(shownId || null);
  });
  // A chat this tab does not hold yet (another tab started it, the server restarted): open it.
  $effect(() => {
    const id = queue.main;
    if (!loading && id && !store.sessions[id]) untrack(() => void store.restore([id]));
  });

  // ↑/↓ recall from the chat's own prompts.
  let memoryOf = "";
  $effect(() => {
    const id = queue.main;
    const events = id ? (store.sessions[id]?.events ?? []) : [];
    if (id === memoryOf && events.length) return;
    const names = catalog.commands.map((c) => c.name);
    memory.reset(events.flatMap((e) => (e.type === "task" ? [splitSent(stripQueueState(e.text), names)] : [])));
    if (events.length) memoryOf = id;
  });

  // ---- scroll: follow the stream only while the reader is at the bottom (lib/threadScroll.ts)
  let atBottom = $state(true);
  /** Whose transcript the pin pass last followed. */
  let pinnedSession: string | null = null;
  $effect(() => {
    // Waits for the snapshot (else it pins to the loading skeleton) and runs after the DOM flush
    // (else it measures geometry that is not on screen yet).
    const ready = session ? store.hydrated[session.id] || session.events.length > 0 : true;
    session?.events.length;
    if (!ready) return;
    void tick().then(() => pinPass());
  });
  function pinPass() {
    const id = session?.id ?? null;
    const switched = pinnedSession !== null && pinnedSession !== id;
    if (!scroller) return;
    const geometry = { scrollHeight: scroller.scrollHeight, scrollTop: scroller.scrollTop, clientHeight: scroller.clientHeight };
    const { follow, atBottom: next } = followTranscript(geometry, { atBottom: isAtBottom(geometry), prevSession: pinnedSession }, id, switched);
    pinnedSession = id;
    if (follow) scroller.scrollTop = scroller.scrollHeight;
    atBottom = next;
  }
  function onScroll() {
    if (scroller) atBottom = isAtBottom({ scrollHeight: scroller.scrollHeight, scrollTop: scroller.scrollTop, clientHeight: scroller.clientHeight });
  }
  function jumpToLatest() {
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
    atBottom = true;
    pinnedSession = session?.id ?? null;
  }

  /** The queue state the server appends for the dispatcher is not part of what the human wrote. */
  function stripQueueState(text: string): string {
    return text.replace(/\s*<queue_state>[\s\S]*?<\/queue_state>\s*$/, "");
  }
  const events = $derived(
    (session?.events ?? []).map((e) => {
      if (e.type === "task" && e.text.includes("<queue_state>")) return { ...e, text: stripQueueState(e.text) };
      // The browser marker is for the panel, not for reading.
      if (e.type === "notice" && e.text.includes("[[browser")) return { ...e, text: e.text.replace(/\s*\[\[browser(?::[A-Za-z0-9_-]+)?\]\]/g, "") + " — open the Browser panel." };
      return e;
    }),
  );

  async function newChat() {
    try {
      await api.queueNew();
      viewing = "";
      void queue.load();
      queueMicrotask(() => composer?.focus());
    } catch (e) {
      toasts.push("Could not start a new chat", { detail: (e as Error).message, tone: "err" });
    }
  }

  async function runCommand(text: string): Promise<boolean> {
    const cmd = parseCommand(text, catalog.commands);
    if (!cmd) return false;
    if (!cmd.known) {
      toasts.push(`Unknown command /${cmd.name}`, { detail: "Type / to see the commands.", tone: "err" });
      return true;
    }
    if (cmd.name === "new") await newChat();
    else if (cmd.name === "model") {
      if (cmd.arg) await pickModel(cmd.arg);
      else modelOpen = true;
    } else if (cmd.name === "compact" && queue.main) await api.compact(queue.main).catch((e) => toasts.push("Could not compact", { detail: (e as Error).message, tone: "err" }));
    else if (cmd.name === "settings" || cmd.name === "skills") {
      settingsTab = cmd.name === "settings" ? "general" : "skills";
      settingsOpen = true;
    } else if (cmd.name === "connect" || cmd.name === "mcp") {
      settingsTab = cmd.name === "mcp" ? "mcp" : "providers";
      settingsOpen = true;
    } else if (cmd.name === "help") helpOpen = true;
    else if (cmd.name === "tasks") {
      panelOpen = !(panelOpen && panelTab === "tasks");
      panelTab = "tasks";
    }
    else if (cmd.name === "browser") showBrowser();
    else toasts.push(`/${cmd.name} is not available here`, { tone: "info" });
    prompt = "";
    chips = [];
    return true;
  }

  async function send(message: string) {
    const text = message.trim();
    if ((!text && !attachments.length) || sending) return;
    const sent = text || `📎 ${attachments.map((a) => a.name).join(", ")}`;
    sending = true;
    try {
      if (await runCommand(sent)) return;
      viewing = "";
      const s = await api.queuePrompt(sent, currentModel || undefined, attachments);
      store.adopt(s);
      queue.main = s.id;
      prompt = "";
      chips = [];
      attachments = [];
    } catch (error) {
      toasts.push("Could not send", { detail: (error as Error).message, tone: "err" });
    } finally {
      sending = false;
    }
  }

  async function pickModel(id: string) {
    const main = store.sessions[queue.main];
    if (!main) {
      draftModel = id;
      return;
    }
    if (switchingModel || id === main.model) return;
    switchingModel = true;
    const previous = main.model;
    main.model = id;
    try {
      await api.setModel(main.id, id);
    } catch (error) {
      main.model = previous;
      toasts.push("Model switch failed", { detail: (error as Error).message, tone: "err" });
    } finally {
      switchingModel = false;
    }
  }

  async function pickEffort(model: string, effort: EffortLevel) {
    if (effortBusy) return;
    effortBusy = true;
    try {
      const modelEfforts = { ...(catalog.settings?.modelEfforts ?? {}), [model]: effort };
      catalog.settings = await api.patchSettings({ modelEfforts });
    } catch (error) {
      toasts.push("Could not save reasoning effort", { detail: (error as Error).message, tone: "err" });
    } finally {
      effortBusy = false;
    }
  }

  async function interrupt() {
    if (!session) return;
    await api.interrupt(session.id).catch((e) => toasts.push("Could not stop", { detail: (e as Error).message, tone: "err" }));
  }

  async function openWorker(id: string) {
    try {
      if (!store.sessions[id]) store.adopt(await api.openHistory(id));
      viewing = id;
      if (narrow) panelOpen = false;
    } catch (error) {
      toasts.push("Could not open that session", { detail: (error as Error).message, tone: "err" });
    }
  }

  function onkey(event: KeyboardEvent) {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && !event.altKey && event.key.toLowerCase() === "k") {
      event.preventDefault();
      void newChat();
    } else if (mod && event.key === ",") {
      event.preventDefault();
      settingsTab = "general";
      settingsOpen = true;
    } else if (mod && !event.shiftKey && event.key.toLowerCase() === "b") {
      event.preventDefault();
      panelOpen = !panelOpen;
    } else if (mod && event.shiftKey && event.key.toLowerCase() === "f" && panelOpen && !narrow) {
      event.preventDefault();
      toggleFull();
    } else if (event.key === "Escape" && panelFull && panelOpen && !settingsOpen && !helpOpen && !(event.target as HTMLElement)?.closest?.("input,textarea")) {
      event.preventDefault();
      toggleFull();
    } else if (event.key === "Escape" && narrow && panelOpen && !settingsOpen && !helpOpen) {
      // On a phone the panel covers the chat: Escape is its way out.
      event.preventDefault();
      panelOpen = false;
    }
  }
</script>

<svelte:window onkeydowncapture={onkey} />

<div bind:this={shell} bind:clientWidth={shellWidth} class="app-shell relative flex h-full w-full overflow-hidden bg-canvas text-ink" class:select-none={resizing} class:cursor-col-resize={resizing}>
  <div class="flex min-w-0 flex-1 flex-col pt-[env(safe-area-inset-top)]" inert={(narrow || panelFull) && panelOpen} class:hidden={panelFull && panelOpen}>
    <header class="app-header relative z-30 flex min-h-16 shrink-0 items-center gap-1.5 border-b border-line/65 px-4 py-2">
      {#if viewing}
        <Button variant="ghost" size="icon-sm" icon={ArrowLeft} title="Back to the chat" aria-label="Back to the chat" onclick={() => (viewing = "")} />
        <h1 class="min-w-0 flex-1 truncate px-1 text-[13.5px] font-semibold">{session?.title || "Task"} <span class="font-normal text-ink-faint">· worker</span></h1>
      {:else}
        <div class="flex min-w-0 flex-1 items-center gap-2.5 pr-2">
          <span class="brand-mark grid size-8 shrink-0 place-items-center rounded-[10px] border border-brand/25 bg-brand-soft text-brand"><Sparkles size={15} strokeWidth={1.8} aria-hidden="true" /></span>
          <div class="min-w-0">
            <h1 class="font-display text-[13px] font-semibold leading-4 tracking-[-0.01em]">mini <span class="font-normal text-ink-faint">/ workspace</span></h1>
            {#if session?.status === "running"}<p class="mt-0.5 flex items-center gap-1.5 text-[9.5px] text-brand"><span class="pulse-live size-1 rounded-full bg-brand"></span>Dispatching work</p>{:else}<p class="mt-0.5 text-[9.5px] text-ink-faint">Plan, delegate, ship</p>{/if}
          </div>
        </div>
      {/if}
      <Button variant="ghost" size="icon-sm" icon={SquarePen} title="New chat (Ctrl/⌘ K)" aria-label="New chat" onclick={newChat} />
      <Button variant="ghost" size="icon-sm" icon={Settings} title="Settings (Ctrl/⌘ ,)" aria-label="Settings" onclick={() => { settingsTab = "general"; settingsOpen = true; }} />
      <Button variant="ghost" size="icon-sm" icon={Keyboard} title="Help" aria-label="Help" onclick={() => (helpOpen = true)} />
      <Button variant="ghost" size="icon-sm" icon={Globe} title="Browser" aria-label="Toggle browser" active={panelOpen && panelTab === "browser"} onclick={() => { if (panelOpen && panelTab === "browser") panelOpen = false; else showBrowser(); }} />
      <Button variant="ghost" size="icon-sm" icon={ListTodo} title="Tasks (Ctrl/⌘ B)" aria-label="Toggle tasks" active={panelOpen && panelTab === "tasks"} onclick={() => { if (panelOpen && panelTab === "tasks") panelOpen = false; else { panelTab = "tasks"; panelOpen = true; } }} />
      {#if queue.counts.running}<span class="tnum -ml-1 text-[11px] text-live" aria-label="{queue.counts.running} running">{queue.counts.running}</span>{/if}
    </header>

    <div class="relative flex min-h-0 flex-1 flex-col">
      <div class="relative min-h-0 flex-1">
        <main bind:this={scroller} onscroll={onScroll} class="h-full min-h-0 overflow-y-auto overscroll-contain px-4 py-5">
          <div class="mx-auto max-w-3xl pb-3">
            {#if loading || (shownId && !session) || (session && !store.hydrated[session.id] && !session.events.length)}
              <div class="flex flex-col gap-4 py-2" role="status" aria-label="Loading conversation">
                <Skeleton class="h-4 w-2/5" />
                <Skeleton class="h-16 w-full" />
                <Skeleton class="h-4 w-3/5" />
              </div>
            {:else if session}
              {#key session.id}
                <Transcript {events} partial={session.partial} onsubmit={(m) => send(m)} />
              {/key}
            {:else}
              <div class="empty-workspace relative mx-auto flex max-w-lg flex-col items-center gap-4 overflow-hidden rounded-2xl border border-line/60 px-7 py-12 text-center" use:staggerChildren={{ step: 0.08, y: 8 }}>
                <span class="empty-icon grid size-12 place-items-center rounded-2xl border border-brand/25 bg-brand-soft text-brand"><ArrowUpRight size={21} strokeWidth={1.6} aria-hidden="true" /></span>
                <div>
                  <p class="mb-2 text-[9px] font-semibold tracking-[0.18em] text-brand uppercase">Your agent workspace</p>
                  <h2 class="font-display text-[23px] font-semibold tracking-[-0.025em]">What should get done?</h2>
                </div>
                <p class="max-w-sm text-[12.5px] leading-5.5 text-ink-muted">Describe the outcome. Mini turns it into background tasks, coordinates the workers and keeps every step in view.</p>
                <div class="mt-1 flex flex-wrap items-center justify-center gap-1.5 text-[9.5px] text-ink-faint"><span class="rounded-full border border-line/70 bg-canvas/40 px-2 py-1">Parallel workers</span><span class="rounded-full border border-line/70 bg-canvas/40 px-2 py-1">Live progress</span><span class="rounded-full border border-line/70 bg-canvas/40 px-2 py-1">Your models</span></div>
              </div>
            {/if}
          </div>
        </main>
        {#if session && !atBottom && session.events.length}
          <div class="pointer-events-none absolute bottom-3 left-1/2 z-25 -translate-x-1/2">
            <button
              type="button"
              transition:popIn={{ y: 8, scale: 0.8 }}
              use:pressable={0.9}
              class="pointer-events-auto grid size-11 cursor-pointer place-items-center rounded-full border border-line/60 bg-raised/80 text-ink-muted backdrop-blur-md transition-colors hover:text-ink"
              aria-label="Scroll to the latest message"
              onclick={jumpToLatest}
            >
              <ArrowDown size={18} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        {/if}
      </div>

      {#if link === "reconnecting" || link === "connecting"}
        <div class="mx-auto mb-2 flex w-full max-w-3xl items-center gap-2 px-4 text-[12.5px] text-ink-muted" role="status">
          <WifiOff size={13} strokeWidth={2} aria-hidden="true" />
          {link === "connecting" ? "Connecting" : "Connection lost. Reconnecting"}<Spinner size={12} label="" />
        </div>
      {:else if session?.status === "running"}
        <div class="mx-auto mb-2 w-full max-w-3xl px-4">
          <PixelLoader label={viewing ? "Working" : "Dispatching"} since={session.startedAt} />
        </div>
      {/if}

      {#if !viewing}
        <Composer
          bind:this={composer}
          bind:value={prompt}
          bind:chips
          bind:attachments
          draftKey={queue.main}
          bind:modelOpen
          running={session?.status === "running"}
          {sending}
          model={currentModel}
          {switchingModel}
          modelNote="Used by the dispatcher and by new tasks."
          onsend={send}
          oninterrupt={interrupt}
          onmodel={pickModel}
          oneffort={pickEffort}
          modelEfforts={catalog.settings?.modelEfforts ?? {}}
          {effortBusy}
          {memory}
        />
      {/if}
    </div>
  </div>

  {#if panelOpen}
    <div
      class={narrow ? "panel-in absolute inset-0 z-50 bg-surface pt-[env(safe-area-inset-top)]" : `side-panel relative shrink-0 ${panelFull ? "flex-1" : ""}`}
      class:resizing
      style={narrow ? undefined : panelFull ? undefined : `width: ${panelPx}px`}
      role={narrow ? "dialog" : undefined}
      aria-modal={narrow ? "true" : undefined}
      aria-label={narrow ? "Tasks" : undefined}
      in:fade={{ duration: 140 }}
    >
      {#if !narrow}
        <!-- Drag to any width; past the left edge it snaps to full screen. Double-click toggles full screen.
             A focusable separator with a value is the WAI-ARIA window splitter: it IS interactive. -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
        <div
          class="resize-handle group absolute inset-y-0 -left-1.5 z-40 w-3 cursor-col-resize touch-none"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the panel (arrows, Home for full screen)"
          aria-valuemin={280}
          aria-valuemax={shellWidth}
          aria-valuenow={panelPx}
          tabindex="0"
          onpointerdown={startResize}
          ondblclick={toggleFull}
          onkeydown={resizeKey}
        >
          <span class="grip absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-[background-color,width] duration-150 group-hover:w-0.5 group-hover:bg-brand group-focus-visible:w-0.5 group-focus-visible:bg-brand" class:active-grip={resizing}></span>
          <span class="pill pointer-events-none absolute top-1/2 left-1/2 h-8 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-line-strong opacity-0 transition-opacity duration-150 group-hover:opacity-100"></span>
        </div>
      {/if}
      {#if panelTab === "browser"}
        <BrowserPanel bind:tab={browserTab} live={browserLive} onclose={() => (panelOpen = false)} full={panelFull} onfull={narrow ? undefined : toggleFull} />
      {:else}
        <QueuePanel onclose={() => (panelOpen = false)} onopen={openWorker} full={panelFull} onfull={narrow ? undefined : toggleFull} />
      {/if}
    </div>
  {/if}
</div>

{#if resizing}
  <!-- Over iframes and the browser canvas too: the drag never loses the pointer. -->
  <div class="fixed inset-0 z-[70] cursor-col-resize" transition:fade={{ duration: 80 }}></div>
{/if}

{#if SettingsModal}<SettingsModal bind:open={settingsOpen} bind:tab={settingsTab} onclose={() => (settingsOpen = false)} />{/if}
{#if HelpModal}<HelpModal bind:open={helpOpen} />{/if}
<Toasts />

<style>
  .app-shell {
    background-image:
      radial-gradient(ellipse 60% 45% at 20% -10%, rgb(239 211 149 / 0.035), transparent),
      linear-gradient(var(--color-canvas), var(--color-canvas));
  }
  .app-header { background: color-mix(in oklab, var(--color-canvas) 88%, transparent); }
  .brand-mark { box-shadow: inset 0 1px 0 rgb(239 211 149 / 0.12), 0 4px 16px rgb(0 0 0 / 0.16); }
  .empty-workspace { margin-top: clamp(2rem, 9vh, 6rem); background: linear-gradient(145deg, color-mix(in oklab, var(--color-raised) 58%, transparent), color-mix(in oklab, var(--color-surface) 45%, transparent)); }
  .empty-workspace::before { content: ""; position: absolute; width: 15rem; height: 10rem; top: -7rem; left: 50%; translate: -50% 0; background: var(--color-brand); opacity: 0.06; filter: blur(45px); pointer-events: none; }
  .empty-icon { box-shadow: 0 8px 30px rgb(239 211 149 / 0.07); }
  .side-panel {
    transition: width 220ms var(--ease-emphasized);
  }
  .side-panel.resizing {
    transition: none;
  }
  .active-grip {
    width: 2px;
    background: var(--color-brand);
  }
  .panel-in {
    animation: sheet-in var(--duration-base) var(--ease-emphasized) both;
  }
</style>
