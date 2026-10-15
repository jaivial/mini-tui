<script lang="ts">
  /**
   * The team map: every open session as its own little tree of delegated agents,
   * one squishmoji pet per node, laid out as a real hierarchy (parents centred
   * over their subtrees, trees side by side). Live on the same quiet poll the
   * sidebar's nested list uses (the agentTree store — read-only here: the
   * sidebar keeps it fed), so states and pulses move as the team works. Edges
   * animate while the child below them is working. Immersive: F toggles real
   * browser fullscreen, Esc leaves it (or closes the map).
   */
  import { SvelteFlow, Background, Controls, type Node, type Edge } from "@xyflow/svelte";
  import "@xyflow/svelte/dist/style.css";
  import { Maximize, Minimize, Network, X } from "@lucide/svelte";
  import TeamMapNode from "./TeamMapNode.svelte";
  import FitView from "./FitView.svelte";
  import Button from "./Button.svelte";
  import { agentTree } from "../stores/agentTree.svelte";
  import { mapLabel, mapTone } from "../botGroups";
  import { store } from "../stores/sessions.svelte";
  import type { BotRow } from "../stores/agentTree.svelte";

  let {
    open = $bindable(false),
    onopensession,
  }: {
    open?: boolean;
    /** Open one of the map's sessions in the app (the map closes first). */
    onopensession: (id: string) => void;
  } = $props();

  let dialog: HTMLDialogElement | undefined = $state();
  let shell: HTMLDivElement | undefined = $state();

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  });

  // `close` also fires for Escape (the browser's own dialog escape hatch),
  // so both the X and the key land in one place.
  function oncloseevent(event: Event) {
    event.preventDefault();
    open = false;
  }

  /** F toggles immersive fullscreen; Esc leaves fullscreen first, then closes. */
  function onkey(event: KeyboardEvent) {
    if (!open) return;
    if (event.key === "Escape") {
      // Inside fullscreen the browser exits it on its own; only close when already out.
      if (document.fullscreenElement) return;
      event.preventDefault();
      open = false;
    } else if (event.key.toLowerCase() === "f" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const t = event.target as HTMLElement | null;
      if (t?.closest?.("input, textarea, [contenteditable]")) return;
      event.preventDefault();
      void toggleFullscreen();
    }
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await shell?.requestFullscreen();
    } catch {
      // Refused (permissions policy, iPad Safari...) — the map stays a big modal.
    }
  }

  let fullscreen = $state(false);
  $effect(() => {
    const onchange = () => (fullscreen = document.fullscreenElement === shell);
    document.addEventListener("fullscreenchange", onchange);
    return () => document.removeEventListener("fullscreenchange", onchange);
  });

  const nodeTypes = { pet: TeamMapNode };

  // Layout constants: compact pet cards, a tidy vertical tree per session.
  const NODE_W = 158;
  const NODE_H = 66;
  const GAP_X = 26;
  const GAP_Y = 64;
  const TREE_GAP = 90;

  interface Pet {
    id: string;
    path: string;
    name: string;
    label: string;
    tone: BotRow["tone"];
    task: string;
    sessionId: string;
  }

  /** Rows come flattened (children after their parent); index them by path.
   *  A resumed run can briefly list the same delegate twice: keep the first row
   *  per path, or duplicate keys (and duplicate node ids) would throw. */
  function byPathOf(rows: BotRow[]): Map<string, Pet> {
    const map = new Map<string, Pet>();
    for (const r of rows) {
      if (map.has(r.path)) continue;
      map.set(r.path, { id: r.id, path: r.path, name: r.name, label: r.label, tone: r.tone, task: r.task, sessionId: r.id });
    }
    return map;
  }

  // The poll ticks every few seconds; only rebuild the graph when a value
  // actually changed, or every tick would re-render every node.
  let prev: { sig: string; value: { nodes: Node[]; edges: Edge[] } } | null = null;

  const EMPTY_PETS: Pet[] = [];

  const graph = $derived.by(() => {
    if (!open) return prev?.value ?? { nodes: [], edges: [] };
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    // Subtree width (leaves one card wide, parents at least as wide as their row of children).
    const width = (n: number, kids: number[]) => (kids.length ? Math.max(kids.reduce((a, b) => a + b, 0) + (kids.length - 1) * (GAP_X + 8), n) : n);
    let cursor = 0;
    const sessions = store.list;
    for (const s of sessions) {
      const bots = agentTree.trees[s.id] ?? { rows: [], live: 0, total: 0 };
      const byPath = byPathOf(bots.rows);
      // Each agent's children, by path, in spawn order (from the deduped rows).
      const kidsOf = new Map<string, string[]>();
      for (const path of byPath.keys()) {
        const parent = path.includes("/") ? path.split("/").slice(0, -1).join("/") : "";
        kidsOf.set(parent, [...(kidsOf.get(parent) ?? []), path]);
      }
      // Measure: subtree width per path.
      const widthOf = new Map<string, number>();
      const measure = (path: string): number => {
        const kids = kidsOf.get(path) ?? [];
        const kidW = kids.map((k) => measure(k));
        const w = width(NODE_W, kidW);
        widthOf.set(path, w);
        return w;
      };
      measure("");
      const place = (path: string, x0: number, depth: number, pet: Pet | null) => {
        const kids = kidsOf.get(path) ?? [];
        if (pet) {
          const w = widthOf.get(path) ?? NODE_W;
          const x = x0 + w / 2 - NODE_W / 2;
          const y = (depth + 1) * (NODE_H + GAP_Y);
          nodes.push({
            id: `a:${s.id}:${path}`,
            type: "pet",
            position: { x, y },
            data: { name: pet.name, label: pet.label, tone: pet.tone, task: pet.task, avatarId: pet.sessionId, root: false },
            draggable: false,
          });
          const parentPath = path.includes("/") ? path.split("/").slice(0, -1).join("/") : "";
          edges.push({
            id: `e:${s.id}:${parentPath || "root"}->${path}`,
            source: parentPath ? `a:${s.id}:${parentPath}` : `s:${s.id}`,
            target: `a:${s.id}:${path}`,
            animated: pet.tone === "live",
            style: "stroke: var(--color-line-strong);",
          });
        }
        let kx = x0;
        for (const k of kids) {
          const pet2 = byPath.get(k) ?? null;
          place(k, kx, depth + 1, pet2);
          kx += (widthOf.get(k) ?? NODE_W) + GAP_X;
        }
      };
      const treeW = widthOf.get("") ?? NODE_W;
      // The session itself, root of its tree.
      nodes.push({
        id: `s:${s.id}`,
        type: "pet",
        position: { x: cursor + treeW / 2 - NODE_W / 2, y: 0 },
        data: {
          name: s.title || "session",
          // The same words the delegate rows use, from one rule: a session node used to show the
          // RAW status ("interrupted", "error") next to delegates saying "working"/"done", so the
          // same map spoke two languages.
          label: mapLabel(s.status),
          tone: mapTone(s.status),
          task: "",
          avatarId: s.id,
          root: true,
        },
        draggable: false,
      });
      place("", cursor, 0, null);
      cursor += treeW + TREE_GAP;
    }
    const value = { nodes, edges };
    const sig = `${nodes.length}:${edges.length}:${open}:${sessions.map((s) => s.id).join(",")}:${JSON.stringify(
      sessions.map((s) => [s.id, s.title, s.status]),
    )}:${JSON.stringify(sessions.flatMap((s) => (agentTree.trees[s.id]?.rows ?? []).map((r) => [r.id, r.path, r.name, r.label, r.tone, r.task])))}`;
    if (prev?.sig === sig) return prev.value;
    prev = { sig, value };
    return value;
  });

  let nodes = $derived(graph.nodes);
  let edges = $derived(graph.edges);

  const liveCount = $derived(store.list.reduce((n, s) => n + (agentTree.trees[s.id]?.live ?? 0), 0));

  function openPet(node: Node) {
    const id = String(node.id);
    const sid = id.startsWith("s:") ? id.slice(2) : (node.data.avatarId as string);
    if (!sid) return;
    open = false;
    onopensession(sid);
  }
</script>

<svelte:window onkeydown={onkey} />

<dialog
  bind:this={dialog}
  class="m-auto w-[calc(100*var(--vw)-1.5rem)] bg-transparent p-0 text-ink backdrop:bg-black/50 max-sm:w-[calc(100*var(--vw))]"
  aria-label="Team map"
  onclose={oncloseevent}
>
  <div bind:this={shell} class="elev-pop flex h-[calc(94*var(--vh))] w-full flex-col overflow-hidden rounded-2xl bg-canvas max-sm:h-[calc(100*var(--vh))] max-sm:rounded-none" role="document">
    <header class="flex shrink-0 items-center gap-2.5 border-b border-line/80 px-4 py-2.5">
      <Network size={15} class="shrink-0 text-ink-muted" strokeWidth={1.75} aria-hidden="true" />
      <h2 class="text-[14px] leading-5 font-medium">Team map</h2>
      <span class="tnum text-[11px] text-ink-faint">
        {store.list.length} session{store.list.length === 1 ? "" : "s"}{liveCount ? ` · ${liveCount} working` : ""}
      </span>
      <span class="ml-auto hidden text-[10.5px] text-ink-faint sm:inline">F fullscreen · Esc close</span>
      <Button variant="ghost" size="icon-sm" icon={fullscreen ? Minimize : Maximize} title={fullscreen ? "Exit fullscreen (F)" : "Fullscreen (F)"} onclick={() => void toggleFullscreen()} />
      <Button variant="ghost" size="icon-sm" icon={X} title="Close" onclick={() => (open = false)} />
    </header>
    <div class="map min-h-0 flex-1">
      {#if nodes.length}
        <SvelteFlow
          {nodes}
          {edges}
          {nodeTypes}
          fitView
          minZoom={0.1}
          maxZoom={1.6}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          zoomOnScroll
          panOnDrag
          proOptions={{ hideAttribution: false }}
          onnodeclick={({ node }: { node: Node }) => openPet(node)}
        >
          <FitView count={nodes.length} />
          <Background gap={20} />
          <Controls />
        </SvelteFlow>
      {:else}
        <div class="flex h-full flex-col items-center justify-center gap-2 text-center text-[12.5px] text-ink-muted">
          <Network size={22} strokeWidth={1.5} aria-hidden="true" />
          No open sessions yet — the map fills as the team works.
        </div>
      {/if}
    </div>
  </div>
</dialog>

<style>
  dialog {
    max-height: calc(100 * var(--vh));
  }
  .map {
    background: var(--color-canvas);
  }
  .map :global(.svelte-flow__controls) {
    background: var(--color-surface);
    border: 1px solid var(--color-line);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  .map :global(.svelte-flow__controls-button) {
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-line);
    fill: var(--color-ink-muted);
  }
  .map :global(.svelte-flow__controls-button:hover) {
    background: var(--color-raised);
  }
</style>
