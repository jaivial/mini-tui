import { describe, expect, test } from "bun:test";

import { DEFAULT_THEME, THEMES, applyTheme, colors, themeById } from "../src/ui/theme";

describe("themes", () => {
  test("six themes: the shadcn default plus five alternatives", () => {
    expect(THEMES.map((t) => t.id)).toEqual([
      "shadcn",
      "nord",
      "dracula",
      "gruvbox",
      "tokyo-night",
      "catppuccin",
    ]);
    expect(DEFAULT_THEME).toBe("shadcn");
    // every theme defines the full palette
    for (const theme of THEMES) {
      expect(Object.keys(theme.colors).sort()).toEqual(Object.keys(THEMES[0].colors).sort());
    }
  });

  test("applyTheme switches the live palette and syntax styles", () => {
    try {
      applyTheme("shadcn");
      expect(colors.bg).toBe("#09090b");
      applyTheme("dracula");
      expect(colors.bg).toBe("#282a36");
      expect(colors.accent).toBe("#bd93f9");
      // unknown ids fall back to the default theme
      expect(themeById("nope").id).toBe(DEFAULT_THEME);
      applyTheme("nope");
      expect(colors.bg).toBe("#09090b");
    } finally {
      applyTheme(DEFAULT_THEME);
    }
  });
});
