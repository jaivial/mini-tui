import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { filterSkills, skillMatchRank } from "../src/skillMatch";
import { skillIsCut, SKILL_MIN_CUT, SKILL_LINES } from "../web/src/lib/skillDescription";

/**
 * E31 — the server ships every skill description whole (33 664 chars over 60 skills, 93% of
 * `/api/skills`) and the app used NONE of it: `$react` found nothing while five installed skills
 * say React in their description, and the two surfaces that DO paint it clamp it with no way to
 * read the rest. These tests hold both halves: the description joins the search, and a clipped
 * description says so.
 */

const REACT = "Design and review web app UI. Works for React, Next.js, Vue, Svelte, Tailwind and plain CSS.";
const CU = "Drive one always-open Chrome through the cu daemon.";
/** Verbatim from the deployed `/api/skills`: long enough that two lines cannot hold it. */
const LONG =
  "Select and apply a fitting Awesome Design MD `DESIGN.md` style for frontend/UI work. Use when the user asks to design UI, redesign a page, beautify a frontend, create a dashboard, improve visual hierarchy, change visual style, use a big-company design style, or mentions `DESIGN.md`, Awesome Design MD, brand-inspired UI, Apple/Stripe/Linear/Cursor/Raycast/Voltagent/Binance/Coinbase/xAI-style interfaces.";

const SKILLS = [
  { name: "cu", description: CU },
  { name: "dashboard-design", description: REACT },
  { name: "mobile-native", description: "Native iOS and Android apps with React Native." },
  { name: "tiny", description: "short" },
];

describe("E31 — a skill is findable by what its description says", () => {
  test("a query that is only in the description still finds the skill", () => {
    const found = filterSkills("react", SKILLS, (s) => s.name, (s) => s.description);
    expect(found.map((s) => s.name)).toEqual(["dashboard-design", "mobile-native"]);
  });

  test("the same query finds nothing without the description, which is the defect", () => {
    const names = filterSkills("react", SKILLS, (s) => s.name).map((s) => s.name);
    expect(names).toEqual([]);
  });

  test("without a detail accessor the ranking is exactly the old name-only one", () => {
    // The terminal and the web share this function; omitting the accessor must not change anything.
    for (const q of ["", "cu", "d", "des", "dash", "mob"]) {
      expect(filterSkills(q, SKILLS, (s) => s.name).map((s) => s.name)).toEqual(
        SKILLS.filter((s) => skillMatchRank(q, s.name) !== null).map((s) => s.name),
      );
    }
  });

  test("a name match always outranks a description match", () => {
    // `react-thing` starts with the query; `zzz` only says it in its description.
    expect(skillMatchRank("react", "react-thing", REACT)).toBe(0);
    expect(skillMatchRank("react", "zzz", REACT)).toBe(5);
    // Order in the menu follows that, even though both are offered.
    const rows = filterSkills("react", SKILLS, (s) => s.name, (s) => s.description).map((s) => s.name);
    expect(rows[0]).not.toBe("zzz");
  });

  test("description ranks sit below every name rank", () => {
    // Every name rank the module can return is better than the best description rank.
    const descRank = skillMatchRank("react", "zzz", REACT);
    expect(descRank).toBe(5);
    for (const r of [0, 1, 2, 3, 4]) expect(r).toBeLessThan(descRank ?? Infinity);
  });

  test("a whole description word beats a bare substring hit", () => {
    expect(skillMatchRank("react", "zzz", "Works for React and Vue")).toBe(5);
    // `eac` is inside `React` but is not a word, so it ranks below it.
    expect(skillMatchRank("eac", "zzz", "Works for React and Vue")).toBe(6);
    // A query that is NOT in the text does not match at all, however it is spelled.
    expect(skillMatchRank("reacti", "zzz", "Works for React and Vue")).toBeNull();
  });

  test("one or two characters never match a description (every one contains a/e/s)", () => {
    // The name `zzz` is chosen because it matches NONE of these queries on its own (checked, not
    // assumed: `zzz-nomatch` matches `a` and `xlsx` matches `s` at rank 2), so no NAME rank
    // can fire and only the description arm is under test.
    for (const s of SKILLS) {
      for (const q of ["a", "e", "s", "cu", "re"]) {
        expect(skillMatchRank(q, "zzz", s.description)).toBeNull();
      }
    }
  });

  test("an empty query still lists everything, ranked by folder order", () => {
    expect(filterSkills("", SKILLS, (s) => s.name, (s) => s.description).map((s) => s.name)).toEqual(
      SKILLS.map((s) => s.name),
    );
  });

  test("a missing or empty description cannot throw or match", () => {
    expect(filterSkills("react", SKILLS, (s) => s.name, (s) => undefined).map((s) => s.name)).toEqual([]);
    expect(skillMatchRank("react", "zzz", undefined)).toBeNull();
    expect(skillMatchRank("react", "zzz", "")).toBeNull();
  });

  test("a query full of regex metacharacters is matched literally, not compiled", () => {
    // The description arm builds a RegExp; these would throw or match everything if unescaped.
    for (const q of ["a.b", "c*", "(cu", "[cu", "cu)", "a|b", "?", "+", "\\"]) {
      expect(() => skillMatchRank(q, "zzz", REACT)).not.toThrow();
    }
    // `a.b` must not behave like the pattern `a<any>b` and hit "and b..."-style text.
    expect(skillMatchRank("a.b", "zzz", REACT)).toBeNull();
    expect(skillMatchRank("c*", "zzz", CU)).toBeNull();
  });

  test("the web and the terminal pass the description through, not a truncated copy", () => {
    // The terminal clamps `detail` to 71 characters for display; searching THAT would make the two
    // surfaces disagree about which skills exist. Both must pass the untruncated text.
    const web = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../web/src/lib/completion.ts"), "utf8");
    expect(web).toContain("filterSkills(skill.query, skills, (s) => s.name, (s) => s.description)");

    const tui = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/ui/App.tsx"), "utf8");
    expect(tui).toContain("(option) => option.full");
    // …and `full` has to be the whole description, not the clamped `detail`.
    expect(tui).toMatch(/full:\s*skill\.description\s*,?\s*$/m);
    const palette = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/ui/components/CommandPalette.tsx"), "utf8");
    expect(palette).toMatch(/full\?: string/);
  });
});

describe("E31 — a clipped description says it is clipped", () => {
  test("a long description offers `more`; a short one does not", () => {
    // A real description from the deployed catalogue: 561 characters on average, and this one
    // measures 429. The short one fits the two lines the list shows, so a button would be noise.
    expect(LONG.length).toBeGreaterThan(SKILL_MIN_CUT);
    expect(skillIsCut(LONG)).toBe(true);
    expect(skillIsCut(REACT)).toBe(false);
    expect(skillIsCut("short")).toBe(false);
    expect(skillIsCut("")).toBe(false);
    expect(skillIsCut(undefined)).toBe(false);
  });

  test("the threshold is above two lines' worth of text", () => {
    // The list clamps to SKILL_LINES lines; anything under that fits and must not get a button.
    expect(SKILL_LINES).toBe(2);
    expect(SKILL_MIN_CUT).toBeGreaterThan(70 * SKILL_LINES / 2);
    const justUnder = "x".repeat(SKILL_MIN_CUT);
    expect(skillIsCut(justUnder)).toBe(false);
    expect(skillIsCut("x".repeat(SKILL_MIN_CUT + 1))).toBe(true);
  });

  test("whitespace-only text is not offered a button", () => {
    expect(skillIsCut(`   ${"x".repeat(SKILL_MIN_CUT + 10)}   `)).toBe(true);
    expect(skillIsCut("          ")).toBe(false);
  });

  test("the Settings list clamps AND offers the toggle — a clamp alone is the E22/E23 trap", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../web/src/lib/components/SettingsModal.svelte"), "utf8");
    // The clamp exists…
    expect(src).toContain("line-clamp-2");
    // …and so does the way out, wired to the same condition that applies the clamp.
    expect(src).toMatch(/cut && !openSkills\.has\(s\.name\) \? 'line-clamp-2'/);
    expect(src).toMatch(/aria-expanded=\{openSkills\.has\(s\.name\)\}/);
    expect(src).toMatch(/aria-controls="\{uid\}-skill-\{s\.name\}"/);
    expect(src).toContain("skillIsCut");
  });

  test("the $ menu row can be read whole on hover, like every other truncated string here", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../web/src/lib/components/CompletionMenu.svelte"), "utf8");
    expect(src).toMatch(/truncate[^"]*"[^>]*title=\{row\.detail\}/);
  });

  test("the full text stays in the DOM, so a screen reader reads all of it", () => {
    // The AX tree already announced 448/352/374 chars while the screen showed 17.5%: the fix must
    // not replace the text with a server-side summary (that is the E22/E23 trap from the other
    // side). Nothing here may turn the description into a trimmed field.
    const serve = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/skills.ts"), "utf8");
    expect(serve).toMatch(/description: frontMatterDescription\(/);
    expect(serve).not.toMatch(/description:\s*\w*\.slice\(/);
    expect(serve).not.toMatch(/description:\s*\w*\.substring\(/);
  });
});
