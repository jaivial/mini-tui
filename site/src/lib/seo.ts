/**
 * Everything a search engine or a link preview reads, built from one `Page` description.
 * Pure functions (no DOM, no Svelte), so the rules are unit-tested and the same output is used at
 * prerender time and in the SEO audit script.
 */
import { AUTHOR, DESCRIPTION, NAME, OG_IMAGE, OG_SIZE, REPO, RELEASE, SITE_URL, abs } from "./site";

export interface Crumb {
  name: string;
  path: string;
}
export interface Faq {
  q: string;
  a: string;
}
export interface Page {
  /** Route path, `/` or `/docs/install`. */
  path: string;
  /** The page-specific part of the title; the site name is appended. */
  title: string;
  description: string;
  /** `website` for the home page, `article` for docs. */
  type?: "website" | "article";
  crumbs?: Crumb[];
  faq?: Faq[];
  /** ISO date (YYYY-MM-DD) the content last changed. */
  modified?: string;
  image?: string;
  noindex?: boolean;
}

/** 50-60 characters is what a results page shows before truncating. */
export const TITLE_MAX = 60;
export const DESC_MIN = 70;
export const DESC_MAX = 160;

export function fullTitle(title: string): string {
  if (!title) return NAME;
  const t = title.includes(NAME) ? title : `${title} | ${NAME}`;
  return t;
}

/** Collapse whitespace and cut at a word boundary with an ellipsis, never mid-word. */
export function clip(text: string, max: number): string {
  const s = text.replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  return `${cut.slice(0, cut.lastIndexOf(" ") > max * 0.6 ? cut.lastIndexOf(" ") : cut.length).replace(/[,;:.\s-]+$/, "")}…`;
}

export interface Meta {
  title: string;
  description: string;
  canonical: string;
  robots: string;
  og: Record<string, string>;
  twitter: Record<string, string>;
}

export function buildMeta(page: Page): Meta {
  const title = fullTitle(page.title);
  const description = clip(page.description || DESCRIPTION, DESC_MAX);
  const canonical = abs(page.path);
  const image = abs(page.image ?? OG_IMAGE);
  return {
    title,
    description,
    canonical,
    robots: page.noindex ? "noindex, nofollow" : "index, follow, max-image-preview:large, max-snippet:-1",
    og: {
      "og:type": page.type ?? "website",
      "og:site_name": NAME,
      "og:title": title,
      "og:description": description,
      "og:url": canonical,
      "og:image": image,
      "og:image:width": String(OG_SIZE.width),
      "og:image:height": String(OG_SIZE.height),
      "og:image:alt": `${NAME}: ${page.title || "the web app"}`,
      "og:locale": "en_US",
    },
    twitter: {
      "twitter:card": "summary_large_image",
      "twitter:title": title,
      "twitter:description": description,
      "twitter:image": image,
    },
  };
}

type Json = Record<string, unknown>;

export function organization(): Json {
  return { "@type": "Organization", "@id": `${SITE_URL}/#org`, name: NAME, url: abs("/"), logo: abs("/favicon.svg"), sameAs: [REPO] };
}

export function website(): Json {
  return { "@type": "WebSite", "@id": `${SITE_URL}/#website`, url: abs("/"), name: NAME, description: DESCRIPTION, inLanguage: "en", publisher: { "@id": `${SITE_URL}/#org` } };
}

export function softwareApplication(): Json {
  return {
    "@type": "SoftwareApplication",
    "@id": `${SITE_URL}/#app`,
    name: NAME,
    description: DESCRIPTION,
    applicationCategory: "DeveloperApplication",
    applicationSubCategory: "AI coding agent",
    softwareVersion: RELEASE,
    url: abs("/"),
    downloadUrl: `${REPO}/releases/latest`,
    codeRepository: REPO,
    // No price is charged for the software itself; the model provider bills for its own usage.
    isAccessibleForFree: true,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    author: { "@type": "Person", name: AUTHOR.name, url: AUTHOR.url },
    image: abs(OG_IMAGE),
  };
}

export function breadcrumbs(crumbs: Crumb[]): Json {
  return {
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.name, item: abs(c.path) })),
  };
}

export function faqPage(faq: Faq[]): Json {
  return { "@type": "FAQPage", mainEntity: faq.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) };
}

export function article(page: Page): Json {
  return {
    "@type": "TechArticle",
    headline: clip(page.title, 110),
    description: clip(page.description, DESC_MAX),
    url: abs(page.path),
    mainEntityOfPage: abs(page.path),
    image: abs(page.image ?? OG_IMAGE),
    dateModified: page.modified,
    author: { "@type": "Person", name: AUTHOR.name, url: AUTHOR.url },
    publisher: { "@id": `${SITE_URL}/#org` },
    inLanguage: "en",
  };
}

/** One `@graph` per page: every entity that page really is, and nothing it is not. */
export function jsonLd(page: Page): Json {
  const graph: Json[] = [organization(), website()];
  if (page.path === "/") graph.push(softwareApplication());
  else if (page.type === "article") graph.push(article(page));
  if (page.crumbs?.length) graph.push(breadcrumbs(page.crumbs));
  if (page.faq?.length) graph.push(faqPage(page.faq));
  return { "@context": "https://schema.org", "@graph": graph };
}

/**
 * JSON inside a <script> must not be able to close it: `</script>` and `<!--` are escaped, and the
 * line separators that break older parsers. Output is still valid JSON.
 */
export function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export interface SitemapEntry {
  path: string;
  modified?: string;
  priority?: number;
  changefreq?: "daily" | "weekly" | "monthly" | "yearly";
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function sitemapXml(entries: SitemapEntry[]): string {
  const rows = entries
    .map((e) => {
      const parts = [`<loc>${esc(abs(e.path))}</loc>`];
      if (e.modified) parts.push(`<lastmod>${e.modified}</lastmod>`);
      if (e.changefreq) parts.push(`<changefreq>${e.changefreq}</changefreq>`);
      if (e.priority !== undefined) parts.push(`<priority>${e.priority.toFixed(1)}</priority>`);
      return `  <url>${parts.join("")}</url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows}\n</urlset>\n`;
}

export function robotsTxt(disallow: string[] = []): string {
  const lines = ["User-agent: *", "Allow: /", ...disallow.map((d) => `Disallow: ${d}`), "", `Sitemap: ${abs("/sitemap.xml")}`];
  return `${lines.join("\n")}\n`;
}
