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
  import TeamMapNode from "./TeamMapNode.svelte";
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

  const nodeTypes = { agent: TeamMapNode };

  const NODE_W = 158;
  const NODE_H = 66;
  const GAP_X = 26;
  const GAP_Y = 64;

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
    if (n.state === "stopped" && n.steps > 0 && !n.exitStatus) return { label: "done", tone: "ok" };
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
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    // The same tidy hierarchy as the team map: parents centred over their subtrees.
    const byPath = new Map<string, AgentNode>();
    for (const r of rows) if (!byPath.has(r.node.path)) byPath.set(r.node.path, r.node);
    const parentOf = (p: string) => (p.includes("/") ? p.split("/").slice(0, -1).join("/") : "");
    const kidsOf = new Map<string, string[]>();
    for (const p of [...byPath.keys()].sort((x, y) => (byPath.get(x)!.startedAt - byPath.get(y)!.startedAt))) {
      kidsOf.set(parentOf(p), [...(kidsOf.get(parentOf(p)) ?? []), p]);
    }
    const widthOf = new Map<string, number>();
    const measure = (path: string): number => {
      const kids = kidsOf.get(path) ?? [];
      const kw = kids.map(measure);
      const w = kids.length ? Math.max(kw.reduce((a, b) => a + b, 0) + (kids.length - 1) * GAP_X, NODE_W) : NODE_W;
      widthOf.set(path, w);
      return w;
    };
    const totalW = measure("");
    nodes.push({
      id: "root",
      type: "agent",
      position: { x: totalW / 2 - NODE_W / 2, y: 0 },
      data: { name: "session", label: "orchestrator", tone: "live", task: "", avatarId: "session", root: true, sessionId: "", state: "" },
      draggable: false,
    });
    const place = (path: string, x0: number, depth: number) => {
      const n = byPath.get(path);
      if (n) {
        const s = status(n);
        const w = widthOf.get(path) ?? NODE_W;
        nodes.push({
          id: `a-${n.path}`,
          type: "agent",
          position: { x: x0 + w / 2 - NODE_W / 2, y: depth * (NODE_H + GAP_Y) },
          data: { name: n.name, label: s.label, tone: s.tone, task: n.task, avatarId: n.sessionId, root: false, sessionId: n.sessionId, state: n.state },
          draggable: false,
        });
        const pp = parentOf(n.path);
        edges.push({
          id: `t-${pp || "root"}-${n.path}`,
          source: pp ? `a-${pp}` : "root",
          target: `a-${n.path}`,
          ...(n.origin ? { label: n.origin } : {}),
          animated: isLive(n),
          style: "stroke: var(--color-line-strong);",
        });
      }
      let kx = x0;
      for (const k of kidsOf.get(path) ?? []) {
        place(k, kx, depth + 1);
        kx += (widthOf.get(k) ?? NODE_W) + GAP_X;
      }
    };
    place("", 0, 0);
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
