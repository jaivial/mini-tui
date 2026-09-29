/**
 * Prompt memory for the web prompt bar: ↑ walks back through what was sent in this chat, ↓ walks
 * forward and finally restores the draft that was being written. The same rules as the terminal
 * (`src/history.ts`, which this reuses): blank and repeated-in-a-row prompts are not remembered.
 *
 * An entry keeps the chips apart from the text, so recalling `/model x` or `$pr-body write it` puts the
 * chips back as chips instead of flattening them into text the completion menu would then reopen on.
 * The memory is per session and seeded from its transcript, so a reload or `/resume` keeps it.
 */
import { PromptHistory } from "../../../src/history";
import type { Chip } from "./chips";

export interface Recalled {
  chips: Chip[];
  text: string;
}

const encode = (r: Recalled) => JSON.stringify([r.chips, r.text]);
const decode = (s: string): Recalled => {
  try {
    const [chips, text] = JSON.parse(s) as [Chip[], string];
    return { chips: Array.isArray(chips) ? chips : [], text: typeof text === "string" ? text : "" };
  } catch {
    return { chips: [], text: s };
  }
};

/** Split a sent message back into chips and text: `/cmd …` or leading `$skill`s become chips. */
export function splitSent(message: string, knownCommands: string[]): Recalled {
  const text = message.trim();
  const cmd = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (cmd && knownCommands.includes(cmd[1]!.toLowerCase())) return { chips: [{ kind: "command", name: cmd[1]!.toLowerCase() }], text: (cmd[2] ?? "").trim() };
  const chips: Chip[] = [];
  let rest = text;
  for (let m = /^\$([\w-]+)\s*/.exec(rest); m; m = /^\$([\w-]+)\s*/.exec(rest)) {
    if (!chips.some((c) => c.name === m![1])) chips.push({ kind: "skill", name: m[1]! });
    rest = rest.slice(m[0].length);
  }
  return { chips, text: rest };
}

export class PromptMemory {
  #h = new PromptHistory();

  /** Replace the memory, oldest first (a session's `task` events, as sent). */
  reset(sent: Recalled[] = []) {
    this.#h.reset(sent.map(encode));
  }
  push(entry: Recalled) {
    if (!entry.text.trim() && !entry.chips.length) return;
    this.#h.push(encode(entry));
  }
  /** Older entry, or null at the oldest. `current` becomes the draft on the first step back. */
  prev(current: Recalled): Recalled | null {
    const v = this.#h.prev(encode(current));
    return v === null ? null : decode(v);
  }
  /** Newer entry, then the saved draft, then null (not browsing). */
  next(): Recalled | null {
    const v = this.#h.next();
    return v === null ? null : decode(v);
  }
  get size() {
    return this.#h.size;
  }
}

