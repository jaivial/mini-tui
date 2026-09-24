import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import {
  collapseSkillPrompt,
  discoverSkills,
  expandSkills,
  findSkillRefs,
  insertSkill,
  listSkills,
  skillQueryAt,
  syncSkills,
} from "../src/skills";
import { cleanTaskText } from "../src/traj/parse";

const root = mkdtempSync(join(tmpdir(), "mini-tui-skills-"));
const skill = (dir: string, name: string, body: string) => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), body);
};
const dir = join(root, "own");
skill(dir, "good-code", "---\nname: good-code\ndescription: >\n  Use the minimum\n  code needed.\n---\n\n# Good Code\nKeep it small.\n");
skill(dir, "pr-body", "---\nname: pr-body\ndescription: Professional PR bodies\n---\nWrite the body.\n");
mkdirSync(join(dir, "not-a-skill")); // no SKILL.md → ignored
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("skills", () => {
  test("lists skill folders with their front-matter description", () => {
    expect(listSkills(dir).map((s) => [s.name, s.description])).toEqual([
      ["good-code", "Use the minimum code needed."],
      ["pr-body", "Professional PR bodies"],
    ]);
    expect(listSkills(join(dir, "missing"))).toEqual([]);
  });

  test("finds $skill references anywhere, not prices or emails", () => {
    const text = "I want you to follow $good-code, then use the $better-ui, $pr-body, and finish with $pr-fix-loop.";
    expect(findSkillRefs(text).map((r) => r.name)).toEqual(["good-code", "better-ui", "pr-body", "pr-fix-loop"]);
    const first = findSkillRefs(text)[0]!;
    expect(text.slice(first.start, first.end)).toBe("$good-code");
    expect(findSkillRefs("costs $5, a$b, $ ls")).toEqual([]);
    expect(findSkillRefs("($pr-body)").map((r) => r.name)).toEqual(["pr-body"]);
    expect(findSkillRefs("$pr-body and $nope", new Set(["pr-body"])).map((r) => r.name)).toEqual(["pr-body"]);
  });

  test("the $ being typed at the cursor drives the completion panel", () => {
    expect(skillQueryAt("follow $go")).toEqual({ start: 7, query: "go" });
    expect(skillQueryAt("follow $")).toEqual({ start: 7, query: "" });
    expect(skillQueryAt("$pr")).toEqual({ start: 0, query: "pr" });
    expect(skillQueryAt("follow $good-code then")).toBeNull(); // cursor past the token
    expect(skillQueryAt("follow $good-code then", 12)).toEqual({ start: 7, query: "good" });
    expect(skillQueryAt("costs a$b")).toBeNull();
  });

  test("inserting a skill replaces only the token under the cursor", () => {
    expect(insertSkill("follow $go", 10, "good-code")).toEqual({ text: "follow $good-code ", cursor: 18 });
    expect(insertSkill("use $ now", 5, "pr-body")).toEqual({ text: "use $pr-body now", cursor: 13 });
    expect(insertSkill("use $prb now", 7, "pr-body")).toEqual({ text: "use $pr-body now", cursor: 13 });
  });

  test("expands every referenced skill ahead of the prompt and collapses back", () => {
    const prompt = "follow $good-code, then write it with $pr-body and $nope";
    const { task, used, missing } = expandSkills(prompt, dir);
    expect(used).toEqual(["good-code", "pr-body"]);
    expect(missing).toEqual(["nope"]);
    expect(task).toContain("# Good Code\nKeep it small.");
    expect(task).toContain("Write the body.");
    expect(task.indexOf("Keep it small.")).toBeLessThan(task.indexOf("Write the body."));
    expect(task.endsWith(prompt)).toBe(true);
    expect(collapseSkillPrompt(task)).toBe(prompt);
    expect(cleanTaskText(`Please solve this issue: ${task}\n\nYou can execute bash commands`)).toBe(prompt);
    expect(expandSkills("$good-code twice $good-code", dir).task.match(/<skill name=/g)).toHaveLength(1);
    expect(expandSkills("plain prompt", dir)).toEqual({ task: "plain prompt", used: [], missing: [] });
    expect(collapseSkillPrompt("plain prompt")).toBe("plain prompt");
  });

  test("old single-skill transcripts still collapse", () => {
    const legacy = `<skill name="good-code" path="/x">\nbody\n</skill>\n\nFollow the skill above for this request:\ntidy`;
    expect(collapseSkillPrompt(legacy)).toBe("$good-code tidy");
  });
});

describe("syncing from ~/.claude/skills", () => {
  const claude = join(root, "claude");
  const shared = join(root, "agents-skills");
  skill(claude, "good-code", "---\ndescription: claude copy\n---\nCLAUDE\n");
  skill(shared, "better-ui", "---\ndescription: ui\n---\nUI\n");
  mkdirSync(claude, { recursive: true });
  symlinkSync(join(shared, "better-ui"), join(claude, "better-ui")); // symlinked skill
  skill(join(claude, "synced", "bucket-1"), "pdf", "---\ndescription: pdf\n---\nPDF\n"); // nested bucket
  skill(join(claude, "synced", "bucket-1", "pdf"), "assets", "---\n---\nnot a top-level skill\n");
  mkdirSync(join(claude, "empty"));

  test("discovers direct, symlinked and bucketed skills", () => {
    expect([...discoverSkills(claude).keys()].sort()).toEqual(["better-ui", "good-code", "pdf"]);
  });

  test("copies only the missing ones, never overwrites, never re-imports deleted ones", () => {
    const own = join(root, "mini-tui-skills");
    skill(own, "good-code", "---\ndescription: mine\n---\nMINE\n");
    expect(syncSkills(claude, own).added.sort()).toEqual(["better-ui", "pdf"]);
    expect(readFileSync(join(own, "good-code", "SKILL.md"), "utf8")).toContain("MINE");
    expect(readFileSync(join(own, "better-ui", "SKILL.md"), "utf8")).toContain("UI"); // real copy
    expect(existsSync(join(own, "pdf", "assets", "SKILL.md"))).toBe(true); // whole folder
    expect(syncSkills(claude, own).added).toEqual([]); // idempotent
    rmSync(join(own, "pdf"), { recursive: true });
    expect(syncSkills(claude, own).added).toEqual([]); // the user removed it: stays removed
    skill(claude, "brand-new", "---\ndescription: new\n---\nNEW\n");
    expect(syncSkills(claude, own).added).toEqual(["brand-new"]);
  });

  test("a missing source is a no-op", () => {
    expect(syncSkills(join(root, "none"), join(root, "x"))).toEqual({ added: [], dir: join(root, "x") });
    expect(existsSync(join(root, "x"))).toBe(false);
  });
});
