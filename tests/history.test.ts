import { describe, expect, test } from "bun:test";

import { PromptHistory } from "../src/history";

describe("PromptHistory", () => {
  test("↑ walks back, ↓ walks forward and restores the draft", () => {
    const history = new PromptHistory();
    expect(history.prev("draft")).toBeNull(); // nothing sent yet
    history.push("first");
    history.push("second");
    history.push("second"); // repeated in a row → kept once
    history.push("   "); // blank → skipped
    expect(history.size).toBe(2);
    expect(history.prev("half-typed")).toBe("second");
    expect(history.prev("second")).toBe("first");
    expect(history.prev("first")).toBeNull(); // oldest
    expect(history.next()).toBe("second");
    expect(history.next()).toBe("half-typed"); // back to the draft
    expect(history.next()).toBeNull(); // not browsing anymore
  });

  test("reset replaces the memory (new session empties it, resume seeds it)", () => {
    const history = new PromptHistory();
    history.push("old");
    history.reset();
    expect(history.prev("")).toBeNull();
    history.reset(["a", "b"]);
    expect(history.prev("")).toBe("b");
  });
});
