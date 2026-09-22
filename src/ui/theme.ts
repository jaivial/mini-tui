import { SyntaxStyle } from "@opentui/core";

/**
 * shadcn-like palette: zinc neutrals, one quiet accent, semantic colors used sparingly.
 * https://ui.shadcn.com/docs/theming
 */
export const colors = {
  bg: "#09090b", // zinc-950
  panel: "#101013", // card surface (zinc-900-ish)
  border: "#27272a", // zinc-800
  borderActive: "#52525b", // zinc-600 (focus)
  text: "#fafafa", // zinc-50
  accent: "#d4d4d8", // zinc-300
  dim: "#71717a", // zinc-500
  faint: "#52525b", // zinc-600
  ok: "#22c55e",
  err: "#ef4444",
  warn: "#eab308",
} as const;

export const bashSyntaxStyle = SyntaxStyle.fromStyles({
  default: { fg: colors.accent },
  comment: { fg: colors.faint, italic: true },
  string: { fg: "#a1a1aa" },
  number: { fg: colors.accent },
  constant: { fg: colors.accent },
  keyword: { fg: colors.text },
  "keyword.function": { fg: colors.text },
  function: { fg: colors.text },
  operator: { fg: colors.dim },
  variable: { fg: colors.accent },
  punctuation: { fg: colors.faint },
});

export const markdownSyntaxStyle = SyntaxStyle.fromStyles({
  default: { fg: colors.text },
  "markup.heading": { fg: colors.text, bold: true },
  "markup.strong": { bold: true },
  "markup.emphasis": { italic: true },
  "markup.link": { fg: colors.accent, underline: true },
  "markup.url": { fg: colors.accent },
  "markup.raw": { fg: colors.accent },
  "markup.quote": { fg: colors.dim, italic: true },
  "markup.list": { fg: colors.dim },
});
