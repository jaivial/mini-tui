/**
 * Diagrams written with the mental-diagram skill (`src/lib/diagrams/<id>.json`, same schema), laid out
 * at build time with dagre so the prerendered page shows the whole graph without JavaScript.
 * Each node is a UML-style box: «stereotype» + name, then attributes, operations, responsibilities.
 */
import dagre from "@dagrejs/dagre";

export interface Field { name: string; type?: string; description?: string }
export interface DiagramNode {
  id: string; label: string; kind?: string; stereotype?: string; file?: string; summary?: string;
  attributes?: Field[]; operations?: Field[]; responsibilities?: string[];
  input?: Field[]; process?: string[]; output?: Field[]; code?: string; notes?: string;
}
export interface Diagram {
  id: string; title: string; project?: string; question?: string; summary?: string; source?: string;
  direction?: "LR" | "TB"; updatedAt?: string; nodes: DiagramNode[]; edges: { source: string; target: string; label?: string }[];
}

export const fieldText = (f: Field) => (f.type ? `${f.name}: ${f.type}` : f.name);

export function compartments(n: DiagramNode) {
  return [
    { key: "attributes", mark: "−", lines: (n.attributes ?? []).map(fieldText) },
    { key: "operations", mark: "+", lines: (n.operations ?? []).map(fieldText) },
    { key: "responsibilities", mark: "–", lines: n.responsibilities ?? [] },
  ].filter((c) => c.lines.length > 0);
}

// Box geometry (px). Lines are 11.5px monospace (~7px a char); long lines wrap inside the box, so the
// height counts wrapped lines.
const MIN_W = 240, MAX_W = 340, CHAR_W = 7, LINE_H = 17, HEAD_H = 54, SUMMARY_H = 18, PAD = 12;
const wrapped = (s: string, w: number) => Math.max(1, Math.ceil(((s.length + 2) * CHAR_W) / (w - 24)));

export function boxSize(n: DiagramNode) {
  const parts = compartments(n);
  const longest = Math.max((n.label.length + 4) * 8, ...parts.flatMap((c) => c.lines.map((l) => (l.length + 2) * CHAR_W + 24)));
  const width = Math.round(Math.min(MAX_W, Math.max(MIN_W, longest)));
  const height = HEAD_H + (n.summary ? SUMMARY_H : 0) + parts.reduce((h, c) => h + PAD + c.lines.reduce((s, l) => s + wrapped(l, width), 0) * LINE_H, 0);
  return { width, height };
}

export interface Laid {
  width: number; height: number;
  nodes: { node: DiagramNode; x: number; y: number; width: number; height: number }[];
  edges: { path: string; label?: string; lx: number; ly: number; back: boolean }[];
}

export function layout(d: Diagram): Laid {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: d.direction ?? "LR", nodesep: 40, ranksep: 64, edgesep: 20, marginx: 16, marginy: 16 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of d.nodes) g.setNode(n.id, boxSize(n));
  d.edges.forEach((e, i) =>
    g.setEdge(e.source, e.target, { width: e.label ? e.label.length * 6.4 + 12 : 0, height: e.label ? 18 : 0, labelpos: "c" }, `e${i}`),
  );
  dagre.layout(g);
  const rank = new Map(d.nodes.map((n) => [n.id, g.node(n.id).y]));
  return {
    width: Math.ceil(g.graph().width ?? 0),
    height: Math.ceil(g.graph().height ?? 0),
    nodes: d.nodes.map((n) => {
      const p = g.node(n.id);
      return { node: n, x: p.x - p.width / 2, y: p.y - p.height / 2, width: p.width, height: p.height };
    }),
    edges: d.edges.map((e, i) => {
      const p = g.edge({ v: e.source, w: e.target, name: `e${i}` });
      const pts: { x: number; y: number }[] = p.points ?? [];
      const path = pts.map((q, j) => `${j ? "L" : "M"}${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(" ");
      return { path, label: e.label, lx: p.x ?? 0, ly: p.y ?? 0, back: (rank.get(e.target) ?? 0) < (rank.get(e.source) ?? 0) };
    }),
  };
}
