/**
 * Per-session prompt memory for the prompt bar: ↑ walks back through what was sent in this
 * session, ↓ walks forward and finally restores the draft that was being written.
 */
export class PromptHistory {
  private entries: string[] = [];
  /** Position while browsing (`entries.length` = not browsing, i.e. the draft). */
  private cursor = 0;
  private draft = "";

  /** Replace the memory (new session → `[]`, resumed session → its prompts). */
  reset(entries: string[] = []): void {
    this.entries = [];
    for (const entry of entries) this.push(entry);
    this.cursor = this.entries.length;
    this.draft = "";
  }

  /** Remember a sent prompt (blank and repeated-in-a-row prompts are skipped). */
  push(text: string): void {
    const entry = text.trim();
    if (entry && this.entries[this.entries.length - 1] !== entry) this.entries.push(entry);
    this.cursor = this.entries.length;
    this.draft = "";
  }

  /** Older prompt, or null at the oldest one. `current` is saved as the draft on the first step. */
  prev(current: string): string | null {
    if (this.cursor === 0) return null;
    if (this.cursor === this.entries.length) this.draft = current;
    this.cursor -= 1;
    return this.entries[this.cursor] ?? null;
  }

  /** Newer prompt, the saved draft past the newest one, or null when not browsing. */
  next(): string | null {
    if (this.cursor >= this.entries.length) return null;
    this.cursor += 1;
    return this.cursor === this.entries.length ? this.draft : (this.entries[this.cursor] ?? null);
  }

  get size(): number {
    return this.entries.length;
  }
}
