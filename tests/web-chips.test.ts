/** Prompt-bar chips: what may be added, and how they become the message that is sent. */
import { describe, expect, test } from "bun:test";
import { addChip, announce, chipText, composePrompt, hasMessage, removeChip, type Chip } from "../web/src/lib/chips";

const cmd = (name: string): Chip => ({ kind: "command", name });
const skill = (name: string): Chip => ({ kind: "skill", name });

describe("addChip", () => {
  test("skills accumulate, each once", () => {
    let chips: Chip[] = [];
    chips = addChip(chips, skill("pr-body"));
    chips = addChip(chips, skill("better-ui"));
    chips = addChip(chips, skill("pr-body"));
    expect(chips.map((c) => c.name)).toEqual(["pr-body", "better-ui"]);
  });
  test("a command is the whole message: one at most, and it never replaces silently", () => {
    let chips = addChip([], cmd("model"));
    chips = addChip(chips, cmd("new"));
    expect(chips).toEqual([cmd("model")]);
  });
  test("a command cannot join skills, and skills cannot join a command", () => {
    expect(addChip([skill("pr-body")], cmd("new"))).toEqual([skill("pr-body")]);
    expect(addChip([cmd("model")], skill("pr-body"))).toEqual([cmd("model")]);
  });
  test("never mutates its input", () => {
    const before: Chip[] = [skill("a")];
    addChip(before, skill("b"));
    expect(before).toEqual([skill("a")]);
  });
});

describe("removeChip", () => {
  test("removes by position and leaves the rest in order", () => {
    expect(removeChip([skill("a"), skill("b"), skill("c")], 1).map((c) => c.name)).toEqual(["a", "c"]);
  });
  test("an out-of-range index removes nothing", () => {
    expect(removeChip([skill("a")], 5)).toEqual([skill("a")]);
  });
});

describe("composePrompt", () => {
  test("skills come first, then the typed text, as the terminal writes them", () => {
    expect(composePrompt([skill("pr-body"), skill("better-ui")], "  write it  ")).toBe("$pr-body $better-ui write it");
  });
  test("a command with an argument reads as one command line", () => {
    expect(composePrompt([cmd("model")], "deepseek/deepseek-chat")).toBe("/model deepseek/deepseek-chat");
  });
  test("a command alone, and text alone, are unchanged", () => {
    expect(composePrompt([cmd("new")], "")).toBe("/new");
    expect(composePrompt([], "hello")).toBe("hello");
    expect(composePrompt([], "   ")).toBe("");
  });
  test("chip names cannot smuggle extra text: only the sigil and the name are emitted", () => {
    expect(chipText(skill("pr-body"))).toBe("$pr-body");
    expect(chipText(cmd("compact"))).toBe("/compact");
  });
});

describe("hasMessage", () => {
  test("text sends; empty does not", () => {
    expect(hasMessage([], "hi")).toBe(true);
    expect(hasMessage([], "  ")).toBe(false);
  });
  test("a command alone is a complete message, a lone skill is not", () => {
    expect(hasMessage([cmd("new")], "")).toBe(true);
    expect(hasMessage([skill("pr-body")], "")).toBe(false);
    expect(hasMessage([skill("pr-body")], "do it")).toBe(true);
  });
});

describe("announce", () => {
  test("says what changed, for a screen reader", () => {
    expect(announce("added", skill("pr-body"))).toBe("Skill pr-body added");
    expect(announce("removed", cmd("model"))).toBe("Command model removed");
  });
});
