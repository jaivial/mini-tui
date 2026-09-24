import { describe, expect, test } from "bun:test";

import { mountedItemLimit } from "../src/ui/App";

describe("transcript memory budget", () => {
  test("scales with viewport and stays bounded", () => {
    expect(mountedItemLimit(0)).toBe(24);
    expect(mountedItemLimit(Number.NaN)).toBe(24);
    expect(mountedItemLimit(12)).toBe(24);
    expect(mountedItemLimit(30)).toBe(60);
    expect(mountedItemLimit(200)).toBe(120);
  });
});
