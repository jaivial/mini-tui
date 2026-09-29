/** The SEO layer: titles, descriptions, canonicals, structured data and the sitemap. */
import { describe, expect, test } from "bun:test";
import { DESC_MAX, TITLE_MAX, buildMeta, clip, faqPage, fullTitle, jsonLd, robotsTxt, safeJson, sitemapXml } from "../site/src/lib/seo";
import { SITE_URL, abs } from "../site/src/lib/site";

describe("abs", () => {
  test("pages end in a slash (they are served as dir/index.html); files do not", () => {
    expect(abs("/")).toBe(`${SITE_URL}/`);
    expect(abs("/docs/install")).toBe(`${SITE_URL}/docs/install/`);
    expect(abs("/docs/install/")).toBe(`${SITE_URL}/docs/install/`);
    expect(abs("docs")).toBe(`${SITE_URL}/docs/`);
    expect(abs("/og.png")).toBe(`${SITE_URL}/og.png`);
    expect(abs("/sitemap.xml")).toBe(`${SITE_URL}/sitemap.xml`);
  });
  test("an absolute URL is left alone", () => {
    expect(abs("https://example.com/x")).toBe("https://example.com/x");
  });
});

describe("titles and descriptions", () => {
  test("the site name is appended once", () => {
    expect(fullTitle("Install")).toBe("Install | mini-tui");
    expect(fullTitle("mini-tui web app")).toBe("mini-tui web app");
  });
  test("clip never cuts mid-word and never exceeds the limit", () => {
    const long = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen";
    const out = clip(long, 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out.endsWith("…")).toBe(true);
    expect(long.startsWith(out.slice(0, -1))).toBe(true);
    expect(/\s…$/.test(out)).toBe(false);
  });
  test("text under the limit is only whitespace-normalised", () => {
    expect(clip("  a   b \n c ", 50)).toBe("a b c");
  });
  test("the meta description is capped for search results", () => {
    const m = buildMeta({ path: "/", title: "x", description: "word ".repeat(80) });
    expect(m.description.length).toBeLessThanOrEqual(DESC_MAX);
  });
});

describe("buildMeta", () => {
  const m = buildMeta({ path: "/docs/install", title: "Install", description: "How to install mini-tui from source, with Bun and Python, in about a minute on Linux or macOS." });
  test("canonical is absolute and matches og:url", () => {
    expect(m.canonical).toBe(`${SITE_URL}/docs/install/`);
    expect(m.og["og:url"]).toBe(m.canonical);
  });
  test("open graph and twitter cards carry a real 1200x630 image", () => {
    expect(m.og["og:image"]).toMatch(/^https?:\/\/.*\/og\.png$/);
    expect(m.og["og:image:width"]).toBe("1200");
    expect(m.og["og:image:height"]).toBe("630");
    expect(m.twitter["twitter:card"]).toBe("summary_large_image");
    expect(m.twitter["twitter:image"]).toBe(m.og["og:image"]);
  });
  test("indexable by default, with the rich-result directives", () => {
    expect(m.robots).toContain("index, follow");
    expect(m.robots).toContain("max-image-preview:large");
  });
  test("noindex switches indexing off", () => {
    expect(buildMeta({ path: "/x", title: "x", description: "d", noindex: true }).robots).toBe("noindex, nofollow");
  });
});

describe("structured data", () => {
  test("the home page is a SoftwareApplication with a free offer, and no article", () => {
    const g = (jsonLd({ path: "/", title: "", description: "d" }) as any)["@graph"];
    const types = g.map((n: any) => n["@type"]);
    expect(types).toContain("SoftwareApplication");
    expect(types).not.toContain("TechArticle");
    const app = g.find((n: any) => n["@type"] === "SoftwareApplication");
    expect(app.offers.price).toBe("0");
    // never claim what the repository does not establish: no licence URL, no unverified platform list
    expect(app.license).toBeUndefined();
    expect(app.operatingSystem).toBeUndefined();
  });
  test("a doc page is a TechArticle with breadcrumbs, not an application", () => {
    const g = (jsonLd({ path: "/docs/install", title: "Install", description: "d".repeat(80), type: "article", modified: "2026-09-29", crumbs: [{ name: "Home", path: "/" }, { name: "Docs", path: "/docs" }, { name: "Install", path: "/docs/install" }] }) as any)["@graph"];
    const types = g.map((n: any) => n["@type"]);
    expect(types).toContain("TechArticle");
    expect(types).toContain("BreadcrumbList");
    expect(types).not.toContain("SoftwareApplication");
    const crumbs = g.find((n: any) => n["@type"] === "BreadcrumbList").itemListElement;
    expect(crumbs.map((c: any) => c.position)).toEqual([1, 2, 3]);
    expect(crumbs.at(-1).item).toBe(`${SITE_URL}/docs/install/`);
  });
  test("a FAQ block mirrors the visible questions exactly", () => {
    const faq = [{ q: "Is it free?", a: "Yes." }, { q: "Does it need Docker?", a: "No." }];
    const node = faqPage(faq) as any;
    expect(node.mainEntity.map((q: any) => q.name)).toEqual(["Is it free?", "Does it need Docker?"]);
    expect(node.mainEntity[1].acceptedAnswer.text).toBe("No.");
  });
  test("every entity in the graph is linked by a stable @id", () => {
    const g = (jsonLd({ path: "/", title: "", description: "d" }) as any)["@graph"];
    expect(g.find((n: any) => n["@type"] === "Organization")["@id"]).toBe(`${SITE_URL}/#org`);
    expect(g.find((n: any) => n["@type"] === "WebSite").publisher["@id"]).toBe(`${SITE_URL}/#org`);
  });
});

describe("safeJson", () => {
  test("cannot close the script tag, and still parses back", () => {
    const value = { a: "</script><script>alert(1)</script>", b: "<!-- x -->", c: "line\u2028sep" };
    const out = safeJson(value);
    expect(out).not.toContain("</script>");
    expect(out).not.toContain("<!--");
    expect(out).not.toContain("\u2028");
    expect(JSON.parse(out)).toEqual(value);
  });
});

describe("sitemap and robots", () => {
  test("well-formed, absolute, escaped, and only what was passed in", () => {
    const xml = sitemapXml([{ path: "/", priority: 1, modified: "2026-09-29" }, { path: "/docs/a&b", changefreq: "weekly" }]);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain(`<loc>${SITE_URL}/</loc>`);
    expect(xml).toContain("<lastmod>2026-09-29</lastmod>");
    expect(xml).toContain("a&amp;b/");
    expect(xml).toContain("<priority>1.0</priority>");
    expect(xml.match(/<url>/g)).toHaveLength(2);
  });
  test("robots allows crawling and points at the sitemap", () => {
    const r = robotsTxt();
    expect(r).toContain("User-agent: *");
    expect(r).toContain("Allow: /");
    expect(r).toContain(`Sitemap: ${SITE_URL}/sitemap.xml`);
    expect(robotsTxt(["/private"])).toContain("Disallow: /private");
  });
});
