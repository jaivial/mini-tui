/**
 * The save machine of a note editor: what state the editor is in, what a flush sends, and which
 * version it names. Plain TypeScript — no DOM, no Svelte — because every rule here only goes wrong
 * *between* two saves, and because the tests used to hold a hand-written **model** of these rules.
 * That model is exactly what E50 is about ("the copies diverge in silence"): it had already drifted
 * from `NotesPanel.svelte` (it had no error state at all, and it reported "saved" while the user was
 * still typing) and nothing said so. There is one implementation now, and the tests drive it.
 *
 * `components/NotesPanel.svelte` is the only caller: it owns the textarea, the clipboard and the
 * words on screen, and hands every decision here. A source-reading test rejects a second copy.
 *
 * The rule the verdicts follow: **the panel may never claim something it cannot make true.** A save
 * whose answer never came is not "not saved" (the write may have landed — E50 measured it landing),
 * and a value that arrives with the editor's own text is not a conflict ("changed somewhere else"
 * is a claim about another writer; here the only other writer was this editor, late).
 */
import { SAVE_DELAY, type SaveState } from "./notes";
import type { NoteSave } from "./notesClient";
import type { Note } from "./types";

/** What `NotesClient.save` does; injected so the machine can be driven without a socket. */
export type SaveFn = (id: string, body: string, base: number) => Promise<NoteSave>;

/** The transport the editor saves through (`NotesClient` is one). */
export type SaveClient = { save: SaveFn };

/** What a late answer says: the write landed, or it was refused in favour of another one. */
export type LateOutcome = "saved" | "conflict";

export class NoteEditor {
  /** The note on screen, or null for a pane with nowhere to keep notes. */
  noteId: string | null = null;
  /** What the editor holds (what the textarea shows). */
  body = "";
  /** What the server holds, as far as this editor knows. Nothing to save while `body` equals it. */
  savedBody = "";
  /** The version of the note this editor is based on. */
  base = 0;
  save: SaveState = { kind: "loading" };

  /**
   * The version each note of this pane is at, as the server last confirmed it. A save names the
   * version it starts from; this is what a save made while another is in flight must start from, or
   * the server refuses it as a conflict and the text it carried is lost. One book only — a second
   * one that is never reconciled locked a cleared note out of saving for ever (E50, review R1).
   */
  #landed = new Map<string, number>();
  #inFlight: Promise<void> | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #client: SaveClient;
  #emit: () => void;

  /**
   * `client` is the transport (`NotesClient`); `emit` is called after every change the screen must
   * see (the panel copies `body` and `save` out of here into its reactive state). `now` is the
   * app's clock — server time (`lib/clock.ts`); the one fallback timestamp below must live in the
   * same clock as the server's `updatedAt` values it stands in for (E53).
   */
  constructor(client: SaveClient, emit: () => void = () => {}, private now: () => number = () => Date.now()) {
    this.#client = client;
    this.#emit = emit;
  }

  /** How many notes this editor holds a version for. */
  tracked(): number {
    return this.#landed.size;
  }

  /**
   * The pane now shows this note (a Svelte effect re-run). Everything the previous note left behind
   * is dropped but its pending flush, which the caller starts first (`leave`) — an effect's cleanup
   * runs before its next body, and the leaving flush must still read the version book.
   */
  enter(id: string | null): void {
    this.noteId = id;
    if (!id) {
      this.save = { kind: "saved", at: 0 };
      this.#emit();
      return;
    }
    this.save = { kind: "loading" };
    this.body = this.savedBody = "";
    this.base = 0;
    this.#landed.clear();
    this.#emit();
  }

  /** The pane moved away from `id`: flush what is pending against that note's own values. */
  leave(id: string): Promise<void> {
    return this.flush(id, true);
  }

  /** Every keystroke: the text, and a save 600 ms later if it keeps coming. */
  type(text: string): void {
    this.body = text;
    if (this.save.kind === "conflict" || this.save.kind === "loading") return;
    this.save = this.body === this.savedBody ? { kind: "saved", at: this.base } : { kind: "dirty" };
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      if (this.noteId) void this.flush(this.noteId);
    }, SAVE_DELAY);
    this.#emit();
  }

  /**
   * The watch delivered the note's value: now, and again whenever it changes anywhere. Returns what
   * the caller may want to do with the caret: `"took"` means the editor took the other value as its
   * own (nothing typed here to lose), which is the only case where the text moves under the caret.
   */
  applyRemote(id: string, note: Note): "loading" | "same" | "took" | "conflict" {
    if (id !== this.noteId) return "same";
    if (this.save.kind === "loading") {
      this.body = this.savedBody = note.body;
      this.base = note.updatedAt;
      this.#landed.set(id, note.updatedAt);
      this.save = { kind: "saved", at: note.updatedAt };
      this.#emit();
      return "loading";
    }
    if (note.updatedAt === this.base) return "same"; // the version we already have
    if (note.body === this.body) {
      // The value that arrived is the editor's OWN text: a reconnect catch-up after the answer was
      // lost with the socket, or a device that saved exactly this. There is nothing to choose
      // between, so "changed somewhere else" would name a writer that does not exist (measured on
      // the deployed build: the banner asked the reader to pick between two identical texts).
      this.#absorb(id, note);
      return "same";
    }
    if (this.body === this.savedBody && this.save.kind !== "saving") {
      // Nothing typed here since the last save: take theirs at once, keeping the caret where it was.
      this.#absorb(id, note);
      return "took";
    }
    // You are typing: never overwrite what you wrote. Say so now, and let you choose.
    this.save = { kind: "conflict", theirs: note.body, theirsAt: note.updatedAt };
    this.#emit();
    return "conflict";
  }

  /**
   * A save this editor had given up on (its deadline fired after it went out) turns out to have
   * landed — or to have been refused. The write moved the note on server-side either way, so the
   * version book is told; and the verdict the panel already showed is corrected with what is now
   * known, so "Not saved" cannot outlive a save that is in the database.
   */
  applyLate(note: Note, outcome: LateOutcome): void {
    this.#landed.set(note.id, note.updatedAt); // always: the next save must name this version
    if (note.id !== this.noteId) return;
    if (this.save.kind === "conflict") return; // the reader is choosing; the book is all we can say
    if (this.save.kind === "saving") return; // a save of ours is in flight and will report itself
    if (note.body === this.body) {
      this.#absorb(note.id, note);
      return;
    }
    if (outcome === "saved") {
      // It landed, but the editor has moved on since: what is on screen is still unsaved.
      this.savedBody = note.body;
      this.base = note.updatedAt;
      this.save = { kind: "dirty" };
      clearTimeout(this.#timer);
      this.#timer = setTimeout(() => {
        if (this.noteId) void this.flush(this.noteId);
      }, SAVE_DELAY);
      this.#emit();
      return;
    }
    // Refused in favour of another version the editor does not hold: that IS a conflict.
    this.save = { kind: "conflict", theirs: note.body, theirsAt: note.updatedAt };
    this.#emit();
  }

  /** Conflict: keep mine (overwrite theirs, deliberately). */
  async keepMine(): Promise<void> {
    if (this.save.kind !== "conflict" || !this.noteId) return;
    const id = this.noteId;
    this.base = this.save.theirsAt;
    this.savedBody = this.save.theirs;
    // Theirs is now the version this note is at: the overwrite below must start from it, or it is
    // refused as a conflict again and the text is never saved.
    this.#landed.set(id, this.save.theirsAt);
    this.save = { kind: "dirty" };
    this.#emit();
    await this.flush(id);
  }

  /** Conflict: take theirs (what was typed here is the caller's to copy first). */
  takeTheirs(): void {
    if (this.save.kind !== "conflict" || !this.noteId) return;
    this.body = this.savedBody = this.save.theirs;
    this.base = this.save.theirsAt;
    this.#landed.set(this.noteId, this.save.theirsAt);
    this.save = { kind: "saved", at: this.save.theirsAt };
    this.#emit();
  }

  /**
   * Save now, one save at a time.
   *
   * What to save is captured before the first `await`: when the pane switches notes, `leave` calls
   * this and the next `enter` resets the editor straight after, so reading it later would save the
   * wrong note's text (or nothing). A save for a note that is no longer on screen uses the values
   * captured here; one for the current note re-reads them after waiting its turn, so a save that was
   * in flight has already moved the version on.
   *
   * The version it names is the one the *last* save of this note established (`#landed`), never the
   * one captured above: typing while a save is in flight leaves the snapshot a version behind, and a
   * save sent from it is refused as a conflict, silently dropping the text it carried. `leaving`
   * says the pane has already moved on, so `body` no longer belongs to this note and only the
   * snapshot can be sent.
   */
  async flush(id: string, leaving = false): Promise<void> {
    clearTimeout(this.#timer);
    const snap = { text: this.body, saved: this.savedBody, base: this.base, kind: this.save.kind };
    const wanted = snap.text;
    if (this.#inFlight) await this.#inFlight;
    const current = id === this.noteId && !leaving;
    const text = current ? this.body : snap.text;
    const saved = current ? this.savedBody : snap.saved;
    const kind = current ? this.save.kind : snap.kind;
    // An older save of this same note moved the version on while we waited: start from where it
    // landed — including a save whose answer arrived after the deadline gave up on it, which
    // `applyLate` writes into this same book.
    const from = this.#landed.get(id) ?? snap.base;
    if (text === saved || kind === "conflict" || kind === "loading") return;
    if (current) {
      this.save = { kind: "saving" };
      this.#emit();
    }
    const run = (async () => {
      try {
        const result = await this.#client.save(id, text, from);
        if (result.ok) this.#landed.set(id, result.note.updatedAt);
        if (id !== this.noteId) return; // switched away while it was saving: it landed, nothing to show
        if (result.ok) {
          this.base = result.note.updatedAt;
          this.savedBody = text;
          this.save = this.body === text ? { kind: "saved", at: result.note.updatedAt || this.now() } : { kind: "dirty" };
          this.#emit();
          if (this.body !== text) this.#schedule(id, SAVE_DELAY); // typed during the save
        } else if (result.conflict.body === text) {
          // Refused — but the server holds exactly what this save was carrying. Nothing was lost
          // and there is nothing to choose: a "conflict" here would name this editor as the other
          // writer (it is what a late answer of our own save looks like from the outside).
          this.#absorb(id, result.conflict);
        } else {
          this.save = { kind: "conflict", theirs: result.conflict.body, theirsAt: result.conflict.updatedAt };
          this.#emit();
        }
      } catch (error) {
        if (id !== this.noteId || leaving) return;
        if (text === this.savedBody) {
          // The save could not answer, but the server is known to hold exactly what it carried (a
          // catch-up or a late answer said so): "not saved" would be a claim the database refutes.
          this.save = { kind: "saved", at: this.base };
          this.#emit();
        } else if (text !== this.body) {
          // Typed since the save went out: what is on screen is still unsaved — say that, and go again.
          this.save = { kind: "dirty" };
          this.#emit();
          this.#schedule(id, SAVE_DELAY);
        } else {
          // Unsaved, and nothing has said the write landed: say exactly what happened (the message
          // says whether it still can) and let the reader retry.
          this.save = { kind: "error", message: (error as Error).message };
          this.#emit();
        }
      }
    })();
    this.#inFlight = run;
    await run;
    if (this.#inFlight === run) this.#inFlight = null;
    // Still showing this note, and it moved on while this flush waited its turn: save it again.
    if (current && !leaving && id === this.noteId && this.body !== wanted && this.body !== this.savedBody) this.#schedule(id, 0);
  }

  /** The server now holds `note`, and the editor has no reason to disagree: take it as ours. */
  #absorb(id: string, note: Note): void {
    this.body = this.savedBody = note.body;
    this.base = note.updatedAt;
    this.#landed.set(id, note.updatedAt);
    this.save = { kind: "saved", at: note.updatedAt };
    this.#emit();
  }

  #schedule(id: string, ms: number): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.flush(id), ms);
  }
}
