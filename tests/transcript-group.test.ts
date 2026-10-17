/**
 * The transcript's run rule, pinned where it can be measured.
 *
 * The defect this exists for was measured live against the deployed build: in
 * a WhatsApp group thread, two messages from two different people rendered as
 * one run, so the second carried no sender line at all and was attributed to
 * whoever spoke before it. Zero nodes in the accessibility tree mentioned the
 * sender of a tucked mirror row. Grouping by kind alone was the whole cause:
 * every mirrored message is `kind: "channel"` whatever human wrote it.
 *
 * The rule is tested on its own (not through the rendered DOM) because the
 * component only calls it, and because the live proof of the wiring is the
 * browser measurement against the deployed build.
 */
import { describe, expect, test } from "bun:test";
import { sameRun } from "../web/src/lib/transcriptGroup";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const JAIME = "346000111111@s.whatsapp.net";
const OTRA = "346000222222@s.whatsapp.net";
const channel = (sender: string) => ({ kind: "channel", sender }) as const;

describe("a mirrored WhatsApp run is grouped by author", () => {
  test("the same sender keeps the run together", () => {
    expect(sameRun(channel(JAIME), channel(JAIME))).toBe(true);
  });

  test("a different sender in the same group starts a new run", () => {
    // The defect: kind alone said true here, which dropped the sender line.
    expect(sameRun(channel(JAIME), channel(OTRA))).toBe(false);
    expect(sameRun(channel(OTRA), channel(JAIME))).toBe(false);
  });

  test("three in a row: only the two of one voice group", () => {
    // A, B, A — the classic alternation that made the old rule lose both
    // headers except the first.
    const rows = [channel(JAIME), channel(OTRA), channel(JAIME)];
    expect(rows.slice(1).map((r, i) => sameRun(rows[i], r))).toEqual([false, false]);
  });

  test("a row with no sender never joins a run", () => {
    // Defence, not a guess: a mirror event whose sender is missing must not be
    // silently attributed to whoever was last on screen.
    expect(sameRun({ kind: "channel" }, channel(JAIME))).toBe(false);
    expect(sameRun(channel(JAIME), { kind: "channel" })).toBe(false);
  });
});

describe("the other two kinds keep their old behaviour", () => {
  test("consecutive assistant replies and consecutive prompts each group", () => {
    expect(sameRun({ kind: "assistant" }, { kind: "assistant" })).toBe(true);
    expect(sameRun({ kind: "task" }, { kind: "task" })).toBe(true);
  });

  test("a change of kind breaks the run", () => {
    expect(sameRun({ kind: "assistant" }, { kind: "task" })).toBe(false);
    expect(sameRun({ kind: "task" }, channel(JAIME))).toBe(false);
    expect(sameRun(channel(JAIME), { kind: "assistant" })).toBe(false);
  });

  test("no previous row starts a run", () => {
    expect(sameRun(undefined, channel(JAIME))).toBe(false);
    expect(sameRun(undefined, { kind: "assistant" })).toBe(false);
  });
});

describe("the component calls the rule with the sender the header reads", () => {
  // A perfect module that nothing calls is how the first version of this defect
  // shipped. This pins the wiring, and it is the half a DOM-less test can reach.
  const source = readFileSync(join(import.meta.dir, "..", "web", "src", "lib", "components", "Transcript.svelte"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  test("grouped() delegates to sameRun", () => {
    expect(source).toMatch(/function grouped\([^)]*\)\s*\{[\s\S]{0,400}?return sameRun\(/);
  });

  test("the sender it compares is the same field the header prints", () => {
    // `senderName(row.event.sender)` is what a reader sees; comparing a
    // different field would group messages the header names differently.
    expect(source).toMatch(/sender:\s*row\.kind === "channel" \? row\.event\.sender : undefined/);
    expect(source).toMatch(/senderName\(row\.event\.sender\)/);
  });

  test("the header is still the one that shows the author", () => {
    expect(source).toMatch(/\{#if !isGrouped\}[\s\S]{0,400}?\{senderName\(row\.event\.sender\)\}/);
  });
});
