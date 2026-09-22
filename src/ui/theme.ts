import { SyntaxStyle } from "@opentui/core";

/** Dark palette (GitHub-dark-ish) shared by every component. */
export const colors = {
  bg: "#0d1117",
  panel: "#161b22",
  border: "#30363d",
  borderActive: "#58a6ff",
  text: "#e6edf3",
  dim: "#8b949e",
  accent: "#58a6ff",
  cmd: "#a5d6ff",
  ok: "#3fb950",
  err: "#f85149",
  warn: "#d29922",
} as const;

export const bashSyntaxStyle = SyntaxStyle.fromStyles({
  default: { fg: colors.text },
  comment: { fg: colors.dim, italic: true },
  string: { fg: "#a5d6ff" },
  number: { fg: "#f0883e" },
  constant: { fg: "#f0883e" },
  keyword: { fg: "#ff7b72" },
  "keyword.function": { fg: "#d2a8ff" },
  "function": { fg: "#d2a8ff" },
  operator: { fg: colors.text },
  variable: { fg: "#ffa657" },
  punctuation: { fg: colors.dim },
});

export const markdownSyntaxStyle = SyntaxStyle.fromStyles({
  default: { fg: colors.text },
  "markup.heading": { fg: colors.accent, bold: true },
  "markup.strong": { bold: true },
  "markup.emphasis": { italic: true },
  "markup.link": { fg: colors.accent, underline: true },
  "markup.url": { fg: colors.accent },
  "markup.raw": { fg: colors.cmd },
  "markup.quote": { fg: colors.dim, italic: true },
  "markup.list": { fg: colors.dim },
});
