import { describe, expect, test } from "bun:test";

import { buildOsc52 } from "../src/clipboard";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

describe("clipboard (tmux-proof OSC 52)", () => {
  test("plain terminals get a raw OSC 52 sequence", () => {
    const seq = buildOsc52("hello", false);
    expect(seq.startsWith(ESC + "]52;c;")).toBe(true);
    expect(seq.endsWith(BEL)).toBe(true);
    const payload = seq.slice((ESC + "]52;c;").length, -1);
    expect(Buffer.from(payload, "base64").toString("utf8")).toBe("hello");
  });

  test("tmux gets the DCS passthrough wrapper with doubled escapes", () => {
    const plain = buildOsc52("héllo", false);
    const seq = buildOsc52("héllo", true);
    const expected = ESC + "Ptmux;" + ESC + plain.split(ESC).join(ESC + ESC) + ESC + String.fromCharCode(92);
    expect(seq).toBe(expected);
    // the inner OSC 52 payload still decodes to the original text
    const payload = plain.slice((ESC + "]52;c;").length, -1);
    expect(Buffer.from(payload, "base64").toString("utf8")).toBe("héllo");
  });
});
