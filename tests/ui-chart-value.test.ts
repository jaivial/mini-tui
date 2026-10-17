/**
 * How a chart value reads out loud, on its own. Split from the component wiring
 * tests so a missing export cannot abort the whole file and hide which assertion
 * catches which defect.
 */
import { describe, expect, test } from "bun:test";
import { formatValue } from "../web/src/lib/ui/chartGeometry";

describe("a value reads as a number a person would say", () => {
  test("two decimals at most, no trailing zeros, no float artefacts", () => {
    expect(formatValue(58.4)).toBe("58.4");
    expect(formatValue(60)).toBe("60");
    expect(formatValue(44.900000000000006)).toBe("44.9");
    expect(formatValue(0)).toBe("0");
  });

  test("a value exactly on the half rounds half UP, toward zero when negative", () => {
    // Measured, not assumed: `Math.round` is half-up, so -12.345 lands on -12.34,
    // not -12.35, and 1.005 is not representable (it is 1.00499… in binary) so it
    // lands on 1. Pinned because a "fix" that reached for toFixed would quietly
    // change both, and a reader would hear a different number than before.
    expect(formatValue(-12.345)).toBe("-12.34");
    expect(formatValue(2.5)).toBe("2.5");
    expect(formatValue(1.005)).toBe("1");
  });

  test("no exponential notation for small numbers", () => {
    // String(0.0000001) is "1e-7", which a screen reader mangles into "1 e dash 7".
    expect(formatValue(0.0000001)).toBe("0");
    expect(formatValue(0.0001)).toBe("0");
  });
});
