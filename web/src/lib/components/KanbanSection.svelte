<script lang="ts">
  /**
   * The bots' boards (`mini-tui kanban`): every bot's cards in five columns, newest first. Read-only
   * and live while the drawer is open (a short poll, stopped on close). Each card shows its title,
   * the one subagent that owns it and the result once it is done.
   */
  import { KanbanSquare } from "@lucide/svelte";
  import { api } from "../api";
  import { store } from "../stores/sessions.svelte";

  let { open = false }: { open?: boolean } = $props();

  type KCard = { id: string; session: string; title: string; description: string; column: string; assignee: string; result: string; updatedAt: number };
  const COLS = ["backlog", "doing", "review", "blocked", "done"];
  let cards = $state<KCard[]>([]);
  let error = $state("");
  let timer: ReturnType<typeof setInterval> | undefined;

  async function load() {
    try {
      cards = await api.kanban();
      error = "";
    } catch (e) {
      error = (e as Error).message;
    }
  }

  $effect(() => {
    if (!open) return;
    void load();
    timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  });

  const bots = $derived([...new Set(cards.map((c) => c.session))]);
  const titleOf = (id: string) => store.sessions[id]?.title || id;
</script>

{#if cards.length || error}
  <section class="mx-4 mb-4 rounded-2xl border border-line bg-raised/50 p-3" aria-label="Kanban">
    <h3 class="mb-2 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-ink-faint uppercase">
      <KanbanSquare size={13} strokeWidth={2} aria-hidden="true" /> Kanban
    </h3>
    {#if error}<p class="text-[12px] text-warn">{error}</p>{/if}
    {#each bots as bot (bot)}
      {@const mine = cards.filter((c) => c.session === bot)}
      <div class="mb-3 last:mb-0">
        <div class="mb-1 truncate text-[12.5px] font-medium text-ink">{titleOf(bot)}</div>
        <div class="grid grid-cols-1 gap-1.5">
          {#each COLS as col (col)}
            {@const here = mine.filter((c) => c.column === col)}
            {#if here.length}
              <div>
                <div class="px-1 text-[10.5px] font-medium tracking-wide text-ink-faint uppercase">{col} · {here.length}</div>
                {#each here as c (c.id)}
                  <div class="mt-0.5 rounded-xl bg-canvas px-2.5 py-1.5" title={c.description}>
                    <div class="text-[12.5px] leading-4 text-ink">{c.title}</div>
                    {#if c.assignee}<div class="font-mono text-[10.5px] text-ink-muted">@{c.assignee}</div>{/if}
                    {#if c.result}<div class="mt-0.5 line-clamp-2 text-[11.5px] text-ink-muted">{c.result}</div>{/if}
                  </div>
                {/each}
              </div>
            {/if}
          {/each}
        </div>
      </div>
    {/each}
  </section>
{/if}
