/**
 * The docs, read from `src/content/docs/*.md` at build time (Vite `import.meta.glob`, so they are bundled
 * and prerendered: nothing touches the filesystem at request time). Vite-only; the pure logic is `docs.ts`.
 */
import { buildDoc, docSections as sections, neighbours as near, type Doc } from "./docs";

const files = import.meta.glob("../content/docs/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

export const docs: Doc[] = Object.entries(files)
  .map(([path, source]) => buildDoc(path.split("/").pop()!.replace(/\.md$/, ""), source))
  .sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));

export const docBySlug = (slug: string): Doc | undefined => docs.find((d) => d.slug === slug);

export const docSections = () => sections(docs);
export const neighbours = (slug: string) => near(slug, docs);
