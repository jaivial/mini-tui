/**
 * The sidebar's rename field, as a state machine.
 *
 * Measured in Chrome 145 against the deployed build (`App-DEqEgCpr.js`), with the real
 * server answering `POST /api/sessions/<id>/title`. Four defects, all one cause: the field
 * was a pair of `$state` variables and two handlers, with no notion of "an edit in
 * progress" as a thing with its own rules.
 *
 *   1. THE FIELD NEVER TOOK FOCUS. The pencil called `startRename`, which set `editing`
 *      and `draft`; nothing focused the `<input>` that appeared. `document.activeElement`
 *      stayed on the pencil button, so a click-and-type did nothing (the keystrokes went to
 *      the button) and a keyboard user could not reach it at all: the input sits FIRST in
 *      the row and the pencil LAST, so Tab from the pencil left the row entirely and only
 *      Shift+Tab x2 came back. Measured: pencil -> Tab -> the NEXT row's button.
 *   2. FOCUS WAS LOST ON EXIT. Enter and Escape both dropped the focused input, and
 *      `document.activeElement` became `body` — the next Tab restarted at the top of the
 *      document. Every other overlay in this app returns focus (the drawer to its toggle,
 *      ResumeModal to its search, `<dialog>` to the opener). This was the outlier.
 *   3. BLUR WROTE AN UNCHANGED TITLE. `onblur={commitRename}` fired a POST even when the
 *      user had typed nothing: opening the field and clicking away wrote the title that was
 *      already there. Measured 2/2.
 *   4. A STALE DRAFT SILENTLY REVERTED SOMEONE ELSE'S RENAME. The draft was seeded once,
 *      at open, and never reconciled. The title can change underneath from several places
 *      that do not involve this field at all — the operator's `/rename` in WhatsApp, the
 *      other client, the AI title. Measured: the store held "TITULO DE WHATSAPP", the field
 *      still said "Refactor del parser"; typing one character and pressing Enter POSTed
 *      `"Refactor del parser!"` and undid the rename with no warning. The server already
 *      guards this exact race for the AI title (`aiTitle` bails when the title moved), so
 *      the hazard was known — just not on this path.
 *
 * The rules live here, not inline in the component, for the reason `transcriptGroup.ts`
 * gives: this is the logic the field's behaviour IS made of, it has to be testable on its
 * own, and the component should only have to call it and paint what it says.
 */

/** One row's worth of identity: which bot, and the title it currently carries. */
export interface RenameTarget {
  id: string;
  title: string;
}

export interface RenameFieldOptions {
  /** Called only when there is something genuinely new to write. */
  onSave: (id: string, title: string) => void;
}

export interface RenameField {
  /** The id being edited, or null when no edit is in progress. */
  readonly editing: string | null;
  /** What the field currently shows. */
  readonly draft: string;
  /** True once the draft differs from the title the edit started from. */
  readonly dirty: boolean;
  /**
   * The title that arrived underneath a dirty draft, or null when there is no conflict.
   * Rendered, not silent: the user is about to overwrite someone else's rename and has to
   * be able to see that before they do it.
   */
  readonly conflict: string | null;
  /** True once the user has been shown the conflict and pressed Enter again. */
  readonly acknowledged: boolean;
  open(target: RenameTarget): void;
  /** The user typed. */
  type(text: string): void;
  /** The row's title changed underneath the open field. */
  sync(title: string): void;
  /** Enter, or the focus leaving the field. */
  commit(): void;
  /** Escape. */
  cancel(): void;
}

export function createRenameField(options: RenameFieldOptions): RenameField {
  let id: string | null = null;
  /** The title this edit started from. */
  let base = "";
  let draft = "";
  let dirty = false;
  /** A title that arrived from elsewhere while the draft was dirty. */
  let incoming: string | null = null;
  /** The conflict has been shown and Enter pressed once: the user chose knowingly. */
  let acknowledged = false;

  const close = () => {
    id = null;
    base = "";
    draft = "";
    dirty = false;
    incoming = null;
    acknowledged = false;
  };

  return {
    get editing() {
      return id;
    },
    get draft() {
      return draft;
    },
    get dirty() {
      return dirty;
    },
    // The conflict outlives the acknowledgement: it is still true while the field is open,
    // and hiding it the moment Enter is pressed is what makes the second Enter surprising.
    get conflict() {
      return dirty ? incoming : null;
    },
    get acknowledged() {
      return acknowledged;
    },
    open(target) {
      id = target.id;
      base = target.title;
      draft = target.title;
      dirty = false;
      incoming = null;
      acknowledged = false;
    },
    type(text) {
      draft = text;
      dirty = text !== base;
      // Typing back to exactly the title the edit started from dissolves the conflict: the
      // user has, by hand, arrived at what the store already says.
      if (!dirty) {
        incoming = null;
        acknowledged = false;
      }
    },
    sync(title) {
      if (id === null) return;
      if (title === base) {
        // The store came back to where this edit started. Nothing is in conflict.
        incoming = null;
        acknowledged = false;
        return;
      }
      if (!dirty) {
        // Nothing typed yet: the field has no opinion of its own, so it follows.
        base = title;
        draft = title;
        incoming = null;
        acknowledged = false;
        return;
      }
      // There IS an opinion, and it was formed against a title that no longer exists.
      incoming = title;
    },
    commit() {
      if (id === null) return;
      const next = draft.trim();
      // An empty field keeps the old title (the documented contract of `onrenamebot`).
      if (!next || !dirty) {
        close();
        return;
      }
      if (incoming !== null && !acknowledged) {
        // First Enter after a conflict announces it instead of overwriting. The second one
        // is a deliberate act: the user has read the note and is choosing their own title.
        acknowledged = true;
        return;
      }
      const target = id;
      close();
      options.onSave(target, next);
    },
    cancel() {
      close();
    },
  };
}
