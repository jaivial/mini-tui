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

import { OUTPUT_HEAD_LINES, OUTPUT_MAX_CHARS, OUTPUT_TAIL_LINES, boundEvent, boundText } from "../src/traj/slim";
import { messagesToEvents } from "../src/traj/parse";
import { parseSavedEvents } from "../src/ui/preview";
import { clipOutput } from "../src/ui/components/StepCard";
import { createSession, getSession, getSessionPreview, listSessions, openDb, saveTranscript } from "../src/sessions";
import type { RunEvent } from "../src/traj/schema";

describe("retained outputs are bounded to what a card can show", () => {
  test("small outputs are untouched", () => {
    const text = "a\nb\n".repeat(100);
    expect(boundText(text)).toBe(text);
  });

  test("many lines keep the displayable head and tail", () => {
    const lines = Array.from({ length: 100_000 }, (_, i) => `line ${i}`);
    const out = boundText(lines.join("\n"));
    expect(out.length).toBeLessThan(OUTPUT_MAX_CHARS + 30_000);
    expect(out.startsWith("line 0\nline 1\n")).toBe(true);
    expect(out.endsWith(`line ${lines.length - 1}`)).toBe(true);
    expect(out).toContain(`${lines.length - OUTPUT_HEAD_LINES - OUTPUT_TAIL_LINES} lines hidden`);
    // the collapsed card (8 head + 12 tail lines) renders exactly what it did before
    expect(clipOutput(out, "collapsed").text.split("\n").slice(-OUTPUT_TAIL_LINES)).toEqual(lines.slice(-OUTPUT_TAIL_LINES));
    expect(clipOutput(out, "collapsed").text.split("\n").slice(0, 8)).toEqual(lines.slice(0, 8));
  });

  test("a single giant line is char-capped", () => {
    const out = boundText("x".repeat(5_000_000));
    expect(out.length).toBeLessThan(OUTPUT_MAX_CHARS + 100);
    expect(out).toContain("output truncated");
  });

  test("parsed observations and restored sessions are bounded", () => {
    const huge = "y\n".repeat(200_000);
    const [event] = messagesToEvents([
      { role: "tool", tool_call_id: "c1", content: "x", extra: { raw_output: huge, returncode: 0, exception_info: "" } },
    ]);
    expect(event?.type).toBe("observation");
    expect((event as Extract<RunEvent, { type: "observation" }>).output.length).toBeLessThan(OUTPUT_MAX_CHARS);
    const saved: RunEvent[] = [{ type: "observation", toolCallId: null, returncode: 0, output: huge, exceptionInfo: "" }];
    const [restored] = parseSavedEvents(JSON.stringify(saved));
    expect((restored as Extract<RunEvent, { type: "observation" }>).output.length).toBeLessThan(OUTPUT_MAX_CHARS);
    const task: RunEvent = { type: "task", text: "t" };
    expect(boundEvent(task)).toBe(task);
  });

  test("session listings never load transcript blobs", () => {
    const db = openDb(":memory:");
    createSession(db, { id: "s1", cwd: "/p", model: "m", task: "task" });
    saveTranscript(db, "s1", [{ type: "task", text: "task" }], { cost: 1, apiCalls: 2 }, [{ role: "user", content: "task" }]);
    const [row] = listSessions(db, "/p", "", 0);
    expect(row?.id).toBe("s1");
    expect(row?.api_calls).toBe(2);
    expect(row?.events_json).toBe("[]");
    expect(row?.messages_json).toBe("[]");
    expect(JSON.parse(getSessionPreview(db, "s1")!.events_json)).toEqual([{ type: "task", text: "task" }]);
    expect(getSessionPreview(db, "s1")!.messages_json).toBe("[]");
    expect(JSON.parse(getSession(db, "s1")!.messages_json)).toEqual([{ role: "user", content: "task" }]);
  });
});
