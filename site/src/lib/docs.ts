/**
 * The pure half of the docs pipeline: front matter, markdown, heading anchors and navigation. No Vite
 * and no filesystem, so it runs under `bun test` as well as in the build. `docs-data.ts` supplies the
 * files. Raw HTML is disabled in the markdown: the content is ours, but nothing here should ever be able
 * to inject markup.
 */
import MarkdownIt from "markdown-it";

export interface Heading {
  id: string;
  text: string;
  level: 2 | 3;
}
export interface Doc {
  slug: string;
  title: string;
  description: string;
  section: string;
  order: number;
  html: string;
  headings: Heading[];
  /** Plain-text words: drives the reading-time estimate. */
  words: number;
}

/** `Run it` -> `run-it`; deterministic and URL-safe, unique within one document. */
export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[`*_~[\]()]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "section"
  );
}

export function parseFrontMatter(source: string): { data: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!m) return { data: {}, body: source };
  const data: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) data[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return { data, body: source.slice(m[0].length) };
}

/**
 * `base` is the site's base path (`/mini-tui` on GitHub Pages). Markdown links to a page of this site
 * are written from the root (`/docs/install/`), so they read the same in the repo; they get the base here.
 */
export function render(body: string, base = ""): { html: string; headings: Heading[] } {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
  const headings: Heading[] = [];
  const used = new Map<string, number>();
  const defaultOpen = md.renderer.rules.heading_open;
  md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx]!;
    const level = Number(token.tag.slice(1));
    if (level === 2 || level === 3) {
      const text = tokens[idx + 1]?.children?.map((c) => c.content).join("") ?? "";
      let id = slugify(text);
      const n = used.get(id) ?? 0;
      used.set(id, n + 1);
      if (n) id = `${id}-${n + 1}`;
      token.attrSet("id", id);
      headings.push({ id, text, level: level as 2 | 3 });
    }
    return defaultOpen ? defaultOpen(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
  };
  // External links: safe rel, and open in the same tab (no surprise windows).
  const defaultLink = md.renderer.rules.link_open;
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const href = String(tokens[idx]!.attrGet("href") ?? "");
    if (/^https?:\/\//.test(href)) tokens[idx]!.attrSet("rel", "noopener");
    else if (base && href.startsWith("/") && !href.startsWith("//") && !href.startsWith(`${base}/`)) tokens[idx]!.attrSet("href", `${base}${href}`);
    return defaultLink ? defaultLink(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
  };
  return { html: md.render(body), headings };
}

export function buildDoc(slug: string, source: string, base = ""): Doc {
  const { data, body } = parseFrontMatter(source);
  if (!data.title || !data.description) throw new Error(`docs/${slug}.md needs a title and a description in its front matter`);
  const { html, headings } = render(body, base);
  return {
    slug,
    title: data.title,
    description: data.description,
    section: data.section ?? "Docs",
    order: Number(data.order ?? 99),
    html,
    headings,
    words: body.replace(/```[\s\S]*?```/g, " ").split(/\s+/).filter(Boolean).length,
  };
}

export function docSections(list: Doc[]): { name: string; pages: Doc[] }[] {
  const out: { name: string; pages: Doc[] }[] = [];
  for (const d of list) {
    let s = out.find((x) => x.name === d.section);
    if (!s) out.push((s = { name: d.section, pages: [] }));
    s.pages.push(d);
  }
  return out;
}

export function neighbours(slug: string, list: Doc[]): { prev?: Doc; next?: Doc } {
  const i = list.findIndex((d) => d.slug === slug);
  return { prev: i > 0 ? list[i - 1] : undefined, next: i >= 0 ? list[i + 1] : undefined };
}

export const readingMinutes = (words: number) => Math.max(1, Math.round(words / 220));
