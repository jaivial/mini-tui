import { describe, expect, test } from "bun:test";

import { bareCliproxyId, gatewayServes, type CliproxyCatalog } from "../src/cliproxyCatalog";

const live = (ids: string[]): CliproxyCatalog => ({ base: "http://127.0.0.1:8317/v1", ids, source: "live" });

describe("bareCliproxyId", () => {
  test("strips the routing prefix mini adds", () => {
    expect(bareCliproxyId("cliproxy/claude-opus-5-5")).toBe("claude-opus-5-5");
  });

  test("leaves a bare id alone", () => {
    expect(bareCliproxyId("claude-opus-5-5")).toBe("claude-opus-5-5");
  });

  test("is case-insensitive on the prefix", () => {
    expect(bareCliproxyId("Cliproxy/x")).toBe("x");
  });
});

describe("gatewayServes", () => {
  test("true when the gateway advertises the id", () => {
    expect(gatewayServes(live(["claude-opus-5-5"]), "cliproxy/claude-opus-5-5")).toBe(true);
  });

  test("false when the subscription signed out and the id vanished", () => {
    expect(gatewayServes(live(["claude-opus-5"]), "cliproxy/claude-opus-5-5")).toBe(false);
  });

  test("a bare id is matched the same way", () => {
    expect(gatewayServes(live(["claude-opus-5-5"]), "claude-opus-5-5")).toBe(true);
  });

  test("an unreachable gateway gives no opinion (a pick must never be blocked)", () => {
    const down: CliproxyCatalog = { base: "http://127.0.0.1:8317/v1", ids: null, source: "unreachable" };
    expect(gatewayServes(down, "cliproxy/claude-opus-5-5")).toBeNull();
    expect(gatewayServes(null, "cliproxy/claude-opus-5-5")).toBeNull();
  });
});
