/** Slash commands, skills, settings and providers: loaded once on demand, shared by every panel. */
import { api } from "../api";
import type { CommandInfo, ProviderCatalogEntry, ProviderView, SettingsView, SkillInfo } from "../types";

type Status = "idle" | "loading" | "ready" | "error";

class Catalog {
  commands = $state<CommandInfo[]>([]);
  skills = $state<SkillInfo[]>([]);
  skillsStatus = $state<Status>("idle");

  settings = $state<SettingsView | null>(null);
  connected = $state<ProviderView[]>([]);
  catalog = $state<ProviderCatalogEntry[]>([]);
  providersStatus = $state<Status>("idle");
  error = $state("");

  /** Commands and skills are small and drive the prompt bar, so fetch them up front. */
  async warm() {
    await Promise.allSettled([this.loadCommands(), this.loadSkills(), this.loadSettings()]);
  }

  async loadCommands() {
    if (this.commands.length) return;
    try {
      this.commands = await api.commands();
    } catch {
      /* the prompt bar simply offers no commands until the server answers */
    }
  }

  /** When the skill list was last fetched (ms since epoch; 0 = never). */
  #skillsAt = 0;

  async loadSkills(force = false) {
    if (this.skillsStatus === "loading" || (this.skillsStatus === "ready" && !force)) return;
    // Keep showing the list we have while a refresh is in flight (no skeleton flash).
    if (!this.skills.length) this.skillsStatus = "loading";
    this.#skillsAt = Date.now();
    try {
      this.skills = await api.skills();
      this.skillsStatus = "ready";
    } catch {
      if (!this.skills.length) this.skillsStatus = "error";
    }
  }

  /**
   * Skills are folders on disk (`~/.config/mini-tui/skills`) that can be added while the page is
   * open, so a list fetched at boot goes stale. Re-fetch when it is older than `maxAgeMs`: called
   * when a `$` is typed and when the tab becomes visible again.
   */
  refreshSkills(maxAgeMs = 3000) {
    if (Date.now() - this.#skillsAt < maxAgeMs) return;
    void this.loadSkills(true);
  }

  async loadSettings() {
    try {
      this.settings = await api.settings();
    } catch (error) {
      this.error = (error as Error).message;
    }
  }

  async saveSettings(patch: Record<string, unknown>) {
    const before = this.settings;
    // Optimistic: the control moves at once, and snaps back if the server refuses.
    if (before) this.settings = { ...before, ...patch } as SettingsView;
    try {
      this.settings = await api.patchSettings(patch);
    } catch (error) {
      this.settings = before;
      throw error;
    }
  }

  async loadProviders(force = false) {
    if (this.providersStatus === "loading" || (this.providersStatus === "ready" && !force)) return;
    this.providersStatus = "loading";
    try {
      const { connected, catalog } = await api.providers();
      this.connected = connected;
      this.catalog = catalog;
      this.providersStatus = "ready";
    } catch (error) {
      this.error = (error as Error).message;
      this.providersStatus = "error";
    }
  }
}

export const catalog = new Catalog();
