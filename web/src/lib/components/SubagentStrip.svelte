<script lang="ts">
  import { Bot, CornerLeftUp } from "@lucide/svelte";
  import type { SessionState, SubagentView } from "../types";
  import { cost } from "../format";

  let {
    session,
    onopen,
  }: {
    session: SessionState;
    /** Open a session (a subagent, or the parent) in this pane. */
    onopen: (sessionId: string) => void;
  } = $props();

  const children = $derived(session.subagents ?? []);
  const working = $derived(children.filter((c) => c.state === "running" || c.state === "starting").length);

  function tone(c: SubagentView): string {
    if (c.state === "running" || c.state === "starting") return "bg-brand pulse-live";
    if (c.state === "waiting") return c.exitStatus && c.exitStatus !== "Submitted" ? "bg-warn" : "bg-ok";
    if (c.state === "exited" && c.exitStatus && c.exitStatus !== "Submitted") return "bg-err";
    return "bg-ink-faint";
  }

  function label(c: SubagentView): string {
    const status = c.exitStatus && c.state !== "running" ? `${c.state}, ${c.exitStatus}` : c.state;
    return `Subagent ${c.name}: ${status}, ${c.steps} steps, ${cost(c.cost)}. ${c.task}`;
  }
</script>

{#if children.length || session.parentId}
  <nav
    class="flex min-w-0 items-center gap-1.5 overflow-x-auto border-b border-line/60 bg-canvas px-3.5 py-1 text-[11.5px]"
    aria-label="Subagents"
  >
    {#if session.parentId}
      <button
        class="interactive flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-ink-muted hover:bg-raised"
        title="Open the session that started this subagent"
        onclick={() => onopen(session.parentId!)}
      >
        <CornerLeftUp size={12} strokeWidth={2} /> parent
      </button>
    {/if}
    {#if children.length}
      <span class="flex shrink-0 items-center gap-1 text-ink-faint">
        <Bot size={12} strokeWidth={2} />
        {children.length} subagent{children.length === 1 ? "" : "s"}{working ? ` · ${working} working` : ""}
      </span>
      {#each children as c (c.sessionId)}
        <button
          class="interactive flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-line/70 px-1.5 py-0.5 hover:bg-raised"
          title={label(c)}
          aria-label={label(c)}
          onclick={() => onopen(c.sessionId)}
        >
          <span class="size-1.5 rounded-full {tone(c)}"></span>
          <span class="max-w-36 truncate font-medium text-ink">{c.name}</span>
          <span class="tnum text-ink-faint">{c.steps} · {cost(c.cost)}</span>
        </button>
      {/each}
    {/if}
  </nav>
{/if}
