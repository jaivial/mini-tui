<script lang="ts">
  /**
   * The session's agent tree as a live node graph: the session on top, every agent it starts
   * below, in spawn order, with solid edges for the parent-child tree and dashed edges for what
   * agents say to each other (messages, replies, handoffs). Fed by the agents SSE stream, so
   * nodes and states move in real time. Read-only: clicking a node opens that agent's session,
   * unless that session is stopped or no longer in the history (then the click is ignored).
   */
  import { SvelteFlow, Background, Controls, Handle, Position, type Node, type Edge } from "@xyflow/svelte";
  import "@xyflow/svelte/dist/style.css";
  import AgentGraphNode from "./AgentGraphNode.svelte";
  import FitView from "./FitView.svelte";
  import { api } from "../api";
  import type { AgentEvent, AgentNode, AgentsView } from "../types";

  let {
    view,
    onopen,
  }: {
    view: AgentsView;
    onopen: (sessionId: string) => void;
  } = $props();

  const nodeTypes = { agent: AgentGraphNode };

  const NODE_W = 230;
  const GAP_X = 40;
  const GAP_Y = 90;

  function isLive(n: AgentNode) {
    return n.state === "running" || n.state === "starting";
  }
  function status(n: AgentNode): { label: string; tone: string } {
    if (n.waitingChildren.length) return { label: `waiting on ${n.waitingChildren.length}`, tone: "wait" };
    if (n.awaiting) return { label: `waiting on ${n.awaiting}`, tone: "wait" };
    if (isLive(n)) return { label: n.state === "starting" ? "starting" : "working", tone: "live" };
    if (n.state === "dead") return { label: "dead", tone: "err" };
    if (n.state === "waiting") return n.exitStatus && n.exitStatus !== "Submitted" ? { label: n.exitStatus, tone: "warn" } : { label: "done", tone: "ok" };
    if (n.state === "exited" && n.exitStatus && n.exitStatus !== "Submitted") return { label: "failed", tone: "err" };
    if (n.state === "stopped") return { label: "stopped", tone: "idle" };
    return { label: n.exitStatus === "Submitted" ? "done" : n.state, tone: n.exitStatus === "Submitted" ? "ok" : "idle" };
  }

  /** Every node depth-first; the tree order already is spawn order per level. */
  function flatten(nodes: AgentNode[], depth = 0, out: { node: AgentNode; depth: number }[] = []) {
    for (const node of nodes) {
      out.push({ node, depth });
      flatten(node.children, depth + 1, out);
    }
    return out;
  }

  function full(scope: string, name: string): string {
    if (!name || name === "parent" || name === "hub") return name;
    return scope ? `${scope}/${name}` : name;
  }

  /** What agents say to each other, deduped per ordered pair: the dashed relation edges. */
  function relationEdges(events: AgentEvent[], paths: Set<string>): Edge[] {
    const seen = new Map<string, { kind: string; at: number }>();
    for (const e of events) {
      if (!["message", "reply", "handoff"].includes(e.kind)) continue;
      const from = e.from === "parent" ? e.scope : full(e.scope, e.from);
      for (const raw of e.to.split(",")) {
        const to = raw.trim() === "parent" ? e.scope : full(e.scope, raw.trim());
        if (!from || !to || from === to || !paths.has(from) || !paths.has(to)) continue;
        const key = `${from}->${to}`;
        const prev = seen.get(key);
        if (!prev || e.at > prev.at) seen.set(key, { kind: e.kind, at: e.at });
      }
    }
    return [...seen].map(([key, v]) => {
      const [source, target] = key.split("->");
      return {
        id: `r-${key}`,
        source: `a-${source}`,
        target: `a-${target}`,
        label: v.kind,
        animated: true,
        style: "stroke: var(--color-line-strong); stroke-dasharray: 5 4;",
      } satisfies Edge;
    });
  }

  // The SSE stream ticks often; only hand Svelte Flow new arrays when something actually
  // changed, or every tick re-renders the whole graph.
  let prev: { sig: string; value: { nodes: Node[]; edges: Edge[] } } | null = null;

  const graph = $derived.by(() => {
    const rows = flatten(view.nodes);
    const byDepth = new Map<number, { node: AgentNode; depth: number }[]>();
    for (const r of rows) {
      const list = byDepth.get(r.depth) ?? [];
      list.push(r);
      byDepth.set(r.depth, list);
    }
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    // The session itself on top, as the orchestrator root.
    const maxWidth = Math.max(1, ...[...byDepth.values()].map((l) => l.length));
    const totalW = (n: number) => n * NODE_W + (n - 1) * GAP_X;
    nodes.push({
      id: "root",
      type: "agent",
      position: { x: (totalW(maxWidth) - NODE_W) / 2, y: 0 },
      data: { name: "session", label: "orchestrator", tone: "live", model: "", steps: 0, cost: 0, task: "", root: true, sessionId: "", state: "" },
      draggable: false,
    });
    for (const [depth, list] of byDepth) {
      const ordered = [...list].sort((a, b) => a.node.startedAt - b.node.startedAt);
      const x0 = (totalW(maxWidth) - totalW(ordered.length)) / 2;
      ordered.forEach((r, i) => {
        const s = status(r.node);
        nodes.push({
          id: `a-${r.node.path}`,
          type: "agent",
          position: { x: x0 + i * (NODE_W + GAP_X), y: (depth + 1) * (GAP_Y + 60) },
          data: {
            name: r.node.name,
            label: s.label,
            tone: s.tone,
            model: r.node.model,
            steps: r.node.steps,
            cost: r.node.cost,
            task: r.node.task,
            origin: r.node.origin,
            root: false,
            sessionId: r.node.sessionId,
            state: r.node.state,
          },
          draggable: false,
        });
        const parentPath = r.node.path.includes("/") ? r.node.path.split("/").slice(0, -1).join("/") : null;
        edges.push({
          id: `t-${parentPath ?? "root"}-${r.node.path}`,
          source: parentPath ? `a-${parentPath}` : "root",
          target: `a-${r.node.path}`,
          ...(r.node.origin ? { label: r.node.origin } : {}),
          animated: isLive(r.node),
          style: "stroke: var(--color-line-strong);",
        });
      });
    }
    const paths = new Set(rows.map((r) => r.node.path));
    edges.push(...relationEdges(view.events, paths));
    const value = { nodes, edges };
    const sig = JSON.stringify(value);
    if (prev?.sig === sig) return prev.value;
    prev = { sig, value };
    return value;
  });

  let nodes = $derived(graph.nodes);
  let edges = $derived(graph.edges);

  // Stopped sessions and sessions no longer in the history error out when opened:
  // ignore those clicks instead of redirecting.
  let historyIds: Set<string> | null = null;
  async function openNode(node: Node) {
    const sid = node.data.sessionId as string;
    const state = node.data.state as string;
    if (!sid || state === "stopped") return;
    if (state !== "running" && state !== "starting") {
      if (!historyIds) {
        try {
          historyIds = new Set((await api.history("", 500)).map((h) => h.id));
        } catch {
          historyIds = new Set();
        }
      }
      if (historyIds.size && !historyIds.has(sid)) return;
    }
    onopen(sid);
  }
</script>

<div class="graph-wrap">
  <SvelteFlow
    {nodes}
    {edges}
    {nodeTypes}
    fitView
    minZoom={0.2}
    nodesDraggable={false}
    nodesConnectable={false}
    elementsSelectable={false}
    zoomOnScroll
    panOnDrag
    proOptions={{ hideAttribution: false }}
    onnodeclick={({ node }: { node: Node }) => void openNode(node)}
  >
    <FitView count={nodes.length} />
    <Background gap={20} />
    <Controls />
  </SvelteFlow>
</div>

<style>
  .graph-wrap {
    height: 100%;
    min-height: 320px;
    background: var(--color-canvas);
  }
  .graph-wrap :global(.svelte-flow__controls) {
    background: var(--color-surface);
    border: 1px solid var(--color-line);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  .graph-wrap :global(.svelte-flow__controls-button) {
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-line);
    fill: var(--color-ink-muted);
  }
  .graph-wrap :global(.svelte-flow__controls-button:hover) {
    background: var(--color-raised);
  }
  .graph-wrap :global(.svelte-flow__edge-label) {
    background: var(--color-raised);
    color: var(--color-ink-muted);
    border: 1px solid var(--color-line);
    border-radius: 999px;
    padding: 0 7px;
    font-size: 10px;
  }
</style>
