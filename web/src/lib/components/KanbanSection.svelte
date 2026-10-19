<script lang="ts">
  import { api } from "../api";
  import { store } from "../stores/sessions.svelte";
  import BoardVisuals from "./vendor/BoardVisuals.svelte";
  import * as Tabs from "./shadcn/tabs";
  let { open = false }: { open?: boolean } = $props();
  type Card = { id:string; session:string; title:string; description:string; column:string; assignee:string; result:string; updatedAt:number };
  let cards = $state<Card[]>([]);
  let error = $state("");
  let board = $state("");
  let owner = $state("");
  let query = $state("");
  let mode = $state("kanban");
  let graph = $state<{ok:boolean;synced_at?:number;error?:string;rag?:{ok:boolean;indexed?:number;updated_at?:number}}>({ok:false});
  const columns = ["backlog","doing","review","blocked","done"];
  const label = (id:string) => id.split("~").map((part,i)=>i===0 ? (store.sessions[part]?.title || part) : part).join(" › ");
  const boards = $derived([...new Set(cards.map(c=>c.session))].sort());
  const owners = $derived([...new Set(cards.filter(c=>!board || c.session===board || c.session.startsWith(board+"~")).map(c=>c.assignee).filter(Boolean))].sort());
  const shown = $derived(cards.filter(c=>(!board || c.session===board || c.session.startsWith(board+"~")) && (!owner || c.assignee===owner) && (!query || (c.title+" "+c.description+" "+c.result).toLowerCase().includes(query.toLowerCase()))));
  async function load() {
    try { cards=await api.kanban(); error=""; graph=await fetch('/api/orchestration/graph').then(r=>r.json()); }
    catch(e) {error=(e as Error).message;}
  }
  $effect(()=>{ if(!open)return;let stopped=false;let timer:ReturnType<typeof setTimeout>;async function tick(){await load();if(!stopped)timer=setTimeout(tick,3000)}void tick();return()=>{stopped=true;clearTimeout(timer)} });
</script>
<section class="mx-2 mb-4 rounded-xl border border-line bg-raised/40 p-3" aria-label="Task boards">
  <h3 class="text-sm font-semibold text-ink">Task boards</h3>
  <p class="mt-1 text-xs text-ink-muted">Main › worker › sub-worker. Boards and results are saved.</p>
  <div class="mt-3 grid gap-2 sm:grid-cols-2">
    <label class="text-xs text-ink-muted">Board / agent
      <select aria-label="Filter board" bind:value={board} onchange={()=>owner=""} class="mt-1 w-full rounded-md border border-line bg-canvas p-2 text-base text-ink">
        <option value="">All boards</option>{#each boards as b}<option value={b}>{label(b)}</option>{/each}
      </select>
    </label>
    <label class="text-xs text-ink-muted">Assigned subagent
      <select aria-label="Filter subagent" bind:value={owner} class="mt-1 w-full rounded-md border border-line bg-canvas p-2 text-base text-ink">
        <option value="">All subagents</option>{#each owners as o}<option value={o}>{o}</option>{/each}
      </select>
    </label>
    <input aria-label="Search tasks" placeholder="Search tasks and results" bind:value={query} class="w-full sm:col-span-2 rounded-md border border-line bg-canvas p-2 text-base text-ink" />
  </div>
  <p class="mt-2 text-xs text-ink-muted" role="status">{graph.ok && Date.now()-(graph.synced_at||0)<30000 ? 'Rust graph synced · '+new Date(graph.synced_at||0).toLocaleTimeString() : 'Rust graph pending'} · {shown.length} tasks</p>
  <p class="mt-1 text-xs text-ink-muted">{graph.rag?.ok && Date.now()-(graph.rag.updated_at||0)<30000 ? `Semantic context ready · ${graph.rag.indexed} indexed records` : "Semantic context warming up or unavailable"}</p>
  {#if error}<p class="text-sm text-warn">{error}</p>{/if}
  <Tabs.Root bind:value={mode} class="mt-3 flex-col">
    <Tabs.List class="h-10 w-full shrink-0 bg-overlay text-ink" aria-label="Task view">
      <Tabs.Trigger value="list" class="h-9 min-h-9 text-ink data-active:bg-canvas">List</Tabs.Trigger>
      <Tabs.Trigger value="kanban" class="h-9 min-h-9 text-ink data-active:bg-canvas">Kanban</Tabs.Trigger>
    </Tabs.List>
    <BoardVisuals cards={shown} {mode} labels={Object.fromEntries(boards.map(b=>[b,label(b)]))} />
  </Tabs.Root>

</section>
