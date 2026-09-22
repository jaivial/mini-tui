/**
 * <markdown> blocks cost ~0.33 MB of native buffers each vs ~0.09 MB for plain <text>
 * (measured — see docs/PLAN-ram-reduction.md), so only pay for the markdown renderable when
 * the text actually has structure worth rendering.
 */

const MARKDOWN_SYNTAX =
  /```|~~~|`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|^#{1,6}\s|^\s*[-*+]\s|^\s*\d+\.\s|\[[^\]]+\]\([^)\s]+\)|^\s*>|<https?:\/\//m;

export function needsMarkdown(text: string): boolean {
  return MARKDOWN_SYNTAX.test(text);
}
