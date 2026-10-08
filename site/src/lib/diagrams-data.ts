/** The diagrams in `src/lib/diagrams/*.json`, bundled at build time (Vite-only; layout is `diagram.ts`). */
import type { Diagram } from "./diagram";

const files = import.meta.glob("./diagrams/*.json", { import: "default", eager: true }) as Record<string, Diagram>;

export const diagrams: Diagram[] = Object.values(files).sort((a, b) => a.title.localeCompare(b.title));
export const diagramById = (id: string) => diagrams.find((d) => d.id === id);
