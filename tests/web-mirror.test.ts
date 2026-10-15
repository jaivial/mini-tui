/**
 * Espejo on the web side: mirror events ride on held sessions, survive a
 * transcript rebuild/reload, and dedupe against a saved transcript that
 * already shows them. No agent process: the transcript is written by hand.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "minitui-web-mirror-"));
process.env.MINITUI_DB_PATH = join(dir, "sessions.db");
process.env.MINITUI_RESUME_DIR = join(dir, "resume");
process.env.MINITUI_RUNS_DIR = join(dir, "runs");
process.env.MINITUI_SETTINGS_PATH = join(dir, "settings.json");
process.env.MINITUI_CONFIG_DIR = dir;
process.env.MINITUI_LAST_MODEL_PATH = join(dir, "last-model.json");
process.env.MINITUI_CONNECTIONS_PATH = join(dir, "providers.json");
// Never start a real run: the stub exits immediately.
const stub = join(dir, "mini-stub");
writeFileSync(stub, "#!/bin/sh\nexit 0\n");
chmodSync(stub, 0o755);
process.env.MINITUI_MINI_BIN = stub;
process.env.MINITUI_EMBEDDED_AGENT = "0";

const { SessionManager } = await import("../src/web/sessions");
const { createSession, openDb, saveTranscript } = await import("../src/sessions");
const { parseTrajectory } = await import("../src/traj/parse");

const SID = "wa-mirror-under-test";
const MIRROR_ROWS = [
  { id: 11, text: "uno" },
  { id: 12, text: "dos" },
];

function channelEvent(mirrorId: number, text: string) {
  return {
    type: "channel",
    channel: "whatsapp",
    origin: "whatsapp",
    sender: "34600000000@s.whatsapp.net",
    text,
    ts: Date.now(),
    mirrorId,
    attachments: [],
  } as const;
}

function mirrorLoader(_id: string, existing: readonly unknown[]) {
  const shown = new Set(
    existing.map((e) => (e as { mirrorId?: number }).mirrorId).filter((id): id is number => typeof id === "number"),
  );
  return MIRROR_ROWS.filter((r) => !shown.has(r.id)).map((r) => channelEvent(r.id, r.text) as never);
}

/** Ensure the session row exists with a small saved transcript. */
function seedSession(messages: unknown[] = [{ role: "user", content: "tarea inicial" }], extraEvents: unknown[] = []) {
  const db = openDb(process.env.MINITUI_DB_PATH!);
  if (!db.query("SELECT 1 FROM sessions WHERE id=?").get(SID)) {
    createSession(db, { id: SID, cwd: dir, model: "", task: "sesión espejo" });
  }
  const parsed = parseTrajectory({ messages: messages as never[] });
  saveTranscript(db, SID, [...parsed.events, ...extraEvents] as never[], parsed.info, messages as never[]);
  db.close();
}

beforeAll(() => seedSession());

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const mirrorIds = (session: { events: unknown[] }) =>
  session.events
    .filter((e) => (e as { type?: string }).type === "channel")
    .map((e) => (e as unknown as { mirrorId: number }).mirrorId);

describe("SessionManager mirror (espejo)", () => {
  test("a restored session shows its mirror; injectChannel appends live", async () => {
    const manager = new SessionManager(() => {}, { syncMs: 0, mirror: mirrorLoader });
    const session = await manager.openHistory(SID);
    expect(mirrorIds(session)).toEqual([11, 12]);

    expect(manager.injectChannel(SID, channelEvent(13, "tres") as never)).toBe(true);
    const held = manager.get(SID)!;
    expect(mirrorIds(held)).toEqual([11, 12, 13]);
    expect(manager.injectChannel("no-such-session", channelEvent(14, "x") as never)).toBe(false);
  });

  test("an external save (reload from the shared db) never drops the mirror", async () => {
    const manager = new SessionManager(() => {}, { syncMs: 0, mirror: mirrorLoader });
    const session = await manager.openHistory(SID);
    expect(mirrorIds(session)).toContain(11);
    // Settle the entry first (its own initial persist), as production would be.
    await manager.syncExternal();
    // A live-injected row (the mirror poller) must survive the reload too.
    manager.injectChannel(SID, channelEvent(13, "tres") as never);

    // Another UI saves a newer, longer transcript under the session. (A beat,
    // so the save's updated_at strictly moves past the entry's sync stamp.)
    await Bun.sleep(10);
    seedSession([
      { role: "user", content: "tarea inicial" },
      { role: "assistant", content: "hecho" },
    ]);

    await manager.syncExternal();
    const held = manager.get(SID)!;
    expect(held.events.some((e) => e.type === "assistant")).toBe(true);
    expect(mirrorIds(held)).toEqual([11, 12, 13]);
  });

  test("the loader skips rows the saved transcript already carries (mirrorId dedupe)", async () => {
    // The transcript itself now shows mirror row 11 (as the poller's events do
    // once persisted): a fresh manager must only append row 12.
    seedSession([{ role: "user", content: "tarea inicial" }], [channelEvent(11, "uno")]);
    const manager = new SessionManager(() => {}, { syncMs: 0, mirror: mirrorLoader });
    const session = await manager.openHistory(SID);
    expect(mirrorIds(session)).toEqual([11, 12]);
  });
});
