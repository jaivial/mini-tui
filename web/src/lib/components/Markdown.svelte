<script lang="ts">
  import MarkdownIt from "markdown-it";
  import { boundedText } from "../format";

  let { text, class: klass = "" }: { text: string; class?: string } = $props();

  const md = new MarkdownIt({
    html: false, // never trust agent output with raw HTML
    linkify: true,
    breaks: true,
  });

  // External links open in a new tab, and the rel is set here.
  const defaultLinkOpen =
    md.renderer.rules.link_open ??
    ((tokens, idx, opts, _env, self) => self.renderToken(tokens, idx, opts));
  md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
    tokens[idx]!.attrSet("target", "_blank");
    tokens[idx]!.attrSet("rel", "noopener noreferrer");
    return defaultLinkOpen(tokens, idx, opts, env, self);
  };

  const html = $derived(md.render(boundedText(text, 400, 20_000)));
</script>

<div class="prose-mini {klass}">{@html html}</div>

<style>
  .prose-mini :global(p) {
    margin: 0 0 0.5rem;
  }
  .prose-mini :global(p:last-child) {
    margin-bottom: 0;
  }
  .prose-mini :global(ul),
  .prose-mini :global(ol) {
    margin: 0.25rem 0 0.5rem;
    padding-left: 1.1rem;
  }
  .prose-mini :global(ul) {
    list-style: disc;
  }
  .prose-mini :global(ol) {
    list-style: decimal;
  }
  .prose-mini :global(li) {
    margin: 0.125rem 0;
  }
  .prose-mini :global(a) {
    color: var(--color-brand);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .prose-mini :global(strong) {
    font-weight: 600;
    color: var(--color-ink);
  }
  .prose-mini :global(code) {
    font-family: var(--font-mono);
    font-size: 0.85em;
    background: var(--color-raised);
    /* Inner radius nests inside the block it sits in. */
    border-radius: var(--radius-xs);
    padding: 0.1rem 0.3rem;
  }
  .prose-mini :global(pre) {
    background: var(--color-canvas);
    border: 1px solid var(--color-line);
    border-radius: var(--radius-md);
    padding: 0.6rem 0.75rem;
    overflow-x: auto;
    margin: 0.4rem 0 0.6rem;
  }
  .prose-mini :global(pre code) {
    background: none;
    padding: 0;
    font-size: 0.9em; /* follows the reading size (--text-scale) */
    line-height: 1.5;
  }
  .prose-mini :global(blockquote) {
    border-left: 2px solid var(--color-line-strong);
    padding-left: 0.7rem;
    color: var(--color-ink-muted);
    margin: 0.3rem 0;
  }
  .prose-mini :global(h1),
  .prose-mini :global(h2),
  .prose-mini :global(h3) {
    font-weight: 600;
    margin: 0.6rem 0 0.3rem;
    color: var(--color-ink);
  }
  .prose-mini :global(h1) {
    font-size: 1.05rem;
  }
  .prose-mini :global(h2) {
    font-size: 1rem;
  }
  .prose-mini :global(h3) {
    font-size: 0.9rem;
  }
  .prose-mini :global(table) {
    border-collapse: collapse;
    font-size: 0.85em;
    margin: 0.3rem 0;
  }
  .prose-mini :global(th),
  .prose-mini :global(td) {
    border: 1px solid var(--color-line);
    padding: 0.2rem 0.45rem;
  }
</style>
