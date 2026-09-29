/** Small UI preferences, persisted to localStorage. */
import { TEXT_SCALES, UI_SCALES, effectiveUiScale, snap } from "../scale";

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

  /** Whole-app zoom (`--ui-scale`) and reading-text size (`--text-scale`): see app.css and lib/scale.ts. */
  uiScale = $state<number>(
    (() => {
      try {
        return snap(localStorage.getItem("minitui.uiScale"), UI_SCALES);
      } catch {
        return 1;
      }
    })(),
  );
  textScale = $state<number>(
    (() => {
      try {
        return snap(localStorage.getItem("minitui.textScale"), TEXT_SCALES);
      } catch {
        return 1;
      }
    })(),
  );

  /** Touch input (a finger, not a mouse): the interface never zooms below 100% there. */
  coarse = $state(typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches);
  /** The interface size in effect (what `--ui-scale` holds), which can differ from `uiScale` on touch. */
  get appliedUiScale(): number {
    return effectiveUiScale(this.uiScale, this.coarse);
  }

  constructor() {
    this.apply();
    try {
      const mq = matchMedia("(pointer: coarse)");
      mq.addEventListener("change", () => {
        this.coarse = mq.matches;
        this.apply();
      });
    } catch {
      /* no matchMedia (tests): keep the initial value */
    }
  }

  apply() {
    const root = document.documentElement;
    root.classList.toggle("light", this.theme === "light");
    root.classList.toggle("dark", this.theme === "dark");
    root.dataset.theme = this.palette;
    root.dataset.density = this.density;
    root.style.setProperty("--ui-scale", String(this.appliedUiScale));
    root.style.setProperty("--text-scale", String(this.textScale));
    try {
      localStorage.setItem("minitui.uiScale", String(this.uiScale));
      localStorage.setItem("minitui.textScale", String(this.textScale));
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

  setUiScale(value: number) {
    this.uiScale = snap(value, UI_SCALES);
    this.apply();
  }

  setTextScale(value: number) {
    this.textScale = snap(value, TEXT_SCALES);
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
