/**
 * Facts about the site, in one place, so a title, a canonical URL and a JSON-LD block can never
 * disagree with each other. `SITE_URL` is the canonical origin (no trailing slash); the deploy sets it.
 */
export const SITE_URL: string = (import.meta.env.VITE_SITE_URL ?? "https://jaivial.github.io/mini-tui").replace(/\/$/, "");
export const REPO = "https://github.com/jaivial/mini-tui";
export const RELEASE = "0.43.0";
export const NAME = "mini-tui";
export const TAGLINE = "Bots that run your kanban, from the web or WhatsApp";
export const DESCRIPTION =
  "mini-tui is a team of bots that organize work as a kanban: you talk in the web app or a WhatsApp group, workers ship the cards, and a card closes only with evidence.";
export const OG_IMAGE = "/og.png";
export const OG_SIZE = { width: 1200, height: 630 } as const;
export const AUTHOR = { name: "Jaime Villanueva Alcon", url: "https://github.com/jaivial" };

/**
 * Absolute URL for a route path. The site is prerendered with `trailingSlash: "always"` (every page is
 * `dir/index.html`, which every static host serves), so a page's URL ends in `/`. The canonical, the
 * sitemap and the JSON-LD must all use that exact form or they disagree with the URL that is served.
 * Files (`/og.png`, `/sitemap.xml`) keep no slash.
 */
export function abs(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  const p = path.startsWith("/") ? path : `/${path}`;
  const isFile = /\.[a-z0-9]{2,5}$/i.test(p.split("/").pop() ?? "");
  return `${SITE_URL}${isFile || p.endsWith("/") ? p : `${p}/`}`;
}
