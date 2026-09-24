import { SyntaxStyle } from "@opentui/core";

/** Color roles used across the UI (shadcn-like semantics, per theme). */
export interface ThemeColors {
  bg: string;
  panel: string;
  border: string;
  borderActive: string;
  text: string;
  accent: string;
  dim: string;
  faint: string;
  ok: string;
  err: string;
  warn: string;
}

export interface ThemeDef {
  id: string;
  name: string;
  description: string;
  colors: ThemeColors;
}

/** Six themes: the shadcn default plus five community favorites. */
export const THEMES: ThemeDef[] = [
  {
    id: "shadcn",
    name: "shadcn",
    description: "zinc neutrals (default)",
    colors: {
      bg: "#09090b",
      panel: "#101013",
      border: "#27272a",
      borderActive: "#52525b",
      text: "#fafafa",
      accent: "#d4d4d8",
      dim: "#71717a",
      faint: "#52525b",
      ok: "#22c55e",
      err: "#ef4444",
      warn: "#eab308",
    },
  },
  {
    id: "nord",
    name: "nord",
    description: "arctic, cool blues",
    colors: {
      bg: "#2e3440",
      panel: "#3b4252",
      border: "#4c566a",
      borderActive: "#81a1c1",
      text: "#eceff4",
      accent: "#88c0d0",
      dim: "#7b88a1",
      faint: "#616e88",
      ok: "#a3be8c",
      err: "#bf616a",
      warn: "#ebcb8b",
    },
  },
  {
    id: "dracula",
    name: "dracula",
    description: "purple nights",
    colors: {
      bg: "#282a36",
      panel: "#21222c",
      border: "#44475a",
      borderActive: "#bd93f9",
      text: "#f8f8f2",
      accent: "#bd93f9",
      dim: "#6272a4",
      faint: "#565869",
      ok: "#50fa7b",
      err: "#ff5555",
      warn: "#f1fa8c",
    },
  },
  {
    id: "gruvbox",
    name: "gruvbox",
    description: "warm retro",
    colors: {
      bg: "#282828",
      panel: "#32302f",
      border: "#504945",
      borderActive: "#83a598",
      text: "#ebdbb2",
      accent: "#8ec07c",
      dim: "#928374",
      faint: "#7c6f64",
      ok: "#b8bb26",
      err: "#fb4934",
      warn: "#fabd2f",
    },
  },
  {
    id: "tokyo-night",
    name: "tokyo night",
    description: "deep blue city",
    colors: {
      bg: "#1a1b26",
      panel: "#1f2335",
      border: "#29304d",
      borderActive: "#7aa2f7",
      text: "#c0caf5",
      accent: "#7aa2f7",
      dim: "#565f89",
      faint: "#414868",
      ok: "#9ece6a",
      err: "#f7768e",
      warn: "#e0af68",
    },
  },
  {
    id: "catppuccin",
    name: "catppuccin",
    description: "mocha pastels",
    colors: {
      bg: "#1e1e2e",
      panel: "#181825",
      border: "#313244",
      borderActive: "#89b4fa",
      text: "#cdd6f4",
      accent: "#89b4fa",
      dim: "#6c7086",
      faint: "#585b70",
      ok: "#a6e3a1",
      err: "#f38ba8",
      warn: "#f9e2af",
    },
  },
];

export const DEFAULT_THEME = "shadcn";

/** Live palette — components read these properties at render time. */
export const colors: ThemeColors = { ...THEMES[0].colors };

/** Color of `$skill` references (the shadcn accent is a neutral, so skills get a violet). */
export function skillColor(): string {
  return colors.accent === "#d4d4d8" ? "#a78bfa" : colors.accent;
}

/** Live syntax styles, rebuilt when the theme changes. */
export let bashSyntaxStyle = buildBashStyle();
export let markdownSyntaxStyle = buildMarkdownStyle();
export let promptSyntaxStyle = buildPromptStyle();

export function themeById(id: string): ThemeDef {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0];
}

/** Switch the palette (and syntax styles) in place; components re-render with it. */
export function applyTheme(id: string): void {
  Object.assign(colors, themeById(id).colors);
  bashSyntaxStyle = buildBashStyle();
  markdownSyntaxStyle = buildMarkdownStyle();
  promptSyntaxStyle = buildPromptStyle();
}

function buildPromptStyle(): SyntaxStyle {
  return SyntaxStyle.fromStyles({ default: { fg: colors.text }, skill: { fg: skillColor(), bold: true } });
}

function buildBashStyle(): SyntaxStyle {
  return SyntaxStyle.fromStyles({
    default: { fg: colors.accent },
    comment: { fg: colors.faint, italic: true },
    string: { fg: colors.dim },
    number: { fg: colors.accent },
    constant: { fg: colors.accent },
    keyword: { fg: colors.text },
    "keyword.function": { fg: colors.text },
    function: { fg: colors.text },
    operator: { fg: colors.dim },
    variable: { fg: colors.accent },
    punctuation: { fg: colors.faint },
  });
}

function buildMarkdownStyle(): SyntaxStyle {
  return SyntaxStyle.fromStyles({
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
}
