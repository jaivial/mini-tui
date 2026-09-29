/** The web prompt bar's ↑/↓ memory: order, the draft, chips kept as chips, and the no-repeat rule. */
import { describe, expect, test } from "bun:test";
import { PromptMemory, splitSent } from "../web/src/lib/promptMemory";

const t = (text: string, chips: any[] = []) => ({ chips, text });

describe("prompt memory", () => {
  test("↑ walks back, ↓ walks forward and brings the draft back", () => {
    const m = new PromptMemory();
    m.push(t("first"));
    m.push(t("second"));
    expect(m.prev(t("half-typed"))).toEqual(t("second"));
    expect(m.prev(t("ignored"))).toEqual(t("first"));
    expect(m.prev(t("ignored"))).toBeNull(); // the oldest: stays
    expect(m.next()).toEqual(t("second"));
    expect(m.next()).toEqual(t("half-typed")); // the draft is not lost
    expect(m.next()).toBeNull(); // not browsing any more
  });
  test("blank and repeated-in-a-row prompts are not remembered", () => {
    const m = new PromptMemory();
    m.push(t("   "));
    m.push(t("same"));
    m.push(t("same"));
    expect(m.size).toBe(1);
  });
  test("chips come back as chips", () => {
    const m = new PromptMemory();
    const cmd = { chips: [{ kind: "command", name: "model" }], text: "deepseek/deepseek-chat" } as any;
    m.push(cmd);
    expect(m.prev(t(""))).toEqual(cmd);
  });
  test("a sent message splits back into its chips and text", () => {
    expect(splitSent("/model x/y", ["model", "new"])).toEqual({ chips: [{ kind: "command", name: "model" }], text: "x/y" });
    expect(splitSent("/etc/hosts is broken", ["model"])).toEqual({ chips: [], text: "/etc/hosts is broken" });
    expect(splitSent("$pr-body $better-ui write it", [])).toEqual({ chips: [{ kind: "skill", name: "pr-body" }, { kind: "skill", name: "better-ui" }], text: "write it" });
    expect(splitSent("fix $pr-body later", [])).toEqual({ chips: [], text: "fix $pr-body later" });
  });
  test("reset seeds from a session's past prompts, newest reached first", () => {
    const m = new PromptMemory();
    m.reset([t("a"), t("b")]);
    expect(m.prev(t(""))).toEqual(t("b"));
    m.reset();
    expect(m.prev(t(""))).toBeNull();
  });
});
