/**
 * Agent text as HTML.
 *
 * The markdown engine is ~150 KB, and a transcript needs it the moment its first message
 * arrives rather than at boot, so it is imported on first use instead of with the app. The
 * engine is created once and shared by every `Markdown` on the page: parsing the same text
 * twice would be the only thing more expensive than shipping it twice.
 *
 * `render` never throws: agent output is untrusted text, and a pane must be able to show a
 * broken message rather than lose the rest of the transcript.
 */
export interface MarkdownOptions {
  /** Turn link-looking text into links. */
  linkify?: boolean;
  /** One newline inside a paragraph breaks the line, as chat users expect. */
  breaks?: boolean;
}

type Engine = { render: (text: string) => string };

let engine: Promise<Engine> | null = null;

/** The shared engine, built the first time some text needs it. */
function load(options: MarkdownOptions): Promise<Engine> {
  engine ??= import("markdown-it").then(({ default: MarkdownIt }) => {
    const md = new MarkdownIt({
      html: false, // never trust agent output with raw HTML
      linkify: options.linkify ?? true,
      breaks: options.breaks ?? true,
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
    return md;
  });
  return engine;
}

export const markdown = {
  /** True once the engine has been asked for (a transcript is on screen). */
  get started(): boolean {
    return engine !== null;
  },
  /** HTML for `text`, loading the engine the first time. Resolves to plain text while it loads. */
  render(text: string, options: MarkdownOptions = {}): Promise<string> {
    return load(options).then((md) => md.render(text));
  },
};
