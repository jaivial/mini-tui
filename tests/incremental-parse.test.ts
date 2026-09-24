import { describe, expect, test } from "bun:test";

import { createParseState, messagesToEvents } from "../src/traj/parse";
import type { TrajectoryMessage } from "../src/traj/schema";

const message = (role: TrajectoryMessage["role"], content = ""): TrajectoryMessage => ({ role, content });

describe("incremental trajectory parsing", () => {
  test("carries task state without rescanning the prefix", () => {
    const messages: TrajectoryMessage[] = [message("user", "fix it")];
    const state = createParseState();
    expect(messagesToEvents(messages, {}, 0, state).map((event) => event.type)).toEqual(["task"]);
    expect(state.taskSeen).toBe(true);

    messages.push(message("assistant", "working"));
    expect(messagesToEvents(messages, {}, 1, state).map((event) => event.type)).toEqual(["assistant"]);
    messages.push(message("user", "ordinary note"));
    expect(messagesToEvents(messages, {}, 2, state).map((event) => event.type)).toEqual(["notice"]);
  });

  test("one-shot startIndex behavior remains backwards compatible", () => {
    const messages = [message("user", "fix it"), message("assistant", "working")];
    expect(messagesToEvents(messages, {}, 1).map((event) => event.type)).toEqual(["assistant"]);
  });

  test("a restored prefix seeds parser state without rescanning later snapshots", () => {
    const restored: TrajectoryMessage[] = [message("user", "saved task"), message("assistant", "saved reply")];
    const state = createParseState(restored, restored.length);
    expect(state.taskSeen).toBe(true);
    const next = [...restored, message("assistant", "new reply")];
    expect(messagesToEvents(next, {}, restored.length, state).map((event) => event.type)).toEqual(["assistant"]);
  });
});
