/**
 * The usage panel's client: fail-closed validation of the server projection, and
 * the formatting rule the whole task turns on — an unpriced model reads as
 * "desconocido", never as $0.00.
 */
import { describe, expect, test } from "bun:test";

import {
  USAGE_WINDOWS,
  formatCost,
  formatLatency,
  formatTokens,
  formatWhen,
  parseUsage,
  rowTokens,
  type UsageView,
} from "../web/src/lib/usageClient";

const NOW = Date.now();

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "deepseek",
    label: "deepseek",
    calls: 2,
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.0035,
    unknownCostCalls: 0,
    errors: 0,
    avgLatencyMs: 800,
    lastUsedAt: NOW,
    ...over,
  };
}

function view(over: Record<string, unknown> = {}): unknown {
  return {
    window: { name: "24h", since: NOW - 86_400_000, until: NOW },
    configured: true,
    totals: row(),
    byProvider: [row()],
    byModel: [row({ key: "deepseek/deepseek-chat" })],
    pricesConfigured: true,
    costComplete: true,
    recent: [{ at: NOW, session: "s1", task: "chat-1", provider: "deepseek", model: "deepseek/deepseek-chat", inputTokens: 1000, outputTokens: 200, costUsd: 0.0035, latencyMs: 800, ok: true }],
    ...over,
  };
}

describe("parseUsage", () => {
  test("accepts a well-formed projection", () => {
    const parsed = parseUsage(view()) as UsageView;
    expect(parsed.configured).toBe(true);
    expect(parsed.totals.calls).toBe(2);
    expect(parsed.byProvider).toHaveLength(1);
    expect(parsed.recent[0]!.session).toBe("s1");
  });

  test("keeps an unknown cost as null through validation", () => {
    const parsed = parseUsage(view({ totals: row({ costUsd: null, unknownCostCalls: 1 }) })) as UsageView;
    expect(parsed.totals.costUsd).toBeNull();
    expect(parsed.totals.unknownCostCalls).toBe(1);
  });

  test("refuses a projection with a missing or wrongly typed field", () => {
    for (const bad of [
      null,
      undefined,
      42,
      "text",
      {},
      view({ configured: "yes" }),
      view({ totals: row({ calls: "2" }) }),
      view({ totals: row({ inputTokens: null }) }),
      view({ byProvider: "nope" }),
      view({ window: {} }),
    ]) {
      expect(() => parseUsage(bad)).toThrow();
    }
  });

  test("a negative or non-numeric cost is junk, not a discount", () => {
    expect(() => parseUsage(view({ totals: row({ costUsd: -1 }) }))).toThrow();
    expect(() => parseUsage(view({ totals: row({ costUsd: "0.5" }) }))).toThrow();
  });

  test("refuses a row array over the bound", () => {
    const many = Array.from({ length: 501 }, (_, i) => row({ key: `p${i}` }));
    expect(() => parseUsage(view({ byProvider: many }))).toThrow();
  });

  test("a host with nothing measured is valid and says so", () => {
    const parsed = parseUsage(view({ configured: false, totals: row({ calls: 0, costUsd: null }), byProvider: [], byModel: [], recent: [], pricesConfigured: false })) as UsageView;
    expect(parsed.configured).toBe(false);
    expect(parsed.pricesConfigured).toBe(false);
  });
});

describe("formatCost", () => {
  test("an unknown cost is spelled out, and says how many calls it covers", () => {
    expect(formatCost(null)).toBe("desconocido");
    expect(formatCost(null, 3)).toBe("desconocido (3)");
  });

  test("a known cost reads as money at a sane precision", () => {
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(0.0004)).toBe("$0.0004");
    expect(formatCost(1.239)).toBe("$1.24");
    expect(formatCost(12.5)).toBe("$12.50");
  });

  test("unknown never renders as zero", () => {
    expect(formatCost(null)).not.toContain("0.00");
    expect(formatCost(null)).not.toContain("$0");
  });
});

describe("formatTokens", () => {
  test("scales the way the operator reads numbers", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(25_000)).toBe("25k");
    expect(formatTokens(3_400_000)).toBe("3.4M");
  });
});

describe("formatLatency", () => {
  test("ms below a second, seconds above, and a dash when unknown", () => {
    expect(formatLatency(null)).toBe("—");
    expect(formatLatency(250)).toBe("250 ms");
    expect(formatLatency(2500)).toBe("2.5 s");
    expect(formatLatency(45_000)).toBe("45 s");
  });
});

describe("formatWhen", () => {
  test("relative for recent, absolute for old, and 'never' for nothing", () => {
    expect(formatWhen(null)).toBe("nunca");
    expect(formatWhen(NOW - 5_000)).toBe("hace un momento");
    expect(formatWhen(NOW - 5 * 60_000)).toBe("hace 5 min");
    expect(formatWhen(NOW - 3 * 3_600_000)).toBe("hace 3 h");
    expect(formatWhen(NOW - 5 * 86_400_000)).toContain("/");
  });
});

describe("rowTokens", () => {
  test("cache tokens count: they are billed", () => {
    expect(rowTokens(row({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 1 }) as never)).toBe(116);
  });
});

describe("the window selector", () => {
  test("offers the windows the API accepts", () => {
    expect(USAGE_WINDOWS.map((w) => w.id)).toEqual(["1h", "24h", "7d", "30d", "all"]);
  });
});