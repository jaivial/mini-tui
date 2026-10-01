/** The docs pipeline: front matter, safe markdown, heading anchors and navigation. */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildDoc, docSections, neighbours, parseFrontMatter, readingMinutes, render, slugify } from "../site/src/lib/docs";
import { DESC_MAX, DESC_MIN } from "../site/src/lib/seo";

describe("slugify", () => {
  test("lowercase, hyphenated, URL-safe", () => {
    expect(slugify("Run it")).toBe("run-it");
    expect(slugify("Why the prompt cannot run as a command")).toBe("why-the-prompt-cannot-run-as-a-command");
    expect(slugify("`/compact` & more!")).toBe("compact-more");
    expect(slugify("Café résumé")).toBe("cafe-resume");
  });
  test("never empty", () => {
    expect(slugify("???")).toBe("section");
  });
});

describe("parseFrontMatter", () => {
  test("reads keys and strips the block", () => {
    const { data, body } = parseFrontMatter('---\ntitle: "Hello: world"\norder: 3\n---\n\n# Body');
    expect(data).toEqual({ title: "Hello: world", order: "3" });
    expect(body.trim()).toBe("# Body");
  });
  test("no front matter is fine", () => {
    expect(parseFrontMatter("# Just text").data).toEqual({});
  });
});

describe("render", () => {
  test("h2 and h3 get unique ids and are collected; h1 is left alone", () => {
    const { html, headings } = render("# Top\n\n## Same\n\ntext\n\n## Same\n\n### Deep\n");
    expect(headings.map((h) => h.id)).toEqual(["same", "same-2", "deep"]);
    expect(html).toContain('<h2 id="same">');
    expect(html).toContain('<h2 id="same-2">');
    expect(html).toContain('<h3 id="deep">');
    expect(html).not.toContain('<h1 id');
  });
  test("raw HTML in the source is never passed through", () => {
    const { html } = render('hello <script>alert(1)</script> <img src=x onerror=alert(1)>\n\n<div onclick="x()">y</div>');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<div onclick");
    expect(html).toContain("&lt;script&gt;");
  });
  test("external links get rel=noopener", () => {
    expect(render("[x](https://example.com)").html).toContain('rel="noopener"');
    expect(render("[x](/docs/install/)").html).not.toContain("rel=");
  });
  test("code fences render as pre/code", () => {
    expect(render("```bash\nbun run web\n```").html).toContain("<pre><code");
  });
});

describe("buildDoc", () => {
  test("a doc without a title or description is a build error, not a blank page", () => {
    expect(() => buildDoc("x", "---\ntitle: T\n---\nbody")).toThrow(/description/);
    expect(() => buildDoc("x", "---\ndescription: D\n---\nbody")).toThrow(/title/);
  });
  test("words ignore code blocks; reading time is at least one minute", () => {
    const d = buildDoc("x", "---\ntitle: T\ndescription: D\n---\none two three\n\n```\nnot counted at all here\n```\n");
    expect(d.words).toBe(3);
    expect(readingMinutes(d.words)).toBe(1);
    expect(readingMinutes(1100)).toBe(5);
  });
});

describe("navigation", () => {
  const mk = (slug: string, order: number, section: string) => buildDoc(slug, `---\ntitle: ${slug}\ndescription: d\norder: ${order}\nsection: ${section}\n---\nx`);
  const list = [mk("a", 1, "One"), mk("b", 2, "One"), mk("c", 3, "Two")];
  test("sections keep reading order", () => {
    expect(docSections(list).map((s) => [s.name, s.pages.map((p) => p.slug)])).toEqual([["One", ["a", "b"]], ["Two", ["c"]]]);
  });
  test("previous and next, and none at the ends", () => {
    expect(neighbours("b", list)).toMatchObject({ prev: { slug: "a" }, next: { slug: "c" } });
    expect(neighbours("a", list).prev).toBeUndefined();
    expect(neighbours("c", list).next).toBeUndefined();
    expect(neighbours("nope", list)).toEqual({ prev: undefined, next: undefined });
  });
});

describe("the real docs", () => {
  const dir = join(import.meta.dir, "..", "site", "src", "content", "docs");
  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  test("there are docs", () => expect(files.length).toBeGreaterThanOrEqual(6));
  for (const f of files) {
    const doc = buildDoc(f.replace(/\.md$/, ""), readFileSync(join(dir, f), "utf8"));
    test(`${f}: a description that fits a search result`, () => {
      expect(doc.description.length).toBeGreaterThanOrEqual(DESC_MIN);
      expect(doc.description.length).toBeLessThanOrEqual(DESC_MAX);
    });
    test(`${f}: a title short enough not to truncate, and a real outline`, () => {
      expect(doc.title.length).toBeLessThanOrEqual(45);
      expect(doc.headings.length).toBeGreaterThanOrEqual(2);
    });
    test(`${f}: no heading id collides`, () => {
      expect(new Set(doc.headings.map((h) => h.id)).size).toBe(doc.headings.length);
    });
    test(`${f}: no relative links that would 404 once prerendered`, () => {
      for (const m of doc.html.matchAll(/href="([^"]+)"/g)) expect(m[1]).not.toMatch(/^\.{1,2}\//);
    });
  }
  test("titles and descriptions are unique across the docs", () => {
    const all = files.map((f) => buildDoc(f, readFileSync(join(dir, f), "utf8")));
    expect(new Set(all.map((d) => d.title)).size).toBe(all.length);
    expect(new Set(all.map((d) => d.description)).size).toBe(all.length);
  });
});

describe("links inside the docs", () => {
  test("a link to a page of this site gets the base path; external and anchor links do not", async () => {
    const { render } = await import("../site/src/lib/docs");
    const { html } = render("[a](/docs/install/) [b](https://example.com/x) [c](#here) [d](/mini-tui/docs/x/)", "/mini-tui");
    expect(html).toContain('href="/mini-tui/docs/install/"');
    expect(html).toContain('href="https://example.com/x" rel="noopener"');
    expect(html).toContain('href="#here"');
    expect(html).toContain('href="/mini-tui/docs/x/"'); // already based: not doubled
  });
  test("with no base path (a site at the root), links are left as written", async () => {
    const { render } = await import("../site/src/lib/docs");
    expect(render("[a](/docs/install/)").html).toContain('href="/docs/install/"');
  });
});

describe("images inside the docs", () => {
  test("an image gets the base path, lazy loading, its alt text and the size from #WxH", async () => {
    const { render } = await import("../site/src/lib/docs");
    const { html } = render("![Four panes side by side](/screens/web-panes.webp#3360x2000)", "/mini-tui");
    expect(html).toContain('src="/mini-tui/screens/web-panes.webp"');
    expect(html).toContain('alt="Four panes side by side"');
    expect(html).toContain('width="3360" height="2000"');
    expect(html).toContain('loading="lazy"');
  });
  test("quotes and angle brackets in alt text cannot break out of the attribute", async () => {
    const { render } = await import("../site/src/lib/docs");
    expect(render('![a "b" <c>](/x.png)').html).toContain('alt="a &quot;b&quot; &lt;c>"');
  });
});
