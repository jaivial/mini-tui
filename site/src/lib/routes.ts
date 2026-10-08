/** The list of pages, used for the sitemap and for llms.txt. Adding a route means adding it here. */
import { docs } from "./docs-data";
import { diagrams } from "./diagrams-data";
import type { SitemapEntry } from "./seo";

const MODIFIED = "2026-10-01";

export const pages: SitemapEntry[] = [
  { path: "/", priority: 1, changefreq: "weekly", modified: MODIFIED },
  { path: "/web-app/", priority: 0.9, changefreq: "monthly", modified: MODIFIED },
  { path: "/docs/", priority: 0.8, changefreq: "monthly", modified: MODIFIED },
  ...docs.map((d): SitemapEntry => ({ path: `/docs/${d.slug}/`, priority: 0.7, changefreq: "monthly", modified: MODIFIED })),
  ...diagrams.map((d): SitemapEntry => ({ path: `/diagrams/${d.id}/`, priority: 0.6, changefreq: "monthly", modified: (d.updatedAt ?? MODIFIED).slice(0, 10) })),
  { path: "/changelog/", priority: 0.5, changefreq: "weekly", modified: MODIFIED },
];
