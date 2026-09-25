/**
 * The `$` panel matches skill words in any order, and the skill color covers exactly the
 * `$name` characters wherever the reference sits in the prompt (after newlines, tabs, accents,
 * wide characters and emoji — the textarea does not count offsets like JS strings).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";

import { filterSkills, skillMatchRank } from "../src/skills";
import { App } from "../src/ui/App";
import { fromCursorOffset, toCursorOffset, toHighlightOffset } from "../src/ui/textOffsets";

process.env.MINITUI_CONNECTIONS_PATH = "/dev/null/mini-tui-no-connections.json";
process.env.MINITUI_LAST_MODEL_PATH = "/dev/null/mini-tui-no-last-model.json";

const NAMES = ["good-code", "better-ui", "pr-body", "pr-fix-loop", "sage-infographics", "codeReview"];

describe("$skill matching: any word, any order", () => {
  const find = (query: string) => filterSkills(query, NAMES, (name) => name);
  test("a later word finds the skill (body → pr-body)", () => {
    expect(find("body")).toEqual(["pr-body"]);
    expect(find("loop")).toEqual(["pr-fix-loop"]);
    expect(find("ui")).toEqual(["better-ui"]);
    expect(find("review")).toEqual(["codeReview"]); // camelCase words
  });
  test("words in any order", () => {
    expect(find("body-pr")).toEqual(["pr-body"]);
    expect(find("loop.fix")).toEqual(["pr-fix-loop"]);
    expect(find("code-good")).toEqual(["good-code"]);
  });
  test("prefix first, then word starts, then substrings, then fuzzy", () => {
    expect(find("pr")).toEqual(["pr-body", "pr-fix-loop"]);
    expect(find("code")).toEqual(["codeReview", "good-code"]);
    expect(find("ody")).toEqual(["pr-body"]);
    expect(find("bdy")).toEqual(["pr-body"]);
    expect(find("infog")).toEqual(["sage-infographics"]);
  });
  test("an empty query lists everything in folder order; nonsense matches nothing", () => {
    expect(find("")).toEqual(NAMES);
    expect(find("zzz")).toEqual([]);
    expect(skillMatchRank("PR-BODY", "pr-body")).toBe(0);
    expect(skillMatchRank("xq", "pr-body")).toBeNull();
  });
});

describe("textarea offsets", () => {
  test("ASCII is identity; newlines count for the cursor only", () => {
    expect(toCursorOffset("ab $x", 3)).toBe(3);
    expect(toHighlightOffset("ab $x", 3)).toBe(3);
    expect(toCursorOffset("a\nb $x", 4)).toBe(4);
    expect(toHighlightOffset("a\nb $x", 4)).toBe(3);
  });
  test("tabs and wide characters take their columns", () => {
    expect(toCursorOffset("a\t$x", 2)).toBe(3);
    expect(toHighlightOffset("中 $x", 2)).toBe(3);
    expect(toHighlightOffset("🚀 $x", 3)).toBe(3);
    expect(toHighlightOffset("e\u0301 $x", 3)).toBe(3);
    expect(toCursorOffset("e\u0301 $x", 3)).toBe(2);
  });
  test("cursor offsets round-trip on every grapheme boundary", () => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    for (const text of ["plain $pr-body x", "中文 $pr-body", "a\n\tb $pr-body", "🇪🇸 $pr-body é", "e\u0301 $pr-body"]) {
      const bounds = [...segmenter.segment(text)].map((part) => part.index).concat(text.length);
      for (const index of bounds) expect(fromCursorOffset(text, toCursorOffset(text, index))).toBe(index);
    }
  });
});

describe("App prompt", () => {
  const skillsDir = mkdtempSync(join(tmpdir(), "mini-tui-skill-prompt-"));
  for (const name of NAMES) {
    mkdirSync(join(skillsDir, name));
    writeFileSync(join(skillsDir, name, "SKILL.md"), `---\ndescription: ${name} skill\n---\n${name.toUpperCase()}-RULES\n`);
  }
  afterAll(() => rmSync(skillsDir, { recursive: true, force: true }));

  const mount = async () => {
    const sent: string[] = [];
    const setup = await testRender(
      <App cwd="." events={[]} info={{ cost: 0, apiCalls: 0 }} skillsDir={skillsDir} onSend={(text) => sent.push(text)} onQuit={() => {}} />,
      { width: 110, height: 30 },
    );
    await setup.renderOnce();
    const settle = async () => {
      await Bun.sleep(25);
      await setup.renderOnce();
    };
    return { setup, sent, settle };
  };
  const violet = (setup: Awaited<ReturnType<typeof testRender>>) =>
    setup
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .filter((span) => [...span.fg.buffer].slice(0, 3).join() === "167,139,250")
      .map((span) => span.text)
      .join("|");

  test("typing $body lists and completes $pr-body", async () => {
    const { setup, settle } = await mount();
    await setup.mockInput.typeText("please use $body");
    await settle();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("pr-body skill");
    expect(frame).not.toContain("good-code skill");
    await act(async () => setup.mockInput.pressEnter());
    await settle();
    expect(setup.captureCharFrame()).toContain("please use $pr-body");
    setup.renderer.destroy();
  });

  test("typing $loop-fix (words reversed) completes $pr-fix-loop", async () => {
    const { setup, settle } = await mount();
    await setup.mockInput.typeText("$loop-fix");
    await settle();
    expect(setup.captureCharFrame()).toContain("pr-fix-loop skill");
    await act(async () => setup.mockInput.pressEnter());
    await settle();
    expect(setup.captureCharFrame()).toContain("$pr-fix-loop");
    setup.renderer.destroy();
  });

  for (const [label, text] of [
    ["mid-phrase", "first write it then $pr-body and more text after"],
    ["after newlines", "line one\nline two\nnow $pr-body then more"],
    ["after a tab", "col\tthen $pr-body then more"],
    ["after accents", "añade acción y después $pr-body más texto"],
    ["after wide characters", "中文 text $pr-body then more"],
    ["after an emoji", "ship it 🚀 with $pr-body please"],
    ["two skills and text", "use $good-code\nand then $pr-body at the end"],
  ] as const) {
    test(`the skill color covers exactly $name (${label})`, async () => {
      const { setup, settle } = await mount();
      await setup.mockInput.pasteBracketedText(text);
      await settle();
      const expected = [...text.matchAll(/\$[\w-]+/g)].map((match) => match[0]).join("|");
      expect(violet(setup)).toBe(expected);
      setup.renderer.destroy();
    });
  }

  test("editing before and after a $skill keeps the color on it (cursor moved mid-phrase)", async () => {
    const { setup, settle } = await mount();
    await setup.mockInput.typeText("fix it with $pr-bo");
    await settle();
    await act(async () => setup.mockInput.pressEnter()); // completes $pr-body + space
    await settle();
    await setup.mockInput.typeText("and then some more words");
    await settle();
    for (let i = 0; i < "and then some more words".length + "$pr-body ".length + 3; i++) setup.mockInput.pressArrow("left");
    await settle();
    await setup.mockInput.typeText("ññ ");
    await settle();
    expect(setup.captureCharFrame()).toContain("fix it wiññ th $pr-body and then");
    expect(violet(setup)).toBe("$pr-body");
    setup.renderer.destroy();
  });
});
