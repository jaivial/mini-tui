<script lang="ts">
  import { tick } from "svelte";
  import { PanelLeft, WifiOff, SquarePen, SquareSlash, Sparkles, RotateCcw, NotebookPen, Settings as SettingsIcon } from "@lucide/svelte";
  import Button from "./Button.svelte";
  import SessionHeader from "./SessionHeader.svelte";
  import Transcript from "./Transcript.svelte";
  import Composer from "./Composer.svelte";
  import Skeleton from "./Skeleton.svelte";
  import PixelLoader from "./PixelLoader.svelte";
  import Spinner from "./Spinner.svelte";
  import NotesPanel from "./NotesPanel.svelte";
  import PaneMenu from "./PaneMenu.svelte";
  import FolderPicker from "./FolderPicker.svelte";
  import { rememberRecent } from "../folderPath";
  import { catalog } from "../stores/catalog.svelte";
  import { store } from "../stores/sessions.svelte";
  import { panes, type Pane } from "../stores/panes.svelte";
  import { toasts } from "../stores/toast.svelte";
  import { api } from "../api";
  import { parseCommand } from "../completion";
  import { splitSent } from "../promptMemory";

  /**
   * One pane: a chat (a session, or a new chat until its first message) with its own header, transcript,
   * prompt bar and notes. Everything it holds lives in the pane store, so a split that remounts it loses
   * nothing. Commands and the model picker act on this pane; app-wide things (settings, resume, help)
   * go up through `onapp`.
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
  } = $props();

  const session = $derived(pane.sessionId ? (store.sessions[pane.sessionId] ?? null) : null);
  const focused = $derived(panes.focusedId === pane.id);
  const link = $derived(session ? (store.links[session.id] ?? "idle") : "idle");

  let composer = $state<{ focus: () => void } | null>(null);
  let notes = $state<{ focus: () => void } | null>(null);
  let scroller = $state<HTMLElement | null>(null);
  let modelOpen = $state(false);
  let sending = $state(false);
  let switchingModel = $state(false);

  export function focusComposer() {
    composer?.focus();
  }
  export function focusNotes() {
    notes?.focus();
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

  // Keep the thread pinned to the bottom as it grows.
  $effect(() => {
    session?.events.length;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  });

  // Where a NEW chat can run. An existing chat already runs somewhere, so it shows no choice.
  const targets = $derived(session ? [] : store.hosts.map((h) => ({ id: h.id, label: h.label })));
  $effect(() => {
    if (pane.draft.targetId !== "local" && !store.hosts.some((h) => h.id === pane.draft.targetId)) pane.draft.targetId = "local";
  });

  const currentModel = $derived(session ? session.model : pane.draft.model || catalog.settings?.lastModel || "");
  const modelNote = $derived(
    !session ? "Used for your first message." : session.target === "remote" ? "Applies from the next turn." : session.status === "running" ? "Applies from the next step." : "Applies to your next message.",
  );

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
      case "split":
        onsplit(cmd.arg === "down" || cmd.arg === "v" ? "col" : "row");
        break;
      case "notes":
        panes.toggleNotes(pane.id, true);
        void tick().then(() => notes?.focus());
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
    if (!text || sending) return;
    sending = true;
    try {
      if (await runCommand(text)) return;
      if (!current) {
        // The first message creates the session, on the target and model chosen in this pane's draft.
        const host = store.hosts.find((h) => h.id === pane.draft.targetId);
        // Read the draft now: showing the new session resets the pane's draft.
        const draft = { ...pane.draft, cwd: pane.draft.cwd.trim() };
        try {
          const created = await api.create({
            prompt: text,
            target: host ? "remote" : "local",
            hostId: host?.id,
            model: draft.model || undefined,
            cwd: draft.cwd || undefined,
          });
          if (draft.cwd) rememberRecent(draft.targetId, created.cwd || draft.cwd);
          store.adopt(created);
          panes.show(pane.id, created.id);
          if (draft.model) void catalog.loadSettings();
        } catch (error) {
          toasts.push("Could not start the chat", { detail: (error as Error).message, tone: "err" });
          return;
        }
        pane.prompt = "";
        pane.chips = [];
        return;
      }
      await api.send(current.id, text);
      pane.prompt = "";
      pane.chips = [];
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

  /** Opening moves focus into the notes (after the panel has rendered); closing leaves it on the button. */
  async function toggleNotes() {
    panes.toggleNotes(pane.id);
    if (!pane.notesOpen) return;
    await tick();
    notes?.focus();
  }
</script>

{#snippet folder()}
  {@const host = store.hosts.find((h) => h.id === pane.draft.targetId)}
  <FolderPicker
    value={pane.draft.cwd}
    target={pane.draft.targetId}
    targetLabel={host ? host.label : "this machine"}
    defaultLabel={host ? (host.workdir ? `Host folder (${host.workdir})` : "Host home folder") : "Server folder"}
    onpick={(path) => (pane.draft.cwd = path)}
  />
{/snippet}

{#snippet tools()}
  <Button
    variant="ghost"
    size="icon-sm"
    icon={NotebookPen}
    title={pane.notesOpen ? "Hide notes" : "Notes"}
    aria-label={pane.notesOpen ? "Hide notes" : "Show notes"}
    aria-pressed={pane.notesOpen}
    active={pane.notesOpen}
    onclick={toggleNotes}
  />
  <PaneMenu {tabs} {canRight} {canDown} limitReached={!panes.canSplit} canClose={total > 1} {onsplit} onclose={onclosepane} oncloseSession={session ? closeSession : undefined} />
{/snippet}

<!--
  The pane is a query container: its header and prompt bar lay themselves out for the pane's width.
  Focus is shown by a brand hairline on the pane's edge (and `aria-current`), not by motion.
-->
<section
  class="pane relative flex min-h-0 min-w-0 flex-1 bg-canvas"
  class:is-focused={focused && total > 1}
  aria-label="Pane {number}{session ? `: ${session.title || 'Untitled'}` : ': new chat'}"
  aria-current={focused && total > 1 ? "true" : undefined}
  data-pane={pane.id}
  onfocusin={() => panes.focus(pane.id)}
  onpointerdown={() => panes.focus(pane.id)}
>
  <div class="flex min-h-0 min-w-0 flex-1 flex-col">
    {#if session}
      <div class="relative z-30">
        <SessionHeader
          {session}
          onnew={newChat}
          ontoggleSidebar={ontogglesidebar}
          onopenhosts={() => onapp("hosts")}
          onclosesession={closeSession}
          showSidebarToggle={first}
          paneTools={tools}
        />
      </div>

      <main bind:this={scroller} class="relative z-0 min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 pane-sm:px-3 pane-sm:py-4">
        <div class="mx-auto max-w-3xl">
          {#if !store.hydrated[session.id] && !session.events.length}
            <div class="flex flex-col gap-4 py-2" role="status" aria-label="Loading conversation">
              <Skeleton class="h-4 w-2/5" />
              <Skeleton class="h-16 w-full" />
              <Skeleton class="h-4 w-3/5" />
              <Skeleton class="h-10 w-full" />
            </div>
          {:else}
            <Transcript events={session.events} partial={session.partial} />
            {#if !session.events.length}
              <div class="py-16 text-center">
                <p class="text-[13px] text-ink-muted">Nothing here yet.</p>
                <p class="mt-1 text-[12px] text-ink-muted">Send a prompt to start this session.</p>
              </div>
            {/if}
          {/if}
        </div>
      </main>

      {#if link === "reconnecting" || link === "connecting"}
        <div class="mx-auto flex w-full max-w-3xl items-center gap-2 px-4 pb-1 text-[12.5px] text-ink-muted pane-sm:px-3" role="status">
          <WifiOff size={13} strokeWidth={2} aria-hidden="true" />
          {link === "connecting" ? "Connecting to this session" : "Connection lost. Reconnecting"}<Spinner size={12} label="" />
        </div>
      {:else if session.status === "running"}
        <div class="mx-auto w-full max-w-3xl px-4 pb-1.5 pane-sm:px-3">
          <PixelLoader label={session.partial?.text ? "Writing" : session.partial?.thinking ? "Thinking" : "Working"} since={session.startedAt} />
        </div>
      {/if}

      <Composer
        bind:this={composer}
        bind:value={pane.prompt}
        bind:chips={pane.chips}
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
    {:else}
      <!-- A new chat. Nothing exists on the server yet: the first message creates the session. -->
      <header class="relative z-30 flex min-h-13 shrink-0 items-center gap-1 border-b border-line/80 px-3.5 py-1.5">
        {#if first}
          <Button variant="ghost" size="icon-sm" icon={PanelLeft} title="Toggle sidebar" aria-label="Toggle sidebar" onclick={ontogglesidebar} />
        {/if}
        <h1 class="min-w-0 flex-1 truncate px-1 text-[13.5px] font-semibold">New chat</h1>
        <Button variant="ghost" size="icon-sm" icon={SettingsIcon} title="Settings" aria-label="Settings" onclick={() => onapp("settings")} />
        {@render tools()}
      </header>

      <main class="relative z-0 flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto overscroll-contain px-4 py-8 pane-sm:px-3">
        <div class="enter-3 flex w-full max-w-xl flex-col items-center gap-5 text-center">
          <div class="grid size-11 place-items-center rounded-lg bg-brand text-brand-ink" aria-hidden="true"><SquarePen size={20} strokeWidth={2} /></div>
          <div>
            <h2 class="text-[20px] font-semibold tracking-tight pane-xs:text-[17px]">What should we work on?</h2>
            <p class="mt-1.5 text-[13.5px] text-ink-muted">
              {pane.draft.targetId === "local" ? "Runs on this machine" : `Runs headless on ${store.hosts.find((h) => h.id === pane.draft.targetId)?.label ?? "the remote host"}`}{#if pane.draft.cwd}{" "}in <span class="font-mono text-ink">{pane.draft.cwd}</span>{/if}.
              The chat starts when you send your first message.
            </p>
          </div>
          <ul class="flex flex-wrap justify-center gap-2" aria-label="Starters">
            <li><button type="button" class="starter" onclick={() => { pane.prompt = "/"; pane.chips = []; composer?.focus(); }}><SquareSlash size={14} strokeWidth={1.75} aria-hidden="true" />Commands</button></li>
            <li><button type="button" class="starter" onclick={() => { pane.prompt = "$"; composer?.focus(); }}><Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />Skills</button></li>
            <li><button type="button" class="starter" onclick={() => onapp("resume")}><RotateCcw size={14} strokeWidth={1.75} aria-hidden="true" />Resume a session</button></li>
            <li><button type="button" class="starter" onclick={() => onapp("providers")}>Connect a provider</button></li>
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
        bind:value={pane.prompt}
        bind:chips={pane.chips}
        bind:modelOpen
        {sending}
        {targets}
        targetId={pane.draft.targetId}
        ontarget={(id) => {
          // Another machine, another file system: a folder picked on one means nothing on the other.
          if (id !== pane.draft.targetId) pane.draft.cwd = "";
          pane.draft.targetId = id;
        }}
        place={folder}
        model={currentModel}
        {modelNote}
        onsend={send}
        oninterrupt={interrupt}
        onmodel={pickModel}
        memory={pane.memory}
      />
    {/if}
  </div>

  {#if pane.notesOpen}
    <!--
      The notes sidebar sits on the pane's right. In a wide pane it is a column beside the chat; in a
      narrow one it covers the chat (the chat is still one tap away), since two squeezed columns are
      worse than one full one.
    -->
    <div class="notes-slot flex min-h-0 shrink-0 border-l border-line/80">
      <NotesPanel bind:this={notes} noteId={session?.id ?? null} title={session?.title ?? ""} onclose={() => panes.toggleNotes(pane.id, false)} />
    </div>
  {/if}
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
    width: clamp(16rem, 32%, 24rem);
  }
  @container pane (width < 44rem) {
    .notes-slot {
      position: absolute;
      inset: 0 0 0 auto;
      width: min(100%, 24rem);
      z-index: 36;
      box-shadow: -12px 0 32px -12px oklch(0 0 0 / 0.35);
    }
  }
  @container pane (width < 26rem) {
    .notes-slot {
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
