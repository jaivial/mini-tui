<script lang="ts">
  import { untrack } from "svelte";
  import { PanelLeft } from "@lucide/svelte";
  import Button from "./lib/components/Button.svelte";
  import SessionSidebar from "./lib/components/SessionSidebar.svelte";
  import SessionHeader from "./lib/components/SessionHeader.svelte";
  import Transcript from "./lib/components/Transcript.svelte";
  import Composer from "./lib/components/Composer.svelte";
  import HelpModal from "./lib/components/HelpModal.svelte";
  import RemoteHostsModal from "./lib/components/RemoteHostsModal.svelte";
  import Toasts from "./lib/components/Toasts.svelte";
  import Skeleton from "./lib/components/Skeleton.svelte";
  import PixelLoader from "./lib/components/PixelLoader.svelte";
  import Spinner from "./lib/components/Spinner.svelte";
  import SettingsModal from "./lib/components/SettingsModal.svelte";
  import { WifiOff, Settings as SettingsIcon, SquarePen, SquareSlash, Sparkles } from "@lucide/svelte";
  import { catalog } from "./lib/stores/catalog.svelte";
  import { draft } from "./lib/stores/chat.svelte";
  import { parseCommand } from "./lib/completion";
  import type { Chip } from "./lib/chips";
  import { store } from "./lib/stores/sessions.svelte";
  import { ui } from "./lib/stores/ui.svelte";
  import { toasts } from "./lib/stores/toast.svelte";
  import { api } from "./lib/api";
  import type { CreateSessionBody } from "./lib/types";

  // Below this width the sidebar no longer fits beside the transcript, so it
  // starts closed and, when opened, floats over the content instead of
  // squeezing it (which pushed the composer off-screen).
  const NARROW = 900;
  let narrow = $state(false);
  let sidebarOpen = $state(true);

  $effect(() => {
    const mq = window.matchMedia(`(max-width: ${NARROW}px)`);
    const apply = () => {
      const isNarrow = mq.matches;
      narrow = isNarrow;
      sidebarOpen = !isNarrow;
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  });
  let hostsOpen = $state(false);
  let settingsOpen = $state(false);
  let settingsTab = $state("general");
  let modelOpen = $state(false);
  let composer = $state<{ focus: () => void } | null>(null);
  let helpOpen = $state(false);
  let prompt = $state("");
  /** Commands and skills picked in the prompt bar (rendered as chips; joined to the text on send). */
  let chips = $state<Chip[]>([]);
  let scroller = $state<HTMLElement | null>(null);
  let loading = $state(true);
  let sending = $state(false);
  let switchingModel = $state(false);

  const active = $derived(store.active);

  // Enter is a staged sequence: chrome, then thread, then composer, 100ms apart.
  // Skipped on first paint only if the user asked for reduced motion (CSS).
  // The catalogue has its own effect, and reads nothing reactive here: if it shared the effect below,
  // any change to its state would re-run that one, whose cleanup closes every socket.
  $effect(() => {
    untrack(() => void catalog.warm());
  });

  $effect(() => {
    store.connect();
    store
      .load()
      .catch((error) => toasts.push("Could not reach the mini-tui server", { detail: (error as Error).message, tone: "err" }))
      .finally(() => (loading = false));
    return () => store.close();
  });

  // Keep the thread pinned to the bottom as it grows.
  $effect(() => {
    active?.events.length;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  });

  // Where a NEW chat can run. An existing chat already runs somewhere, so it shows no choice; with
  // no remote host configured there is nothing to choose either.
  const targets = $derived(active ? [] : store.hosts.map((h) => ({ id: h.id, label: h.label })));
  // A host that was deleted while selected falls back to this machine instead of failing on send.
  $effect(() => {
    if (draft.targetId !== "local" && !store.hosts.some((h) => h.id === draft.targetId)) draft.targetId = "local";
  });

  /** The model the next message will run on: the chat's own, else the draft's, else the last used. */
  const currentModel = $derived(active ? active.model : draft.model || catalog.settings?.lastModel || "");

  async function create(body: CreateSessionBody) {
    try {
      const session = await api.create(body);
      store.adopt(session);
      store.setActive(session.id);
      if (!narrow) sidebarOpen = true;
      if (body.model) void catalog.loadSettings(); // the server remembered it as the last-used model
    } catch (error) {
      toasts.push("Could not start the chat", { detail: (error as Error).message, tone: "err" });
      throw error;
    }
  }

  /** `/new`: an empty chat. Nothing is created until the first message is sent. */
  function newChat() {
    store.setActive(null);
    prompt = "";
    chips = [];
    draft.cwd = "";
    if (narrow) sidebarOpen = false;
    queueMicrotask(() => composer?.focus());
  }

  /** Run a `/command`. Returns true when the message was a command (so it is not sent to the agent). */
  async function runCommand(text: string): Promise<boolean> {
    const cmd = parseCommand(text, catalog.commands);
    if (!cmd) return false;
    if (!cmd.known) {
      toasts.push(`Unknown command /${cmd.name}`, { detail: "Type / to see the commands. Send it as a message with a leading space.", tone: "err" });
      return true; // keep the text so a typo is one edit away
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
        if (!active) toasts.push("Nothing to compact yet", { detail: "Send a message first.", tone: "info" });
        else await api.compact(active.id).catch((e) => toasts.push("Could not compact", { detail: (e as Error).message, tone: "err" }));
        break;
      case "connect":
        settingsTab = "providers";
        settingsOpen = true;
        break;
      case "settings":
        settingsTab = "general";
        settingsOpen = true;
        break;
      case "skills":
        settingsTab = "skills";
        settingsOpen = true;
        break;
      case "help":
        helpOpen = true;
        break;
    }
    prompt = "";
    chips = [];
    return true;
  }

  /** `message` arrives from the prompt bar already composed: chips first, then the typed text. */
  async function send(message: string) {
    const text = message.trim();
    const session = active;
    if (!text || sending) return;
    sending = true;
    try {
      if (await runCommand(text)) return;
      if (!session) {
        // The first message creates the session, on the target and model chosen in the draft.
        const host = store.hosts.find((h) => h.id === draft.targetId);
        await create({
          prompt: text,
          target: host ? "remote" : "local",
          hostId: host?.id,
          model: draft.model || undefined,
          cwd: draft.cwd.trim() || undefined,
        });
        prompt = "";
        chips = [];
        return;
      }
      await api.send(session.id, text);
      prompt = "";
      chips = [];
    } catch (error) {
      // The text stays in the box, so a failed send is never a lost message.
      if (session) toasts.push("Could not send", { detail: (error as Error).message, tone: "err" });
    } finally {
      sending = false;
    }
  }

  async function pickModel(id: string) {
    const session = active;
    if (!session) {
      draft.model = id; // takes effect with the first message
      return;
    }
    if (switchingModel || id === session.model) return;
    switchingModel = true;
    // Optimistic, and rolled back on failure. The session's socket confirms it either way.
    const previous = session.model;
    session.model = id;
    try {
      await api.setModel(session.id, id);
    } catch (error) {
      session.model = previous;
      toasts.push("Model switch failed", { detail: (error as Error).message, tone: "err" });
    } finally {
      switchingModel = false;
    }
  }

  const modelNote = $derived(
    !active ? "Used for your first message." : active.target === "remote" ? "Applies from the next turn." : active.status === "running" ? "Applies from the next step." : "Applies to your next message.",
  );

  async function interrupt() {
    if (!active) return;
    await api.interrupt(active.id).catch((e) => toasts.push("Could not stop", { detail: (e as Error).message, tone: "err" }));
  }

  async function closeSession(id: string) {
    await api.close(id).catch(() => {});
    store.remove(id);
  }

  // Ctrl/Cmd+K starts a new chat, Ctrl/Cmd+, opens settings, Ctrl/Cmd+B toggles the sidebar.
  function onkey(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      newChat();
    } else if ((event.metaKey || event.ctrlKey) && event.key === ",") {
      event.preventDefault();
      settingsTab = "general";
      settingsOpen = true;
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
      event.preventDefault();
      sidebarOpen = !sidebarOpen;
    }
  }
</script>

<svelte:window onkeydown={onkey} />

<div class="relative flex h-full w-full overflow-hidden bg-canvas text-ink">
  {#if sidebarOpen && narrow}
    <!-- Scrim: closes the drawer when tapped outside it. -->
    <button
      class="absolute inset-0 z-40 cursor-default bg-black/40"
      aria-label="Close sidebar"
      onclick={() => (sidebarOpen = false)}
    ></button>
  {/if}
  {#if sidebarOpen}
    <div
      class="enter-1 {narrow
        ? 'absolute inset-y-0 left-0 z-50'
        : 'relative'}"
    >
      <SessionSidebar
        onnew={newChat}
        onsettings={() => {
          settingsTab = "general";
          settingsOpen = true;
        }}
        onopenhosts={() => (hostsOpen = true)}
        onclosesession={closeSession}
        onhidesidebar={() => (sidebarOpen = false)}
        {loading}
      />
    </div>
  {/if}

  <div class="flex min-w-0 flex-1 flex-col">
    {#if active}
      <div class="enter-2 relative z-30">
        <SessionHeader
          session={active}
          onnew={newChat}
          ontoggleSidebar={() => (sidebarOpen = !sidebarOpen)}
          onopenhosts={() => (hostsOpen = true)}
          onclosesession={() => closeSession(active.id)}
        />
      </div>

      <main bind:this={scroller} class="enter-3 relative z-0 min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 max-sm:px-3 max-sm:py-4">
        <div class="mx-auto max-w-3xl">
          {#if !store.hydrated[active.id] && !active.events.length}
            <!-- The transcript is on its way over this session's socket: hold the shape of it. -->
            <div class="flex flex-col gap-4 py-2" role="status" aria-label="Loading conversation">
              <Skeleton class="h-4 w-2/5" />
              <Skeleton class="h-16 w-full" />
              <Skeleton class="h-4 w-3/5" />
              <Skeleton class="h-10 w-full" />
            </div>
          {:else}
            <Transcript events={active.events} partial={active.partial} />
            {#if !active.events.length}
              <div class="py-16 text-center">
                <p class="text-[13px] text-ink-muted">Nothing here yet.</p>
                <p class="mt-1 text-[12px] text-ink-muted">Send a prompt to start this session.</p>
              </div>
            {/if}
          {/if}
        </div>
      </main>

      <!-- Status line above the prompt bar: reconnecting beats working, since a stale transcript matters more. -->
      {#if store.activeLink === "reconnecting" || store.activeLink === "connecting"}
        <div class="mx-auto flex w-full max-w-3xl items-center gap-2 px-4 pb-1 text-[12.5px] text-ink-muted max-sm:px-3" role="status">
          <WifiOff size={13} strokeWidth={2} aria-hidden="true" />
          {store.activeLink === "connecting" ? "Connecting to this session" : "Connection lost. Reconnecting"}<Spinner size={12} label="" />
        </div>
      {:else if active.status === "running"}
        <div class="mx-auto w-full max-w-3xl px-4 pb-1.5 max-sm:px-3">
          <PixelLoader label={active.partial?.text ? "Writing" : active.partial?.thinking ? "Thinking" : "Working"} since={active.startedAt} />
        </div>
      {/if}

      <div class="enter-4">
        <Composer
          bind:this={composer}
          bind:value={prompt}
          bind:chips
          bind:modelOpen
          running={active.status === "running"}
          {sending}
          model={currentModel}
          {switchingModel}
          {modelNote}
          onsend={send}
          oninterrupt={interrupt}
          onmodel={pickModel}
        />
      </div>
    {:else}
      <!-- A new chat. Nothing exists on the server yet: the first message creates the session. -->
      <header class="relative z-30 flex min-h-13 shrink-0 items-center gap-2 border-b border-line/80 px-3.5 py-1.5 pt-[max(0.375rem,env(safe-area-inset-top))]">
        {#if narrow}
          <!-- The one place to reach the session list from a new chat on a phone. -->
          <Button variant="ghost" size="icon-sm" icon={PanelLeft} title="Open sessions" aria-label="Open sessions" onclick={() => (sidebarOpen = true)} />
        {/if}
        <h1 class="min-w-0 flex-1 truncate text-[13.5px] font-semibold">New chat</h1>
        <Button variant="ghost" size="icon-sm" icon={SettingsIcon} title="Settings" aria-label="Settings" onclick={() => { settingsTab = "general"; settingsOpen = true; }} />
      </header>

      <main class="relative z-0 flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto overscroll-contain px-4 py-8 max-sm:px-3">
        <div class="enter-3 flex w-full max-w-xl flex-col items-center gap-5 text-center">
          <div class="grid size-11 place-items-center rounded-lg bg-brand text-brand-ink" aria-hidden="true"><SquarePen size={20} strokeWidth={2} /></div>
          <div>
            <h2 class="text-[20px] font-semibold tracking-tight">What should we work on?</h2>
            <p class="mt-1.5 text-[13.5px] text-ink-muted">
              {draft.targetId === "local" ? "Runs on this machine." : `Runs headless on ${store.hosts.find((h) => h.id === draft.targetId)?.label ?? "the remote host"}.`}
              The chat starts when you send your first message.
            </p>
          </div>
          <!-- Starters: each one fills the prompt bar, none sends. -->
          <ul class="flex flex-wrap justify-center gap-2" aria-label="Starters">
            <li><button type="button" class="interactive inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-md border border-line px-3 text-[12.5px] text-ink-muted hover:bg-raised hover:text-ink pointer-coarse:min-h-11" onclick={() => { prompt = "/"; chips = []; composer?.focus(); }}><SquareSlash size={14} strokeWidth={1.75} aria-hidden="true" />Commands</button></li>
            <li><button type="button" class="interactive inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-md border border-line px-3 text-[12.5px] text-ink-muted hover:bg-raised hover:text-ink pointer-coarse:min-h-11" onclick={() => { prompt = "$"; composer?.focus(); }}><Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />Skills</button></li>
            <li><button type="button" class="interactive min-h-9 cursor-pointer rounded-md border border-line px-3 text-[12.5px] text-ink-muted hover:bg-raised hover:text-ink pointer-coarse:min-h-11" onclick={() => { settingsTab = "providers"; settingsOpen = true; }}>Connect a provider</button></li>
          </ul>
          {#if loading}
            <Skeleton class="h-3 w-28" />
          {:else if store.list.length}
            <p class="tnum text-[12.5px] text-ink-muted">{store.open.length} open · {store.list.length} total</p>
          {/if}
        </div>
      </main>
      <Composer
        bind:this={composer}
        bind:value={prompt}
        bind:chips
        bind:modelOpen
        {sending}
        {targets}
        targetId={draft.targetId}
        ontarget={(id) => (draft.targetId = id)}
        model={currentModel}
        {modelNote}
        onsend={send}
        oninterrupt={interrupt}
        onmodel={pickModel}
      />
    {/if}
  </div>
</div>

<RemoteHostsModal bind:open={hostsOpen} />
<SettingsModal bind:open={settingsOpen} bind:tab={settingsTab} onclose={() => (settingsOpen = false)} />
<HelpModal bind:open={helpOpen} />
<Toasts />

<style>
  /* Split and stagger enter: semantic chunks, 100ms apart, ease-out. */
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
  .enter-1, .enter-2, .enter-3, .enter-4 {
    animation: rise 320ms cubic-bezier(0.2, 0, 0, 1) both;
  }
  .enter-1 { animation-delay: 0ms; }
  .enter-2 { animation-delay: 100ms; }
  .enter-3 { animation-delay: 200ms; }
  .enter-4 { animation-delay: 300ms; }
  @media (prefers-reduced-motion: reduce) {
    .enter-1, .enter-2, .enter-3, .enter-4 { animation: none; }
  }
</style>
