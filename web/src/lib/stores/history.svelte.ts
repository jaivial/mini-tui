/**
 * The saved-session list behind "Resume". Loaded on demand (the panel opening), never at boot: it is only
 * needed there, and a slow database must not delay the first paint. A newer search always wins over an
 * older one still in flight, so typing fast never shows results for a stale query.
 */
import { api } from "../api";
import type { HistoryItem } from "../types";

export class HistoryStore {
  items = $state<HistoryItem[]>([]);
  status = $state<"idle" | "loading" | "ready" | "error">("idle");
  error = $state("");
  query = $state("");
  /** Set when the page came back full: there may be more than we show. */
  capped = $state(false);
  static readonly PAGE = 50;
  /** How many rows to ask for: grows by a page with "Show more" (the server caps it at 500). */
  limit = $state(HistoryStore.PAGE);

  #seq = 0;
  /** The request in flight (query + limit), so the same question is never asked twice at once. */
  #inflight = "";

  async load(query = this.query) {
    const key = `${query}\u0000${query === this.query ? this.limit : HistoryStore.PAGE}`;
    if (key === this.#inflight) return;
    this.#inflight = key;
    const mine = ++this.#seq;
    const previous = this.query;
    this.query = query;
    if (query !== previous) this.limit = HistoryStore.PAGE;
    this.status = "loading";
    this.error = "";
    try {
      const rows = await api.history(query, this.limit);
      if (mine !== this.#seq) return; // a newer search is running: this answer is stale
      this.items = rows;
      this.capped = rows.length >= this.limit && this.limit < 500;
      this.status = "ready";
    } catch (error) {
      if (mine !== this.#seq) return;
      this.error = (error as Error).message;
      this.status = "error";
    } finally {
      if (mine === this.#seq) this.#inflight = "";
    }
  }

  /** One more page of the same search. */
  async more() {
    this.limit = Math.min(500, this.limit + HistoryStore.PAGE);
    await this.load(this.query);
  }

  /** Re-read quietly: a session finished or was closed, so the list changed. No skeleton flash. */
  async refresh() {
    if (this.#inflight) return; // a load is already fetching the current list
    const mine = ++this.#seq;
    this.#inflight = `${this.query}\u0000${this.limit}`;
    try {
      const rows = await api.history(this.query, this.limit);
      if (mine !== this.#seq) return;
      this.items = rows;
      this.capped = rows.length >= this.limit && this.limit < 500;
      this.status = "ready";
    } catch {
      /* keep what is shown; the next refresh will try again */
    } finally {
      if (mine === this.#seq) this.#inflight = "";
    }
  }

  /** The row was opened, deleted or otherwise changed on the server: reflect it without a refetch. */
  markOpen(id: string, open: boolean) {
    this.items = this.items.map((i) => (i.id === id ? { ...i, open } : i));
  }
  remove(id: string) {
    this.items = this.items.filter((i) => i.id !== id);
  }
}

/** The Resume panel's list. */
export const history = new HistoryStore();
/** The sidebar's list: its own search and paging, so typing in one never changes the other. */
export const sidebarHistory = new HistoryStore();
