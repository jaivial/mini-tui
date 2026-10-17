/**
 * E20: the sidebar's rename field.
 *
 * Measured in Chrome 145 against the deployed build (`App-DEqEgCpr.js`), with the real
 * server answering `POST /api/sessions/<id>/title` and the real metadata stream pushing
 * title changes. Four defects, one cause — the field was two `$state` variables and two
 * handlers, with no notion of an edit in progress as a thing with rules:
 *
 *   1. It never took focus. The pencil set `editing`/`draft` and nothing focused the
 *      `<input>` that appeared, so click-and-type did nothing (`document.activeElement`
 *      stayed on the pencil) and Tab from the pencil LEFT the row entirely: the input is
 *      first in the row and the pencil last, so only Shift+Tab x2 came back.
 *   2. Focus was lost on exit: after Enter and after Escape, `activeElement` was `body`.
 *   3. Blur wrote an unchanged title — open the field, click away, and a POST went out with
 *      the title that was already stored. Measured 2/2.
 *   4. A stale draft silently reverted someone else's rename. The store held
 *      "TITULO DE WHATSAPP", the field still said "Refactor del parser"; typing one
 *      character and pressing Enter POSTed `"Refactor del parser!"` and undid the rename
 *      with no warning.
 *
 * The rules are tested on their own because the component only calls them; the focus
 * behaviour (1 and 2) is DOM state with no logic to pin here, and its proof is the live
 * browser measurement against the deployed build.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRenameField, type RenameFieldOptions } from "../web/src/lib/renameField";

/** A field wired to a recorder, so a test can read exactly what would have been written. */
function harness() {
  const saved: Array<[string, string]> = [];
  const opts: RenameFieldOptions = { onSave: (id, title) => saved.push([id, title]) };
  return { field: createRenameField(opts), saved };
}

describe("the rename field writes only a title that really changed", () => {
  test("a field opened and left alone writes nothing", () => {
    // Defect 3, measured 2/2 on the deployed build: blurring an untouched field POSTed the
    // title that was already stored.
    const { field, saved } = harness();
    field.open({ id: "bot-alfa", title: "Refactor del parser" });
    field.commit();
    expect(saved).toEqual([]);
    expect(field.editing).toBe(null);
  });

  test("typing nothing and confirming keeps the old title", () => {
    const { field, saved } = harness();
    field.open({ id: "bot-alfa", title: "Refactor del parser" });
    field.type("Refactor del parser"); // same text, not a dirty draft
    field.commit();
    expect(saved).toEqual([]);
  });

  test("a real change is written, trimmed", () => {
    const { field, saved } = harness();
    field.open({ id: "bot-alfa", title: "Refactor del parser" });
    field.type("  Auditoria del parser  ");
    field.commit();
    expect(saved).toEqual([["bot-alfa", "Auditoria del parser"]]);
    expect(field.editing).toBe(null);
  });

  test("an emptied field keeps the old title and closes", () => {
    // The documented contract of `onrenamebot`: an empty title is not a rename to nothing.
    const { field, saved } = harness();
    field.open({ id: "bot-alfa", title: "Refactor del parser" });
    field.type("   ");
    field.commit();
    expect(saved).toEqual([]);
    expect(field.editing).toBe(null);
  });

  test("Escape writes nothing at all", () => {
    const { field, saved } = harness();
    field.open({ id: "bot-alfa", title: "Refactor del parser" });
    field.type("Otro nombre");
    field.cancel();
    expect(saved).toEqual([]);
    expect(field.editing).toBe(null);
    expect(field.draft).toBe("");
  });
});

describe("a title that moves underneath the field is not silently reverted", () => {
  // Defect 4. The stream carries renames from the WhatsApp `/rename`, the other client and
  // the AI title, none of which pass through this field.
  test("an untouched field follows the row", () => {
    const { field, saved } = harness();
    field.open({ id: "bot-alfa", title: "Refactor del parser" });
    field.sync("TITULO DE WHATSAPP");
    expect(field.draft).toBe("TITULO DE WHATSAPP");
    expect(field.conflict).toBe(null);
    field.commit();
    expect(saved).toEqual([]); // following is not writing
  });

  test("a dirty draft announces the conflict instead of overwriting it", () => {
    const { field, saved } = harness();
    field.open({ id: "bot-alfa", title: "Refactor del parser" });
    field.type("Refactor del parser!");
    field.sync("TITULO DE WHATSAPP");
    expect(field.conflict).toBe("TITULO DE WHATSAPP");
    // The first Enter is the warning, not the write: this is the whole point.
    field.commit();
    expect(saved).toEqual([]);
    expect(field.editing).toBe("bot-alfa"); // still open, so the note stays readable
  });

  test("the second Enter is a deliberate overwrite", () => {
    const { field, saved } = harness();
    field.open({ id: "bot-alfa", title: "Refactor del parser" });
    field.type("Refactor del parser!");
    field.sync("TITULO DE WHATSAPP");
    field.commit(); // announces
    field.commit(); // the user read it and chose
    expect(saved).toEqual([["bot-alfa", "Refactor del parser!"]]);
    expect(field.editing).toBe(null);
  });

  test("typing back to the original title dissolves the conflict", () => {
    const { field, saved } = harness();
    field.open({ id: "bot-alfa", title: "Refactor del parser" });
    field.type("Otra cosa");
    field.sync("TITULO DE WHATSAPP");
    expect(field.conflict).toBe("TITULO DE WHATSAPP");
    field.type("Refactor del parser"); // back by hand to what the store says
    expect(field.conflict).toBe(null);
    field.commit();
    expect(saved).toEqual([]);
  });

  test("the store returning to the edit's own base is not a conflict", () => {
    const { field, saved } = harness();
    field.open({ id: "bot-alfa", title: "Refactor del parser" });
    field.type("Refactor del parser!");
    field.sync("Refactor del parser"); // same title the edit started from
    expect(field.conflict).toBe(null);
    field.commit();
    expect(saved).toEqual([["bot-alfa", "Refactor del parser!"]]);
  });

  test("sync outside an edit is inert", () => {
    const { field } = harness();
    field.sync("lo que sea");
    expect(field.editing).toBe(null);
    expect(field.draft).toBe("");
  });
});

describe("the component wires the rules and gives the field its focus back", () => {
  const SRC = readFileSync(join(import.meta.dir, "..", "web/src/lib/components/SessionSidebar.svelte"), "utf8");

  test("the field is focused and selected when it opens", () => {
    // Defect 1: nothing focused it, so click-and-type did nothing.
    expect(SRC).toContain("renameEl?.focus()");
    expect(SRC).toContain("renameEl?.select()");
    // and it waits for the element to exist first
    expect(SRC).toMatch(/await tick\(\);[\s\S]{0,320}renameEl\?\.focus\(\)/);
  });

  test("closing hands the focus back to the row it came from", () => {
    // Defect 2: `activeElement` was `body` after both Enter and Escape.
    expect(SRC).toContain("data-bot={session.id}");
    expect(SRC).toMatch(/renameRow[\s\S]{0,400}\[data-nav\]\"\)\?\.focus\(\)/);
  });

  test("Escape cannot fall through to the blur commit", () => {
    // It writes nothing, so it must not be followed by a commit that might.
    const esc = SRC.slice(SRC.indexOf('e.key === "Escape"'));
    expect(esc.slice(0, 260)).toContain("endRename");
    expect(esc.slice(0, 260)).not.toContain("commitRename");
  });

  test("the blur commit is guarded on the edit still being open", () => {
    // `endRename` moves the focus itself, which fires `onblur` after the edit closed.
    expect(SRC).toMatch(/onblur=\{\(\) => \{[\s\S]{0,200}if \(rename\.editing\)/);
  });

  test("the field is named for the bot it renames, not 'Bot title'", () => {
    // Every row's field was announced identically, so a screen-reader user could not tell
    // which bot they were renaming.
    expect(SRC).toContain("aria-label=\"Rename {session.title || 'Untitled'}\"");
    expect(SRC).not.toContain('aria-label="Bot title"');
  });

  test("a conflict is announced to assistive tech, not only drawn", () => {
    expect(SRC).toContain('aria-describedby={conflict ? `rename-hint-${session.id}` : undefined}');
    expect(SRC).toContain('aria-invalid={conflict ? "true" : undefined}');
    expect(SRC).toContain("Already renamed to");
  });

  test("the template never reads the machine's getters directly", () => {
    // Svelte cannot see a plain getter change, so `{#if rename.conflict}` never re-renders
    // and `editing = $derived(rename.editing ?? "")` freezes at its first value — the field
    // then never opens at all. Both were real: caught by the live A/B, not by the unit tests.
    expect(SRC).not.toMatch(/\{#if rename\./);
    expect(SRC).not.toMatch(/\$derived\(rename\./);
    // and each mirror is written wherever the machine is driven
    expect(SRC).toMatch(/rename\.sync\([\s\S]{0,120}conflict = rename\.conflict;/);
    expect(SRC).toMatch(/rename\.type\([\s\S]{0,80}conflict = rename\.conflict;/);
  });

  test("the field's draft is reconciled against the store", () => {
    expect(SRC).toMatch(/\$effect\(\(\) => \{[\s\S]{0,320}rename\.sync\(/);
  });

  test("a double-click to rename does not also open the session twice", () => {
    // Measured on the deployed build: 2 click handlers fired on the row button.
    expect(SRC).toMatch(/ondblclick=\{\(e\) => \{[\s\S]{0,220}e\.preventDefault\(\);/);
  });
});
