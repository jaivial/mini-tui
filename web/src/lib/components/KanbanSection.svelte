<script lang="ts">
  import { tick } from "svelte";
  import { api } from "../api";
  import { store } from "../stores/sessions.svelte";
  import { agentTree } from "../stores/agentTree.svelte";
  let { open = false }: { open?: boolean } = $props();
  type Card = { id:string; session:string; title:string; description:string; column:string; assignee:string; result:string; updatedAt:number };
  /** A subagent board reachable from this board: the session id it opens as, its name and state. */
  type Child = { id:string; title:string; status:string };
  let cards = $state<Card[]>([]);
  let error = $state("");
  let path = $state<string[]>([]);
  let selected = $state<string | null>(null);
  let detailEl = $state<HTMLElement>();
  $effect(()=>{if(selected)void tick().then(()=>detailEl?.scrollIntoView({block:"start",behavior:"instant"}));});
  let query = $state("");
  let blockedOnly = $state(false);
  let mode = $state(localStorage.getItem("mini.kanban.view") === "list" ? "list" : "kanban");
  const columns = [{id:"backlog",label:"To do"},{id:"doing",label:"In progress"},{id:"review",label:"Review"},{id:"done",label:"Done"}];
  const board = $derived(path.at(-1) || store.activeId || "");
  /** The session this board tree started from: its roster is what knows every subagent session. */
  const root = $derived(path[0] || store.activeId || "");
  const rows = $derived(agentTree.trees[root]?.rows ?? []);
  /** Every delegate name the trees have said so far, so a breadcrumb can name a board it enters. */
  const names = $derived.by(() => {
    const map = new Map<string, string>();
    for (const tree of Object.values(agentTree.trees)) for (const row of tree.rows) if (!map.has(row.id)) map.set(row.id, row.name);
    return map;
  });
  const title = (id:string) => store.sessions[id]?.title || names.get(id) || id;
  const shown = $derived(cards.filter(c=>c.session===board && (!blockedOnly || c.column==="blocked") && (!query || (c.title+" "+c.description+" "+c.result).toLowerCase().includes(query.toLowerCase()))));
  const detail = $derived(shown.find(c=>c.id===selected));
  /**
   * The boards nested under this one. The roster (agentTree) is the source that always has them:
   * `/api/sessions` lists ROOT sessions only, so a child session reaches `store.sessions` only when
   * this browser opens it once — without the roster a board's children list would be empty on a
   * first visit. A direct child only: a grandchild belongs to the list of the board in between.
   * Any session the store already holds (with this board as its parent) merges in for its own title.
   */
  const children = $derived.by((): Child[] => {
    const out = new Map<string, Child>();
    for (const row of rows) {
      if (!row.id.startsWith(`${board}~`)) continue;
      if (row.id.slice(board.length + 1).includes("~")) continue;
      out.set(row.id, { id: row.id, title: row.name || row.id, status: row.label });
    }
    for (const s of Object.values(store.sessions)) {
      if (s.parentId===board || store.sessions[board]?.subagents?.some(c=>c.sessionId===s.id)) out.set(s.id, { id: s.id, title: s.title || s.id, status: s.status });
    }
    return [...out.values()];
  });
  const assigned = $derived(detail ? children.filter(c=>c.id===`${board}~${detail.assignee}`) : []);
  const columnOf = (c:Card) => c.column==="blocked" ? "backlog" : c.column;
  $effect(()=>{ const id=store.activeId; path=id?[id]:[]; selected=null; query=""; blockedOnly=false; });
  function enter(id:string) { path=[...path,id];selected=null;query="";blockedOnly=false; }
  async function load(): Promise<Card[]> { return api.kanban(); }
  $effect(()=>{ if(!open)return;let stopped=false;let timer:ReturnType<typeof setTimeout>;async function tick(){try{const next=await load();if(!stopped){cards=next;error="";}}catch(e){if(!stopped)error=(e as Error).message;}if(!stopped)timer=setTimeout(tick,3000)}void tick();return()=>{stopped=true;clearTimeout(timer)} });
  function view(value:string) {mode=value;localStorage.setItem("mini.kanban.view",value);}
</script>
<section class="px-2 pb-4" aria-label="Selected bot Kanban">
  {#if !board}<p class="p-4 text-sm text-ink-muted">Select a bot to see its tasks.</p>{:else}
  <nav aria-label="Board hierarchy" class="mb-3 flex flex-wrap items-center gap-1 text-xs text-ink-muted">
    {#each path as id,i}<button class="max-w-56 truncate rounded px-2 py-2 hover:bg-overlay" onclick={()=>{path=path.slice(0,i+1);selected=null;}} aria-current={i===path.length-1 ? "page" : undefined}>{title(id)}</button>{#if i<path.length-1}<span aria-hidden="true">/</span>{/if}{/each}
  </nav>
  <div class="mb-3 flex flex-wrap items-center gap-2">
    <h3 class="min-w-0 flex-1 truncate text-sm font-semibold">{title(board)}</h3>
    <span class="text-xs text-ink-muted">{shown.length} tasks</span>
    <div class="flex rounded-lg border border-line p-1" aria-label="Task view">
      <button class="rounded px-3 py-2 text-xs {mode==='kanban'?'bg-overlay':''}" aria-pressed={mode==='kanban'} onclick={()=>view('kanban')}>Columns</button>
      <button class="rounded px-3 py-2 text-xs {mode==='list'?'bg-overlay':''}" aria-pressed={mode==='list'} onclick={()=>view('list')}>List</button>
    </div>
  </div>
  <div class="mb-4 flex flex-wrap gap-2">
    <input aria-label="Search this board" placeholder="Search this bot's tasks" bind:value={query} class="min-w-0 flex-1 rounded-lg border border-line bg-canvas px-3 py-2 text-base" />
    <button class="rounded-lg border border-line px-3 py-2 text-xs {blockedOnly?'bg-warn/10 text-warn':''}" aria-pressed={blockedOnly} onclick={()=>blockedOnly=!blockedOnly}>Blocked · {cards.filter(c=>c.session===board&&c.column==='blocked').length}</button>
  </div>
  {#if error}<p role="status" class="mb-3 text-sm text-warn">Could not refresh tasks: {error}. Last saved view retained.</p>{/if}
  {#if detail}
    <section class="mb-4 rounded-xl border border-brand/30 bg-canvas p-4" aria-label="Task details" bind:this={detailEl}>
      <div class="flex items-start gap-3"><h4 class="min-w-0 flex-1 break-words text-sm font-semibold">{detail.title}</h4><button class="rounded px-2 py-1 text-xs text-ink-muted" onclick={()=>selected=null}>Close details</button></div>
      <p class="mt-2 text-xs text-ink-muted">{detail.column} · {detail.id}</p>
      <p class="mt-3 max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-sm text-ink-muted">{detail.description || 'No description saved.'}</p>
      {#if detail.result}<details class="mt-3"><summary class="cursor-pointer py-2 text-xs font-medium">Saved result</summary><p class="whitespace-pre-wrap break-words text-sm text-ink-muted">{detail.result}</p></details>{/if}
      <h5 class="mt-4 text-xs font-semibold">Assigned subagent</h5>
      {#each assigned as child}<button class="mt-2 flex w-full items-center justify-between gap-2 rounded-lg border border-line p-3 text-left" onclick={()=>enter(child.id)}><span class="min-w-0 truncate text-sm">{child.title}</span><span class="shrink-0 text-xs text-brand-fg">{child.status} · Open board →</span></button>{:else}<p class="mt-2 text-xs text-ink-muted">{detail.assignee ? `Assigned to ${detail.assignee}. No linked subagent session is available.` : 'No subagent assigned.'}</p>{/each}
    </section>
  {/if}
  <div class={mode==='list'?'flex flex-col gap-3':'grid grid-flow-col auto-cols-[minmax(240px,1fr)] gap-3 overflow-x-auto pb-2 xl:auto-cols-fr'} aria-label={mode==='list'?'Task list':'Four task columns'}>
    {#each columns as col}
      <section class="min-w-0 rounded-xl border border-line bg-raised/30 p-2" aria-label={col.label}>
        <h4 class="mb-2 flex items-center justify-between px-1 py-2 text-xs font-semibold">{col.label}<span class="text-ink-faint">{shown.filter(c=>columnOf(c)===col.id).length}</span></h4>
        <div class="flex flex-col gap-2">{#each shown.filter(c=>columnOf(c)===col.id) as card (card.id)}
          <button class="w-full rounded-lg border border-line bg-canvas p-3 text-left hover:border-brand focus-visible:outline-2 focus-visible:outline-brand" onclick={()=>selected=selected===card.id?null:card.id} aria-expanded={selected===card.id}>
            <span class="block break-words text-sm font-medium">{card.title}</span>
            {#if card.column==='blocked'}<span class="mt-2 inline-block rounded bg-warn/10 px-2 py-1 text-xs text-warn">Blocked</span>{/if}
            <!-- The card's id is how the bot names it (`kanban move <id>`), so it is on the card,
                 not only in the details: a glance at the board is enough to act on it. -->
            <span class="mt-2 flex min-w-0 items-center gap-2 text-xs text-ink-muted">
              <code class="tnum shrink-0 rounded bg-overlay px-1.5 py-0.5 font-mono text-[10.5px] text-ink-muted">{card.id}</code>
              {#if card.assignee}<span class="min-w-0 truncate">{card.assignee}</span>{/if}
            </span>
            <span class="mt-2 block text-xs text-brand-fg">View task & subagents →</span>
          </button>
        {/each}
        {#if !shown.some(c=>columnOf(c)===col.id)}<p class="px-2 py-4 text-xs text-ink-faint">No tasks</p>{/if}</div>
      </section>
    {/each}
  </div>
  {#if children.length}<details class="mt-4 rounded-xl border border-line p-3"><summary class="cursor-pointer text-xs font-medium">All subagent boards · {children.length}</summary><div class="mt-2 flex flex-col gap-2">{#each children as child}<button class="flex min-w-0 items-center justify-between gap-2 rounded-lg px-2 py-3 text-left hover:bg-overlay" onclick={()=>enter(child.id)}><span class="min-w-0 truncate text-sm">{child.title}</span><span class="shrink-0 text-xs text-ink-muted">{child.status} →</span></button>{/each}</div></details>{/if}
  {/if}
</section>
