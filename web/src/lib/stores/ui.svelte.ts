/** Small UI preferences, persisted to localStorage. */

const THEME_KEY = "minitui.theme";
const DENSITY_KEY = "minitui.density";

class UiStore {
  /** "dark" | "light" — the six palettes ride on top of this. */
  theme = $state<"dark" | "light">(
    (() => {
      try {
        return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
      } catch {
        return "dark";
      }
    })(),
  );

  /** The TUI's theme id (shadcn, nord, dracula, gruvbox, tokyo, catppuccin). */
  palette = $state<string>(
    (() => {
      try {
        return localStorage.getItem("minitui.palette") ?? "shadcn";
      } catch {
        return "shadcn";
      }
    })(),
  );

  density = $state<"comfortable" | "compact">(
    (() => {
      try {
        return localStorage.getItem(DENSITY_KEY) === "compact" ? "compact" : "comfortable";
      } catch {
        return "comfortable";
      }
    })(),
  );

  constructor() {
    this.apply();
  }

  apply() {
    const root = document.documentElement;
    root.classList.toggle("light", this.theme === "light");
    root.classList.toggle("dark", this.theme === "dark");
    root.dataset.theme = this.palette;
    root.dataset.density = this.density;
    try {
      localStorage.setItem(THEME_KEY, this.theme);
      localStorage.setItem("minitui.palette", this.palette);
      localStorage.setItem(DENSITY_KEY, this.density);
    } catch {
      /* private mode */
    }
  }

  /**
   * Flip light/dark. A theme switch repaints every colour, background,
   * border and shadow at once: without this the page smears through a
   * crossfade instead of snapping.
   */
  toggleTheme() {
    const root = document.documentElement;
    const style = document.createElement("style");
    style.textContent = "*,*::before,*::after{transition:none !important}";
    root.appendChild(style);
    // Force a reflow so the suppressed styles take effect for one frame.
    void root.offsetHeight;
    this.theme = this.theme === "dark" ? "light" : "dark";
    this.apply();
    requestAnimationFrame(() => {
      root.removeChild(style);
      void root.offsetHeight;
    });
  }

  setPalette(id: string) {
    this.palette = id;
    this.apply();
  }

  setDensity(value: "comfortable" | "compact") {
    this.density = value;
    this.apply();
  }
}

export const ui = new UiStore();

export const PALETTES = [
  { id: "shadcn", name: "shadcn", swatch: "oklch(0.72 0.13 231)" },
  { id: "nord", name: "nord", swatch: "oklch(0.72 0.12 233)" },
  { id: "dracula", name: "dracula", swatch: "oklch(0.72 0.14 328)" },
  { id: "gruvbox", name: "gruvbox", swatch: "oklch(0.76 0.13 78)" },
  { id: "tokyo", name: "tokyo night", swatch: "oklch(0.72 0.13 258)" },
  { id: "catppuccin", name: "catppuccin", swatch: "oklch(0.72 0.12 265)" },
];
