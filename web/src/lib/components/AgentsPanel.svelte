<script lang="ts">
  import { Bot, X, GitFork, Forward, MessageSquare, Reply, Flame, CircleCheck, CircleAlert, Split, Sparkles, ArrowRight, DatabaseZap, Hourglass, Network } from "@lucide/svelte";
  import Button from "./Button.svelte";
  import Spinner from "./Spinner.svelte";
  import { api } from "../api";
  import { cost } from "../format";
  import type { AgentEvent, AgentNode, AgentsView } from "../types";

  /**
   * The agents of a session: the tree of agent sessions it started (each a session of its own,
   * a copy of the one that started it), live state and measured cache reuse per agent, and the
   * timeline of what they said to each other (delegations, handoffs, corrections, replies,
   * fan-outs). Polled while open; the server reads the hubs' own files.
   */
  let {
    sessionId,
    onopen,
    onclose,
  }: {
    sessionId: string | null;
    /** Open an agent's session in this pane. */
    onopen: (sessionId: string) => void;
    onclose: () => void;
  } = $props();

  let view = $state<AgentsView | null>(null);
  let error = $state("");
  let selected = $state<string | null>(null);
  let tab = $state<"agents" | "graph" | "activity" | "defs">("graph");
  let now = $state(Date.now() / 1000);
  let panel = $state<HTMLElement | null>(null);

  export function focus() {
    panel?.focus();
  }

  $effect(() => {
    const id = sessionId;
    view = null;
    error = "";
    selected = null;
    if (!id) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    let es: EventSource | null = null;
    // Live first: the SSE stream pushes every change as it happens; polling only if it drops.
    const poll = () => {
      if (!alive || es) return;
      timer = setTimeout(async () => {
        try {
          const v = await api.agents(id);
          if (!alive) return;
          view = v;
          error = "";
        } catch (e) {
          if (alive) error = (e as Error).message;
        }
        now = Date.now() / 1000;
        poll();
      }, document.hidden ? 4000 : 1500);
    };
    es = new EventSource(`/api/sessions/${encodeURIComponent(id)}/agents/stream`);
    es.onmessage = (m) => {
      if (!alive) return;
      view = JSON.parse(m.data);
      error = "";
      now = Date.now() / 1000;
    };
    es.onerror = () => {
      es?.close();
      es = null;
      if (alive) poll();
    };
    return () => {
      alive = false;
      clearTimeout(timer);
      es?.close();
    };
  });

  /** Every node, depth-first, with its depth: the tree as rows. */
  function flatten(nodes: AgentNode[], depth = 0, out: { node: AgentNode; depth: number; last: boolean }[] = []) {
    nodes.forEach((node, i) => {
      out.push({ node, depth, last: i === nodes.length - 1 });
      flatten(node.children, depth + 1, out);
    });
    return out;
  }
  const rows = $derived(view ? flatten(view.nodes) : []);
  const byPath = $derived(new Map(rows.map((r) => [r.node.path, r.node])));
  const live = $derived(rows.filter((r) => isLive(r.node)).length);
  const sel = $derived(selected ? byPath.get(selected) ?? null : null);

  /** The events to show: all of them, or those that touch the selected agent. */
  const events = $derived.by(() => {
    const all = (view?.events ?? []).filter((e) => e.kind !== "define" || tab === "activity");
    if (!sel) return all;
    return all.filter((e) => touches(e, sel));
  });

  function full(scope: string, name: string): string {
    if (!name || name === "parent" || name === "hub") return name;
    return scope ? `${scope}/${name}` : name;
  }
  function touches(e: AgentEvent, n: AgentNode): boolean {
    const names = e.to.split(",").map((t) => full(e.scope, t.trim()));
    return full(e.scope, e.from) === n.path || names.includes(n.path) || (e.from === "parent" && e.scope === n.path);
  }
  /** The label of an event endpoint: its agent name, or the agent that owns that hub for `parent`. */
  function who(scope: string, name: string): string {
    if (name === "parent") return scope ? scope.split("/").pop()! : "you";
    if (name === "hub") return "hub";
    return name;
  }

  function isLive(n: AgentNode) {
    return n.state === "running" || n.state === "starting";
  }
  function status(n: AgentNode): { label: string; tone: string } {
    if (n.waitingChildren.length) return { label: `waiting on ${n.waitingChildren.length}`, tone: "wait" };
    if (n.awaiting) return { label: `waiting on ${n.awaiting}`, tone: "wait" };
    if (isLive(n)) return { label: n.state === "starting" ? "starting" : "working", tone: "live" };
    if (n.state === "waiting") return n.exitStatus && n.exitStatus !== "Submitted" ? { label: n.exitStatus, tone: "warn" } : { label: "done", tone: "ok" };
    if (n.state === "exited" && n.exitStatus && n.exitStatus !== "Submitted") return { label: "failed", tone: "err" };
    if (n.state === "stopped") return { label: "stopped", tone: "idle" };
    return { label: n.exitStatus === "Submitted" ? "done" : n.state, tone: n.exitStatus === "Submitted" ? "ok" : "idle" };
  }
  const DOT: Record<string, string> = { live: "bg-brand pulse-live", ok: "bg-ok", warn: "bg-warn", err: "bg-err", wait: "bg-sky-400", idle: "bg-ink-faint" };
  const TEXT: Record<string, string> = { live: "text-brand", ok: "text-ok", warn: "text-warn", err: "text-err", wait: "text-sky-400", idle: "text-ink-faint" };

  function hit(n: AgentNode): number | null {
    const c = n.cache;
    if (!c || !c.first_prompt) return null;
    return Math.round((100 * c.first_cached) / c.first_prompt);
  }
  function totalHit(n: AgentNode): number | null {
    const c = n.cache;
    if (!c || !c.prompt_total) return null;
    return Math.round((100 * c.cached_total) / c.prompt_total);
  }
  /** The task an agent was given, without the agent header the hub wraps it in. */
  function taskOf(t: string) {
    const i = t.indexOf("TASK:\n");
    return (i >= 0 ? t.slice(i + 6) : t.replace(/^<agent[^>]*>/, "")).trim();
  }
  function shortModel(m: string) {
    return m.split("/").pop() ?? m;
  }
  function ago(t: number) {
    const s = Math.max(0, Math.round(now - t));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    return `${Math.floor(s / 3600)}h`;
  }
  function clock(t: number) {
    return new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  const KIND: Record<string, { icon: typeof Bot; label: string; cls: string }> = {
    delegate: { icon: GitFork, label: "delegated", cls: "text-brand bg-brand-soft" },
    handoff: { icon: Forward, label: "handed off", cls: "text-violet-400 bg-violet-400/12" },
    message: { icon: MessageSquare, label: "message", cls: "text-sky-400 bg-sky-400/12" },
    reply: { icon: Reply, label: "reply", cls: "text-sky-300 bg-sky-300/10" },
    fanout: { icon: Split, label: "fan-out", cls: "text-amber-400 bg-amber-400/12" },
    warmup: { icon: Flame, label: "cache warmup", cls: "text-ink-muted bg-raised" },
    done: { icon: CircleCheck, label: "finished", cls: "text-ok bg-ok/12" },
    define: { icon: Sparkles, label: "defined agent", cls: "text-brand bg-brand-soft" },
    error: { icon: CircleAlert, label: "error", cls: "text-err bg-err/12" },
  };
  const kindOf = (k: string) => KIND[k] ?? { icon: Bot, label: k, cls: "text-ink-muted bg-raised" };
  let expanded = $state<Record<number, boolean>>({});
</script>

<section
  bind:this={panel}
  tabindex="-1"
  class="flex min-h-0 flex-1 flex-col outline-none"
  aria-label="Agents"
>
  <header class="flex shrink-0 items-center gap-2 border-b border-line/70 px-3 py-2">
    <Network size={14} strokeWidth={1.75} class="text-ink-muted" aria-hidden="true" />
    <h2 class="text-[12.5px] font-semibold text-ink">Agents</h2>
    {#if rows.length}
      <span class="tnum text-[11.5px] text-ink-faint">{rows.length} session{rows.length === 1 ? "" : "s"}{live ? ` · ${live} working` : ""}</span>
    {/if}
    <span class="flex-1"></span>
    <Button variant="ghost" size="icon-sm" icon={X} title="Close" aria-label="Close agents" onclick={onclose} />
  </header>

  {#if !sessionId}
    <p class="m-4 text-[12.5px] text-ink-muted">Start a chat: the agents it delegates to show up here.</p>
  {:else if !view && !error}
    <div class="flex flex-1 items-center justify-center gap-2 text-[12px] text-ink-muted" role="status"><Spinner size={12} label="" />Loading agents</div>
  {:else}
    {#if error}
      <div class="m-3 rounded-md bg-err/10 px-3 py-2 text-[12px] text-err" role="alert">{error}</div>
    {/if}
      <!-- activity / definitions -->
      <div class="flex shrink-0 items-center gap-0.5 border-y border-line/70 bg-surface px-2" role="tablist" aria-label="Agents view">
        {#each [{ id: "agents", label: `Agents${rows.length ? ` · ${rows.length}` : ""}` }, { id: "graph", label: "Graph" }, { id: "activity", label: sel ? `Messages · ${sel.name}` : "Messages" }, { id: "defs", label: `Definitions${view ? ` · ${view.defs.length}` : ""}` }] as t (t.id)}
          <button
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            class="interactive -mb-px min-h-8 cursor-pointer border-b-2 px-2 text-[12px] font-medium {tab === t.id ? 'border-brand text-ink' : 'border-transparent text-ink-muted hover:text-ink'}"
            onclick={() => (tab = t.id as "agents" | "graph" | "activity" | "defs")}
          >{t.label}</button>
        {/each}
      </div>

      {#if tab === "graph" && view}
        <div class="min-h-0 flex-1">
          {#await import("./AgentGraph.svelte") then m}
            <m.default {view} {onopen} />
          {/await}
        </div>
      {:else}
        <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {#if tab === "agents"}
      <!-- the tree -->
      <div class="px-2 pt-2 pb-1">
        <button
          type="button"
          class="interactive flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left {selected === null ? 'bg-raised' : 'hover:bg-raised/60'}"
          onclick={() => (selected = null)}
          aria-pressed={selected === null}
        >
          <span class="grid size-5 shrink-0 place-items-center rounded-md bg-brand-soft text-brand"><Bot size={12} strokeWidth={2} /></span>
          <span class="text-[12.5px] font-semibold text-ink">This session</span>
          <span class="text-[11px] text-ink-faint">root</span>
        </button>
        {#if !rows.length}
          <p class="px-2 py-3 text-[12px] leading-relaxed text-ink-muted">
            No agents yet. Ask it to delegate — "have a translator agent do X, then a reviewer check it" — and
            each agent appears here as its own session, a copy of this one.
          </p>
        {/if}
        <ul class="tree" role="tree" aria-label="Agent sessions">
          {#each rows as { node, depth, last } (node.path)}
            {@const st = status(node)}
            {@const h = hit(node)}
            <li role="treeitem" aria-selected={selected === node.path} aria-level={depth + 2} style="--d:{depth}" class:last>
              <button
                type="button"
                class="row interactive group flex w-full cursor-pointer items-start gap-2 rounded-md py-1.5 pr-2 text-left {selected === node.path ? 'bg-raised' : 'hover:bg-raised/60'}"
                onclick={() => (selected = selected === node.path ? null : node.path)}
              >
                <span class="mt-[5px] size-2 shrink-0 rounded-full {DOT[st.tone]}" aria-hidden="true"></span>
                <span class="min-w-0 flex-1">
                  <span class="flex min-w-0 items-center gap-1.5">
                    <span class="truncate text-[12.5px] font-medium text-ink">{node.name}</span>
                    {#if node.origin === "handoff"}
                      <span class="inline-flex shrink-0 items-center gap-0.5 text-[10.5px] text-violet-400" title="handed over by {node.from}"><Forward size={10} strokeWidth={2} />{node.from}</span>
                    {/if}
                    {#if node.agent && node.agent !== node.name}
                      <span class="shrink-0 rounded bg-raised px-1 text-[10.5px] text-ink-muted">{node.agent}</span>
                    {/if}
                  </span>
                  <span class="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-ink-faint">
                    <span class={TEXT[st.tone]}>{st.label}</span>
                    <span>·</span>
                    <span class="truncate">{shortModel(node.model)}</span>
                    <span>·</span>
                    <span class="tnum shrink-0">{node.steps} st · {cost(node.cost)}</span>
                  </span>
                </span>
                {#if h !== null}
                  <span
                    class="mt-0.5 inline-flex shrink-0 items-center gap-0.5 rounded px-1 text-[10.5px] tnum {h >= 50 ? 'bg-ok/12 text-ok' : 'bg-raised text-ink-faint'}"
                    title="first call: {node.cache?.first_cached} of {node.cache?.first_prompt} prompt tokens served from cache (inherited prefix, {node.cache?.inherited_messages} messages)"
                  ><DatabaseZap size={10} strokeWidth={2} />{h}%</span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      </div>

      {#if sel}
        {@const st = status(sel)}
        <div class="mx-3 mb-2 rounded-lg border border-line/80 bg-canvas/60 p-3">
          <div class="flex items-center gap-2">
            <span class="size-2 rounded-full {DOT[st.tone]}"></span>
            <span class="text-[13px] font-semibold text-ink">{sel.name}</span>
            <span class="text-[11.5px] {TEXT[st.tone]}">{st.label}</span>
            <span class="flex-1"></span>
            <button type="button" class="interactive inline-flex cursor-pointer items-center gap-1 rounded-md border border-line px-2 py-0.5 text-[11.5px] text-ink-muted hover:bg-raised hover:text-ink" onclick={() => onopen(sel.sessionId)}>
              Open session <ArrowRight size={11} strokeWidth={2} />
            </button>
          </div>
          <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11.5px]">
            <dt class="text-ink-faint">agent</dt><dd class="text-ink">{sel.agent || "—"}</dd>
            <dt class="text-ink-faint">started by</dt><dd class="text-ink">{sel.origin === "handoff" ? `handoff from ${sel.from}` : sel.origin === "delegate" ? `delegated by ${sel.path.includes("/") ? sel.path.split("/").slice(-2, -1)[0] : "this session"}` : "spawn"}</dd>
            <dt class="text-ink-faint">model</dt><dd class="truncate text-ink">{sel.model}</dd>
            <dt class="text-ink-faint">activity</dt><dd class="tnum text-ink">{sel.steps} steps · {cost(sel.cost)} · {ago(sel.lastActivity)} ago</dd>
            {#if sel.cache}
              <dt class="text-ink-faint">inherited</dt>
              <dd class="text-ink">{sel.cache.inherited_messages} messages, byte-for-byte</dd>
              <dt class="text-ink-faint">cache</dt>
              <dd class="tnum text-ink">
                1st call {sel.cache.first_cached.toLocaleString()} / {sel.cache.first_prompt.toLocaleString()} tokens cached{#if totalHit(sel) !== null}<span class="text-ink-faint"> · </span>overall {totalHit(sel)}%{/if}
                <span class="block text-[11px] text-ink-faint">{sel.cache.warm}</span>
              </dd>
            {/if}
            {#if sel.lastCommand}
              <dt class="text-ink-faint">last</dt><dd class="truncate font-mono text-[11px] text-ink-muted" title={sel.lastCommand}>{sel.lastCommand}</dd>
            {/if}
          </dl>
          <p class="mt-2 line-clamp-4 text-[11.5px] leading-relaxed text-ink-muted" title={taskOf(sel.task)}>{taskOf(sel.task)}</p>
        </div>
      {/if}

          {/if}
      {#if tab === "activity"}
        <ol class="timeline px-3 py-2" aria-label="Messages between agents">
          {#if !events.length}
            <li class="py-2 text-[12px] text-ink-muted">Nothing yet.</li>
          {/if}
          {#each events as e, i (i + ":" + e.at)}
            {@const k = kindOf(e.kind)}
            {@const Icon = k.icon}
            {@const long = e.text.length > 220}
            <li class="relative flex gap-2.5 pb-3">
              <span class="z-[1] mt-0.5 grid size-5 shrink-0 place-items-center rounded-full {k.cls}"><Icon size={11} strokeWidth={2} /></span>
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-x-1.5 text-[11.5px]">
                  <span class="font-semibold text-ink">{who(e.scope, e.from)}</span>
                  {#if e.to && e.kind !== "warmup"}
                    <ArrowRight size={10} strokeWidth={2} class="text-ink-faint" />
                    <span class="font-semibold text-ink">{e.to.split(",").map((t) => who(e.scope, t.trim())).join(", ")}</span>
                  {/if}
                  <span class="rounded px-1 text-[10.5px] {k.cls}">{k.label}</span>
                  {#if e.model && (e.kind === "delegate" || e.kind === "handoff")}<span class="text-[10.5px] text-ink-faint">{shortModel(e.model)}</span>{/if}
                  {#if e.kind === "warmup" && e.seconds !== undefined}<span class="tnum text-[10.5px] text-ink-faint">{e.seconds}s</span>{/if}
                  <span class="flex-1"></span>
                  <time class="tnum text-[10.5px] text-ink-faint">{clock(e.at)}</time>
                </div>
                {#if e.chain?.length}
                  <div class="mt-1 flex flex-wrap items-center gap-1 text-[10.5px] text-violet-400">
                    {#each e.chain as c, j (j)}{#if j}<ArrowRight size={9} strokeWidth={2} />{/if}<span>{c}</span>{/each}
                  </div>
                {/if}
                {#if e.text}
                  <p class="mt-1 text-[12px] leading-relaxed whitespace-pre-wrap text-ink-muted {long && !expanded[i] ? 'line-clamp-4' : ''}">{e.text}</p>
                  {#if long}
                    <button type="button" class="mt-0.5 cursor-pointer text-[11px] text-ink-faint hover:text-ink" onclick={() => (expanded[i] = !expanded[i])}>{expanded[i] ? "less" : "more"}</button>
                  {/if}
                {/if}
              </div>
            </li>
          {/each}
          {#if live}
            <li class="flex items-center gap-2 pl-0.5 text-[11.5px] text-ink-faint"><Hourglass size={12} strokeWidth={1.75} /> {live} working in the background</li>
          {/if}
        </ol>
      {:else if tab === "defs"}
        <ul class="flex flex-col gap-2 px-3 py-2.5">
          {#each view?.defs ?? [] as d (d.name)}
            <li class="rounded-lg border border-line/80 p-2.5">
              <div class="flex items-center gap-1.5">
                <Bot size={12} strokeWidth={2} class="text-brand" />
                <span class="text-[12.5px] font-semibold text-ink">{d.name}</span>
                {#if d.builtin}<span class="rounded bg-raised px-1 text-[10.5px] text-ink-muted">default</span>{/if}
                <span class="flex-1"></span>
                <span class="truncate text-[10.5px] text-ink-faint">{d.model ? shortModel(d.model) : "session's model"}</span>
              </div>
              <p class="mt-1 text-[12px] leading-relaxed text-ink-muted">{d.description}</p>
              {#if d.when_to_use}<p class="mt-1 text-[11px] text-ink-faint">use for: {d.when_to_use}</p>{/if}
            </li>
          {/each}
        </ul>
      {/if}
        </div>
      {/if}
  {/if}
</section>

<style>
  /* Tree guides: one indent per depth, an elbow into each row. */
  .tree li {
    position: relative;
    padding-left: calc(var(--d) * 16px + 14px);
  }
  .tree li::before {
    content: "";
    position: absolute;
    left: calc(var(--d) * 16px + 4px);
    top: 0;
    bottom: 0;
    border-left: 1px solid var(--color-line-strong);
  }
  .tree li.last::before {
    bottom: calc(100% - 15px);
  }
  .tree li::after {
    content: "";
    position: absolute;
    left: calc(var(--d) * 16px + 4px);
    top: 15px;
    width: 8px;
    border-top: 1px solid var(--color-line-strong);
  }
  /* The timeline's spine. */
  .timeline li:not(:last-child)::before {
    content: "";
    position: absolute;
    left: 9.5px;
    top: 22px;
    bottom: 2px;
    border-left: 1px solid var(--color-line);
  }
</style>
