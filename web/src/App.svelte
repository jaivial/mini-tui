<script lang="ts">
  import { tick, untrack } from "svelte";
  import { ArrowDown, ListTodo, SquarePen, Settings, Keyboard, WifiOff, ArrowLeft } from "@lucide/svelte";
  import Button from "./lib/components/Button.svelte";
  import Transcript from "./lib/components/Transcript.svelte";
  import Composer from "./lib/components/Composer.svelte";
  import Skeleton from "./lib/components/Skeleton.svelte";
  import Spinner from "./lib/components/Spinner.svelte";
  import PixelLoader from "./lib/components/PixelLoader.svelte";
  import Toasts from "./lib/components/Toasts.svelte";
  import QueuePanel from "./lib/components/QueuePanel.svelte";
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

  let loading = $state(true);
  let prompt = $state("");
  let chips = $state<Chip[]>([]);
  let attachments = $state<AttachmentRef[]>([]);
  let sending = $state(false);
  let modelOpen = $state(false);
  let draftModel = $state("");
  let switchingModel = $state(false);
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
    (session?.events ?? []).map((e) => (e.type === "task" && e.text.includes("<queue_state>") ? { ...e, text: stripQueueState(e.text) } : e)),
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
    } else if (cmd.name === "connect") {
      settingsTab = "providers";
      settingsOpen = true;
    } else if (cmd.name === "help") helpOpen = true;
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
    }
  }
</script>

<svelte:window onkeydowncapture={onkey} />

<div class="relative flex h-full w-full overflow-hidden bg-canvas text-ink">
  <div class="flex min-w-0 flex-1 flex-col pt-[env(safe-area-inset-top)]" inert={narrow && panelOpen}>
    <header class="relative z-30 flex min-h-13 shrink-0 items-center gap-1 border-b border-line/80 px-3.5 py-1.5">
      {#if viewing}
        <Button variant="ghost" size="icon-sm" icon={ArrowLeft} title="Back to the chat" aria-label="Back to the chat" onclick={() => (viewing = "")} />
        <h1 class="min-w-0 flex-1 truncate px-1 text-[13.5px] font-semibold">{session?.title || "Task"} <span class="font-normal text-ink-faint">· worker</span></h1>
      {:else}
        <h1 class="min-w-0 flex-1 truncate px-1 text-[13.5px] font-semibold">mini</h1>
        {#if session?.status === "running"}<span class="flex items-center gap-1.5 text-[11.5px] text-live"><span class="pulse-live size-1.5 rounded-full bg-live"></span>dispatching</span>{/if}
      {/if}
      <Button variant="ghost" size="icon-sm" icon={SquarePen} title="New chat (Ctrl/⌘ K)" aria-label="New chat" onclick={newChat} />
      <Button variant="ghost" size="icon-sm" icon={Settings} title="Settings (Ctrl/⌘ ,)" aria-label="Settings" onclick={() => { settingsTab = "general"; settingsOpen = true; }} />
      <Button variant="ghost" size="icon-sm" icon={Keyboard} title="Help" aria-label="Help" onclick={() => (helpOpen = true)} />
      <Button variant="ghost" size="icon-sm" icon={ListTodo} title="Tasks (Ctrl/⌘ B)" aria-label="Toggle tasks" active={panelOpen} onclick={() => (panelOpen = !panelOpen)} />
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
              <div class="flex flex-col items-center gap-3 py-24 text-center">
                <h2 class="text-[20px] font-semibold tracking-tight">What should get done?</h2>
                <p class="max-w-md text-[13.5px] text-ink-muted">
                  Send work here. Each request becomes a task in the queue and runs in the background, up to
                  {queue.concurrency || "the configured number of"} at once. Follow them on the right.
                </p>
              </div>
            {/if}
          </div>
        </main>
        {#if session && !atBottom && session.events.length}
          <button
            type="button"
            class="absolute bottom-3 left-1/2 z-25 grid size-11 -translate-x-1/2 cursor-pointer place-items-center rounded-full border border-line/60 bg-raised/80 text-ink-muted backdrop-blur-md hover:text-ink"
            aria-label="Scroll to the latest message"
            onclick={jumpToLatest}
          >
            <ArrowDown size={18} strokeWidth={2} aria-hidden="true" />
          </button>
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
          {memory}
        />
      {/if}
    </div>
  </div>

  {#if panelOpen}
    <div class={narrow ? "absolute inset-0 z-50 bg-surface" : "relative w-[min(26rem,38%)] shrink-0"}>
      <QueuePanel onclose={() => (panelOpen = false)} onopen={openWorker} />
    </div>
  {/if}
</div>

{#if SettingsModal}<SettingsModal bind:open={settingsOpen} bind:tab={settingsTab} onclose={() => (settingsOpen = false)} />{/if}
{#if HelpModal}<HelpModal bind:open={helpOpen} />{/if}
<Toasts />
