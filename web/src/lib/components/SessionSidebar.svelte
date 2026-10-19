<script lang="ts">
  import { tick, untrack } from "svelte";
  import { Search, Server, Square, ChevronRight, PanelLeftClose, X, Pencil, Plus } from "@lucide/svelte";
  import Age from "./Age.svelte";
  import Button from "./Button.svelte";
  import Skeleton from "./Skeleton.svelte";
  import Mascot from "./Mascot.svelte";
  import Avatar from "./Avatar.svelte";
  import { store } from "../stores/sessions.svelte";
  import { statusLine } from "../mascot";
  import { partitionBots } from "../botGroups";
  import { botProgress, progressLabel, runningLabel } from "../botRows";
  import { createRenameField } from "../renameField";
  import { agentTree, type BotRow } from "../stores/agentTree.svelte";
  import type { SessionState, SessionTask } from "../types";

  /**
   * The bots list (Jaime's v6 spec): a search box and one card per bot. Nothing else — the
   * header's actions, the "Windows" concept, the folder view and the History section are gone
   * from here; what is left is a room of pets you pick a chat from.
   *
   * Each row reads like the mockup's: the squishmoji on the left, the title in semibold, a quiet
   * line under it with the state in words, and the trailing counters that say how far the bot has
   * got (tasks done/total) and how many delegates are working under it right now. Rows are cards
   * with 18px corners (the Apple/iOS radius this iteration asked for).
   *
   * Phone: the rail is the whole screen, its own scroller, dismissed with the header's X (the
   * backdrop behind it and a swipe right both do the same). `full` is passed by the shell.
   */
  let {
    onnew,
    onhidesidebar,
    onclosesession,
    onopen,
    onrenamebot,
    openingId = "",
    taskCards = [],
    paneOf = () => 0,
    focusedSession = null,
    loading = false,
    full = false,
    class: klass = "",
  }: {
    onnew: () => void;
    /** Collapse the sidebar itself (or slide it away on a phone). */
    onhidesidebar: () => void;
    /** Close one session by id (stop it and drop it from the list). */
    onclosesession: (id: string) => void;
    /** Open a session in the focused pane (or focus the pane already showing it). */
    onopen: (id: string) => void;
    /** v5-A: rename a bot's session (an empty title keeps the old one). */
    onrenamebot?: (id: string, title: string) => void;
    /** A saved session being opened right now. */
    openingId?: string;
    /** The whole task board, as the hub pushes it: the bots' cards for the row counters. */
    taskCards?: SessionTask[];
    /** Number of the pane showing a session, 0 when none. */
    paneOf?: (id: string) => number;
    /** The session in the focused pane: that row is the highlighted one. */
    focusedSession?: string | null;
    /** The first session list is still on its way. */
    loading?: boolean;
    /** Phone: take the whole screen (the shell passes it, not a media query). */
    full?: boolean;
    class?: string;
  } = $props();

  let railEl: HTMLElement | null = null;
  let filter = $state("");
  let query = $derived(filter.trim().toLowerCase());

  const matches = (session: SessionState) =>
    !query ||
    session.title.toLowerCase().includes(query) ||
    session.cwd.toLowerCase().includes(query) ||
    session.model.toLowerCase().includes(query);

  const byStart = (a: { createdAt: number; id: string }, b: { createdAt: number; id: string }) =>
    b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  // A delegate (`<parent>~<name>`) is a task of its bot: it lives nested under it (agentTree) and is
  // never a top-level bot, whether or not it has been opened.
  const visible = $derived(store.list.filter((s) => !s.parentId && !s.id.includes("~")).filter(matches));
  // Stable while live: a running session's `updatedAt` changes on every step, which would reshuffle
  // these rows constantly. Live rows keep the order they were started in; the others stay newest
  // first. One partition, not three independent filters — see botGroups.ts for why that matters.
  const buckets = $derived(partitionBots(visible, byStart));
  /** Bots in reading order: working first, then the quiet open ones, then the finished. */
  const bots = $derived([...buckets.live, ...buckets.idle, ...buckets.done]);

  // ---- What each row shows under the title. The card gives the task numbers, the agent tree
  // gives the delegates working under this bot right now.
  const cardOf = (id: string) => taskCards.find((t) => t.id === id) ?? null;
  const treeOf = (id: string): { rows: BotRow[]; live: number; total: number } => agentTree.trees[id] ?? { rows: [], live: 0, total: 0 };
  const progressOf = (id: string) => botProgress(cardOf(id), treeOf(id).live);
  /** Delegates working anywhere in the team, for the header's Team map badge. */
  const liveTeam = $derived(bots.reduce((n, s) => n + treeOf(s.id).live, 0));

  // One shared poller, fed exactly the sessions this list shows: a bot that goes away stops being
  // polled too. The Team map reads the same store.
  //
  // Only the ids go in, and they are snapshotted with `untrack`: `agentTree.sync` writes to the
  // store's `$state`, and a row's counters read that same state back through `treeOf`. Letting the
  // effect depend on it makes it feed itself — every poll tick (3s) re-runs the effect, which
  // re-runs the effect, until Svelte throws `effect_update_depth_exceeded`. The list of ids is all
  // this effect actually needs, so that is all it may read.
  $effect(() => {
    // The ids are READ tracked (a new bot must re-run this: the team map and the nested rows came up
    // empty for any session opened after mount); only the store write is untracked.
    const ids = bots.map((s) => s.id);
    untrack(() => agentTree.sync(ids));
  });

  const BOT_DOT: Record<BotRow["tone"], string> = {
    live: "bg-live pulse-live",
    ok: "bg-ok",
    err: "bg-err",
    wait: "bg-warn",
    warn: "bg-warn",
    idle: "bg-line-strong",
  };

  // ---- Renaming a bot: the pencil (or a double-click) turns the title into a one-line input.
  //
  // The rules live in `renameField.ts` (E20); what is left here is the wiring: hand it the
  // row's current title whenever the store moves, paint what it reports, and put the focus
  // where a person expects it — into the field when it opens, back on the row when it closes.
  //
  // `editing` is a plain `$state` mirror, NOT a `$derived` of the machine: the machine is an
  // ordinary object of getters, and Svelte cannot see those change, so a `$derived` over it
  // is frozen at its first value and the field never opens. The mirror is what the template
  // reads, and every path that opens or closes an edit writes it.
  const rename = createRenameField({ onSave: (id, title) => onrenamebot?.(id, title) });
  let editing = $state("");
  let draft = $state("");
  /**
   * The title that arrived underneath a dirty draft, mirrored into `$state` for the same
   * reason as `editing`: the machine is an object of plain getters and Svelte cannot see
   * those change, so the template has to read something reactive.
   */
  let conflict = $state<string | null>(null);
  let renameEl = $state<HTMLInputElement | null>(null);
  /** The row that had the field open, so closing can hand the focus back to it. */
  let renameRow = $state<HTMLElement | null>(null);

  // The store is the truth about the title, and it moves under the field's feet (a WhatsApp
  // `/rename`, the other client, the AI title). Reconcile on every change, or the draft
  // silently reverts whoever renamed it while this field sat open.
  $effect(() => {
    const id = editing;
    if (!id) {
      conflict = null;
      return;
    }
    const live = store.sessions[id]?.title ?? "";
    rename.sync(live);
    draft = rename.draft;
    conflict = rename.conflict;
  });

  const startRename = async (bot: { id: string; title: string }) => {
    renameRow = railEl?.querySelector<HTMLElement>(`[data-bot="${CSS.escape(bot.id)}"]`) ?? null;
    rename.open({ id: bot.id, title: bot.title });
    editing = bot.id;
    draft = rename.draft;
    conflict = rename.conflict;
    await tick();
    // Focus the field itself, and select what is in it: the whole point of opening a rename
    // is to replace the name, not to append to it.
    renameEl?.focus();
    renameEl?.select();
  };

  /** Leave the field: the write (if any) then the focus back on the row it came from. */
  const endRename = async () => {
    const row = renameRow;
    rename.cancel();
    editing = "";
    draft = "";
    conflict = null;
    renameRow = null;
    await tick();
    row?.querySelector<HTMLElement>("[data-nav]")?.focus();
  };

  const commitRename = async () => {
    rename.commit();
    draft = rename.draft;
    conflict = rename.conflict;
    // The first Enter after a conflict only announces it (see `renameField.ts`), so the field
    // must stay open, keep its draft and keep the focus.
    if (rename.editing) return;
    await endRename();
  };

  // ---- The work folded under a bot: its task card, then the delegates it is running.
  let open = $state<Record<string, boolean>>({});
  const isOpen = (id: string) => open[id] ?? false;
  function toggle(id: string) {
    open = { ...open, [id]: !isOpen(id) };
  }

  // ---- Keyboard: ↑/↓ walks the visible rows and Enter opens the one under the caret. On the
  // window, so the non-interactive `<aside>` itself never takes an event listener; anything
  // typed outside the rail (the chat, the composer) is ignored.
  function roving(e: KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rail = railEl;
    const t = e.target as HTMLElement | null;
    if (!rail || !t || !rail.contains(t)) return;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
    const rows = Array.from(rail.querySelectorAll<HTMLElement>("[data-nav]")).filter((el) => el.offsetParent !== null);
    if (!rows.length) return;
    e.preventDefault();
    const at = rows.indexOf(document.activeElement as HTMLElement);
    rows[at === -1 ? 0 : e.key === "ArrowDown" ? Math.min(rows.length - 1, at + 1) : Math.max(0, at - 1)]?.focus();
  }
</script>

<style>
  /* The rail sizes itself (drag handle), so its rows react to its width, not the window's. */
  .rail {
    container: rail / inline-size;
  }

  /* A narrow rail still gets the row actions, but small ones: three 32px buttons would
     cover the whole card title at the 200px floor. */
  @container rail (width < 240px) {
    .bot-actions {
      gap: 0;
      padding: 1px;
    }
    .bot-actions :global(button) {
      height: 1.5rem;
      width: 1.5rem;
      min-height: 1.5rem;
    }
  }
</style>


<svelte:window onkeydown={roving} />

<aside
  bind:this={railEl}
  class="rail flex h-full min-h-0 w-full flex-col bg-canvas pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] {klass}"
  aria-label="Bots"
>
  <!-- The rail's own header: what it is, the connection, and the way out. -->
  <div class="flex shrink-0 items-center gap-2 px-4 pt-3 pb-2">
    <Avatar id="mini-tui" size={26} />
    <span class="shrink-0 text-[15px] leading-5 font-semibold tracking-[-0.01em]">Bots</span>
    <span class="min-w-0 flex-1" aria-hidden="true"></span>
    <!--
      The connection state is a dot, not a word: it is ambient information and
      never needs a full line of the rail.
    -->
    <span
      class="size-2 shrink-0 rounded-full {store.connected ? 'bg-ok' : 'pulse-live bg-warn'}"
      title={store.connected ? "Connected" : "Reconnecting…"}
    ></span>
    <Button variant="ghost" size="icon" icon={Plus} title="New bot" aria-label="New bot" onclick={onnew} />
    <Button variant="ghost" size="icon" icon={full ? X : PanelLeftClose} title={full ? "Close" : "Hide sidebar"} aria-label={full ? "Close the bots list" : "Hide sidebar"} onclick={onhidesidebar} />
  </div>

  <!-- Search, and nothing else above the list. -->
  <div class="shrink-0 px-4 pb-3">
    <div class="relative">
      <Search size={15} strokeWidth={2} class="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-ink-faint" aria-hidden="true" />
      <input
        bind:value={filter}
        placeholder="Search"
        aria-label="Search bots"
        class="h-11 w-full rounded-[18px] border border-line bg-raised pr-3.5 pl-10 text-base text-ink placeholder:text-ink-faint
          focus:border-brand focus:bg-canvas focus:outline-none"
      />
    </div>
  </div>

  <!-- The bots. This is the whole rail. -->
  <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-[max(1rem,env(safe-area-inset-bottom))]" role="list" aria-label="Bots">
    {#each bots as session (session.id)}
      {@const tree = treeOf(session.id)}
      {@const progress = progressOf(session.id)}
      {@const card = cardOf(session.id)}
      {@const openRow = isOpen(session.id)}
      <div role="listitem" class="mb-1.5" data-bot={session.id}>
        <div
          class="group/botrow relative flex items-center rounded-[18px] {focusedSession === session.id ? 'bg-raised' : 'hover:bg-raised/70'}"
        >
          <!-- No leading slot: the card uses the full width. The fold chevron lives in the hover actions. -->
          {#if editing === session.id}
            <!--
              v5-A: the title becomes a one-line input; Enter renames, Escape backs out.
              E20: the field is a real edit, so it behaves like one — it takes the focus when
              it opens (`startRename`), it hands it back when it closes, it only writes a
              title that actually changed, and it says so when the row was renamed underneath
              it instead of quietly reverting that rename.
            -->
            <div class="min-w-0 flex-1">
              <input
                bind:this={renameEl}
                value={draft}
                oninput={(e) => {
                  draft = e.currentTarget.value;
                  rename.type(draft);
                  conflict = rename.conflict;
                }}
                aria-label="Rename {session.title || 'Untitled'}"
                aria-describedby={conflict ? `rename-hint-${session.id}` : undefined}
                aria-invalid={conflict ? "true" : undefined}
                class="h-8 w-full min-w-0 rounded-lg border bg-canvas px-2 text-[14px] text-ink focus:outline-none {conflict ? "border-err" : "border-brand"}"
                onkeydown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void commitRename();
                  } else if (e.key === "Escape") {
                    // Escape must not fall through to `onblur`'s commit: it is the way out
                    // that writes nothing.
                    e.preventDefault();
                    void endRename();
                  }
                }}
                onblur={() => {
                  // Only a real departure commits. `endRename` moving the focus itself fires
                  // this too, and by then the edit is already closed.
                  if (rename.editing) void commitRename();
                }}
              />
              {#if conflict}
                <p id="rename-hint-{session.id}" class="mt-0.5 truncate text-[11px] leading-4 text-err">
                  Already renamed to “{conflict}” — Enter again to overwrite
                </p>
              {/if}
            </div>
          {:else}
            <button
              data-nav
              type="button"
              class="interactive flex min-h-14 min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-[18px] px-2 text-left max-md:pr-[9.5rem]"
              onclick={() => onopen(session.id)}
              ondblclick={(e) => {
                // A double-click is also two clicks, and a single click OPENS the session:
                // renaming from here used to switch panes twice on the way to the field.
                e.preventDefault();
                void startRename(session);
              }}
              title={session.title}
              aria-current={focusedSession === session.id ? "true" : undefined}
            >
              <span class="relative shrink-0">
                <Avatar id={session.id} size={44} />
                <!--
                  Presence dot, Slack's rule: sunset + pulse only means "working right now",
                  the quiet colours are states that need no attention.
                -->
                <span
                  class="absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-canvas {session.status === 'running'
                    ? 'pulse-live bg-live'
                    : session.status === 'done'
                      ? 'bg-ok'
                      : session.status === 'error'
                        ? 'bg-err'
                        : session.status === 'interrupted'
                          ? 'bg-warn'
                          : 'bg-line-strong'}"
                ></span>
              </span>
              <span class="min-w-0 flex-1">
                <span class="flex items-center gap-1.5">
                  {#if session.target === "remote"}
                    <Server size={13} class="shrink-0 text-accent" strokeWidth={2} />
                  {/if}
                  <span class="min-w-0 flex-1 truncate text-[14.5px] leading-5 font-semibold tracking-[-0.01em] text-ink">{session.title || "Untitled"}</span>
                  {#if paneOf(session.id)}
                    <!-- Which pane shows it: a number, like tmux's pane index. -->
                    <span class="tnum grid h-4 min-w-4 shrink-0 place-items-center rounded-sm bg-overlay px-1 text-[10px] font-semibold text-ink-muted" title="Shown in pane {paneOf(session.id)}">
                      <span aria-hidden="true">{paneOf(session.id)}</span><span class="sr-only">in pane {paneOf(session.id)}</span>
                    </span>
                  {/if}
                </span>
                <!--
                  Under the title, left to right: the state, how far its task card has got, and when
                  it last moved. The time took the slot the cost used to hold (v6-G: the cost is out
                  of this list, the relative time came down from the trailing column), and the
                  running delegate count is the one thing that stayed at the right edge, where a
                  changing figure is read at a glance.
                -->
                <span class="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-ink-muted">
                  <span class="truncate {session.status === 'running' ? 'font-medium text-live' : ''}">{statusLine(session.status)}</span>
                  {#if progressLabel(progress)}
                    <span
                      class="tnum shrink-0 rounded-full bg-overlay px-1.5 text-[11px] leading-4 font-semibold text-ink-muted"
                      title="{progress.done} of {progress.total} tasks done"
                    >{progressLabel(progress)}</span>
                  {/if}
                  <Age at={session.updatedAt} class="ml-auto shrink-0 text-[11.5px] leading-4 text-ink-faint" />
                </span>
              </span>
              {#if runningLabel(progress)}
                <!-- Delegates working under this bot right now: the only trailing figure left. -->
                <span
                  class="flex shrink-0 items-center gap-1 text-[11px] leading-4 font-medium text-live"
                  title="{progress.running} delegate{progress.running === 1 ? '' : 's'} working"
                >
                  <span class="pulse-live size-1.5 shrink-0 rounded-full bg-live" aria-hidden="true"></span>
                  <span class="tnum">{progress.running}</span>
                </span>
              {/if}
            </button>
          {/if}

          <!-- Per-row actions fade in on hover/focus, and are always there under a finger. -->
          <div class="bot-actions absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5 rounded-full bg-raised p-0.5 opacity-0 shadow-sm ring-1 ring-line group-hover/botrow:opacity-100 group-focus-within/botrow:opacity-100 max-md:top-1 max-md:right-1.5 max-md:translate-y-0 max-md:opacity-100">
            {#if tree.total || card}
              <Button
                variant="ghost"
                size="icon-sm"
                icon={ChevronRight}
                class="[&_svg]:transition-[rotate] [&_svg]:duration-150 {openRow ? '[&_svg]:rotate-90' : ''}"
                title={openRow ? "Hide its work" : "Show its work"}
                aria-expanded={openRow}
                aria-label={openRow ? `Hide ${session.title || 'Untitled'}'s work` : `Show ${session.title || 'Untitled'}'s work`}
                onclick={() => toggle(session.id)}
              />
            {/if}
            <Button
              variant="ghost"
              size="icon-sm"
              icon={Square}
              title={session.status === "running" ? "Interrupt" : "Close bot"}
              onclick={() => onclosesession(session.id)}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              icon={Pencil}
              title="Rename"
              aria-label="Rename {session.title || 'Untitled'}"
              onclick={() => void startRename(session)}
            />
          </div>
        </div>

        {#if openRow}
          <!-- Its work, indented under the name: the task card, then the delegates it is running. -->
          <div class="mb-1 ml-2 flex flex-col items-stretch gap-px" role="group" aria-label="{session.title || 'Untitled'}'s work">
            {#if card}
              <div class="flex min-h-8 items-center gap-1.5 rounded-xl px-2 py-1.5" title={card.description || card.title}>
                <span class="min-w-0 flex-1 truncate font-mono text-[11.5px] leading-4 text-ink-muted">{card.title}</span>
                <Age at={card.updatedAt || session.updatedAt} class="shrink-0 text-[10.5px] text-ink-faint" />
                <span class="size-1.5 shrink-0 rounded-full {session.status === 'running' ? 'pulse-live bg-live' : session.status === 'error' ? 'bg-err' : 'bg-line-strong'}" aria-hidden="true"></span>
              </div>
            {:else if session.task}
              <div class="flex min-h-8 items-center gap-1.5 rounded-xl px-2 py-1.5" title={session.task}>
                <span class="min-w-0 flex-1 truncate font-mono text-[11.5px] leading-4 text-ink-muted">{session.task}</span>
                <Age at={session.updatedAt} class="shrink-0 text-[10.5px] text-ink-faint" />
              </div>
            {/if}
            {#each tree.rows as r (r.path)}
              <button
                data-nav
                type="button"
                class="flex min-h-8 w-full cursor-pointer items-center gap-1.5 rounded-xl px-2 py-1 text-left hover:bg-raised/70 max-md:min-h-11"
                style="padding-left: {r.depth * 10 + 8}px"
                title={r.task ? `${r.path}: ${r.task}` : r.path}
                onclick={() => onopen(session.id)}
              >
                <Avatar id={r.id} size={16} />
                <span class="min-w-0 shrink-0 truncate text-[11.5px] leading-4 font-medium text-ink-muted">{r.name}</span>
                {#if r.agent}<span class="min-w-0 truncate text-[10.5px] leading-4 text-ink-faint">{r.agent}</span>{/if}
                <span class="ml-auto flex shrink-0 items-center gap-1 text-[10.5px] leading-4 {r.tone === 'live' ? 'font-medium text-live' : 'text-ink-faint'}">
                  <span class="size-1.5 shrink-0 rounded-full {BOT_DOT[r.tone]}" aria-hidden="true"></span>
                  {r.label}
                </span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {:else}
      {#if loading}
        <div class="flex flex-col gap-2 px-1 pt-1" role="status" aria-label="Loading bots">
          <Skeleton class="h-14 rounded-[18px]" />
          <Skeleton class="h-14 rounded-[18px]" />
          <Skeleton class="h-14 rounded-[18px]" />
        </div>
      {:else}
        <!-- The empty room: the pet keeps you company while the first bot boots. -->
        <div class="flex flex-col items-center gap-3 px-4 py-10 text-center">
          <Mascot mood="idle" size={56} />
          <div class="text-[13px] text-ink-muted">{query ? `No bots match “${filter}”` : "No bots yet — say hello to your first one"}</div>
          {#if !query}
            <Button variant="subtle" size="sm" icon={Plus} onclick={onnew}>New bot</Button>
          {/if}
        </div>
      {/if}
    {/each}
  </div>

  <!-- A phone has no room for a rail plus a chat: this is the whole screen, so say how to leave. -->
  {#if full}
    <div class="shrink-0 border-t border-line/80 px-4 py-3">
      <Button variant="secondary" size="md" icon={Plus} class="w-full justify-center" onclick={onnew}>
        New bot
      </Button>
    </div>
  {/if}
</aside>