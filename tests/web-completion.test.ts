/** Prompt-bar completion: slash commands, $skills, applying a pick, and command parsing. */
import { describe, expect, test } from "bun:test";
import { completionAt, filterCommands, parseCommand, pickCompletion } from "../web/src/lib/completion";

const COMMANDS = [
  { name: "new", insert: "/new", detail: "Start a new chat", kind: "client" as const },
  { name: "model", insert: "/model", detail: "Switch the model", args: "[id]", kind: "client" as const },
  { name: "compact", insert: "/compact", detail: "Summarize", kind: "client" as const },
  { name: "connect", insert: "/connect", detail: "Connect a provider", kind: "client" as const },
];
const SKILLS = [
  { name: "pr-body", description: "Write a PR body" },
  { name: "better-ui", description: "Polish UI" },
  { name: "shadcn", description: "shadcn/ui" },
];

describe("filterCommands", () => {
  test("prefix matches come before substring matches", () => {
    expect(filterCommands("co", COMMANDS).map((c) => c.name)).toEqual(["compact", "connect"]);
    expect(filterCommands("act", COMMANDS).map((c) => c.name)).toEqual(["compact"]);
  });
  test("matches the description too, and an empty query lists everything", () => {
    expect(filterCommands("provider", COMMANDS).map((c) => c.name)).toEqual(["connect"]);
    expect(filterCommands("", COMMANDS)).toHaveLength(4);
    expect(filterCommands("/", COMMANDS)).toHaveLength(4);
  });
});

describe("completionAt", () => {
  test("a slash at the start opens commands", () => {
    const c = completionAt("/", 1, COMMANDS, SKILLS);
    expect(c?.kind).toBe("command");
    expect(c?.items).toHaveLength(4);
  });
  test("it narrows as you type and closes when nothing matches", () => {
    expect(completionAt("/mo", 3, COMMANDS, SKILLS)?.items.map((i) => i.name)).toEqual(["model"]);
    expect(completionAt("/zzz", 4, COMMANDS, SKILLS)).toBeNull();
  });
  test("once there is a space the command is chosen, nothing more is offered", () => {
    expect(completionAt("/model ", 7, COMMANDS, SKILLS)).toBeNull();
    expect(completionAt("/model deep", 11, COMMANDS, SKILLS)).toBeNull();
  });
  test("a slash mid-sentence or inside a path is not a command", () => {
    expect(completionAt("look at /etc", 12, COMMANDS, SKILLS)).toBeNull();
    expect(completionAt("/etc/hosts", 10, COMMANDS, SKILLS)).toBeNull();
  });
  test("$ opens skills anywhere, ranked like the terminal", () => {
    const c = completionAt("please use $pr", 14, COMMANDS, SKILLS);
    expect(c).toMatchObject({ kind: "skill", start: 11 });
    expect(c?.items.map((i) => i.name)).toEqual(["pr-body"]);
  });
  test("word order does not matter for skills", () => {
    expect(completionAt("$body-pr", 8, COMMANDS, SKILLS)?.items.map((i) => i.name)).toEqual(["pr-body"]);
  });
  test("money is not a skill", () => {
    expect(completionAt("it costs $5", 11, COMMANDS, SKILLS)).toBeNull();
  });
  test("completion follows the caret, not the end of the text", () => {
    expect(completionAt("$sh and more", 3, COMMANDS, SKILLS)?.items.map((i) => i.name)).toEqual(["shadcn"]);
  });
});

describe("pickCompletion", () => {
  test("a command becomes a chip and leaves the text empty, ready for its argument", () => {
    const c = completionAt("/mo", 3, COMMANDS, SKILLS)!;
    expect(pickCompletion("/mo", 3, c, 0)).toEqual({ text: "", cursor: 0, chip: { kind: "command", name: "model" } });
  });
  test("a skill is lifted out of the middle of a sentence and the gap closes", () => {
    const text = "use $pr on this";
    const c = completionAt(text, 7, COMMANDS, SKILLS)!;
    const r = pickCompletion(text, 7, c, 0);
    expect(r.chip).toEqual({ kind: "skill", name: "pr-body" });
    expect(r.text).toBe("use on this");
    expect(r.text.slice(0, r.cursor)).toBe("use ");
  });
  test("picking with the caret inside the token removes the whole token", () => {
    const text = "fix $shadcn now";
    const c = completionAt(text, 8, COMMANDS, SKILLS)!; // caret after "$sha"
    const r = pickCompletion(text, 8, c, 0);
    expect(r.text).toBe("fix now");
  });
  test("a skill typed first leaves no leading space", () => {
    const c = completionAt("$pr then more", 3, COMMANDS, SKILLS)!;
    const r = pickCompletion("$pr then more", 3, c, 0);
    expect(r.text).toBe("then more");
    expect(r.cursor).toBe(0);
  });
  test("a skill at the very end leaves the text before it untouched", () => {
    const c = completionAt("please use $bet", 15, COMMANDS, SKILLS)!;
    const r = pickCompletion("please use $bet", 15, c, 0);
    expect(r.text).toBe("please use ");
    expect(r.chip.name).toBe("better-ui");
  });
});

describe("parseCommand", () => {
  test("a known command, with and without an argument", () => {
    expect(parseCommand("/new", COMMANDS)).toEqual({ name: "new", arg: "", known: true });
    expect(parseCommand("  /model deepseek/deepseek-chat ", COMMANDS)).toEqual({ name: "model", arg: "deepseek/deepseek-chat", known: true });
  });
  test("names are case-insensitive", () => {
    expect(parseCommand("/NEW", COMMANDS)?.name).toBe("new");
  });
  test("a bare unknown word is a typo to report, not a prompt", () => {
    expect(parseCommand("/modle", COMMANDS)).toEqual({ name: "modle", arg: "", known: false });
  });
  test("paths and prose that start with a slash go to the agent", () => {
    expect(parseCommand("/etc/hosts is wrong", COMMANDS)).toBeNull();
    expect(parseCommand("/tmp has junk in it", COMMANDS)).toBeNull();
    expect(parseCommand("hello /new", COMMANDS)).toBeNull();
    expect(parseCommand("fix the bug", COMMANDS)).toBeNull();
  });
});
