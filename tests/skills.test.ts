import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import { collapseSkillPrompt, expandSkillPrompt, listSkills, parseSkillPrompt } from "../src/skills";
import { cleanTaskText } from "../src/traj/parse";

const dir = mkdtempSync(join(tmpdir(), "mini-tui-skills-"));
mkdirSync(join(dir, "good-code"));
writeFileSync(join(dir, "good-code", "SKILL.md"), "---\nname: good-code\ndescription: >\n  Use the minimum\n  code needed.\n---\n\n# Good Code\nKeep it small.\n");
mkdirSync(join(dir, "pr-body"));
writeFileSync(join(dir, "pr-body", "SKILL.md"), "---\nname: pr-body\ndescription: Professional PR bodies\n---\nWrite the body.\n");
mkdirSync(join(dir, "not-a-skill")); // no SKILL.md → ignored
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("skills", () => {
  test("lists skill folders with their front-matter description", () => {
    expect(listSkills(dir).map((s) => [s.name, s.description])).toEqual([
      ["good-code", "Use the minimum code needed."],
      ["pr-body", "Professional PR bodies"],
    ]);
    expect(listSkills(join(dir, "missing"))).toEqual([]);
  });

  test("parses `$name request` prompts only", () => {
    expect(parseSkillPrompt("$good-code tidy\nthe parser")).toEqual({ name: "good-code", request: "tidy\nthe parser" });
    expect(parseSkillPrompt("$pr-body")).toEqual({ name: "pr-body", request: "" });
    expect(parseSkillPrompt("costs $5")).toBeNull();
    expect(parseSkillPrompt("$ ls")).toBeNull();
  });

  test("expands to the SKILL.md instructions + request and collapses back for the transcript", () => {
    const task = expandSkillPrompt("$good-code tidy the parser", dir)!;
    expect(task).toContain("# Good Code\nKeep it small.");
    expect(task.endsWith("tidy the parser")).toBe(true);
    expect(collapseSkillPrompt(task)).toBe("$good-code tidy the parser");
    expect(cleanTaskText(`Please solve this issue: ${task}\n\nYou can execute bash commands`)).toBe("$good-code tidy the parser");
    expect(expandSkillPrompt("$nope do it", dir)).toBeNull();
    expect(collapseSkillPrompt("plain prompt")).toBe("plain prompt");
  });
});
