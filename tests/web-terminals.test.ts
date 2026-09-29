/** Web terminals: a real shell in a real PTY, driven like the hub drives it (no network). */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Terminals, type TermOut } from "../src/web/terminals";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "minitui-term-")));
mkdirSync(join(dir, "proj"));
const all: Terminals[] = [];
afterAll(() => {
  for (const t of all) t.killAll();
  rmSync(dir, { recursive: true, force: true });
});
const make = (o: ConstructorParameters<typeof Terminals>[0] = {}) => {
  const t = new Terminals({ enabled: true, ...o });
  all.push(t);
  return t;
};
const viewer = () => {
  const got: TermOut[] = [];
  return { got, send: (m: TermOut) => (got.push(m), true), text: () => got.filter((m) => m.t === "term.data").map((m) => (m as { data: string }).data).join("") };
};
async function until(ok: () => boolean, ms = 5000) {
  for (let i = 0; i < ms / 25 && !ok(); i++) await Bun.sleep(25);
  return ok();
}

describe("web terminals", () => {
  test("opens a real shell in the session's folder, runs commands, sizes the PTY", async () => {
    const terms = make();
    const v = viewer();
    terms.open(v, "t-1", { cols: 90, rows: 20, cwd: join(dir, "proj") });
    expect(v.got[0]).toMatchObject({ t: "term.opened", id: "t-1", cwd: join(dir, "proj"), alive: true });
    terms.input("t-1", "echo MARK-$((6*7)); pwd; tty; stty size\r");
    expect(await until(() => /MARK-42/.test(v.text()) && /\d+ \d+/.test(v.text()))).toBe(true);
    const out = v.text();
    expect(out).toContain(join(dir, "proj"));
    expect(out).toMatch(/\/dev\/pts\/\d+/); // a real terminal, not a pipe
    expect(out).toContain("20 90");
    terms.resize("t-1", 120, 40);
    terms.input("t-1", "stty size\r");
    expect(await until(() => v.text().includes("40 120"))).toBe(true);
  });
  test("a missing folder falls back to home instead of failing", () => {
    const terms = make();
    const v = viewer();
    terms.open(v, "t-2", { cols: 80, rows: 24, cwd: join(dir, "does-not-exist") });
    expect((v.got[0] as { cwd: string }).cwd).not.toContain("does-not-exist");
  });
  test("closing the tab keeps the shell; reattaching replays what it printed", async () => {
    const terms = make();
    const a = viewer();
    terms.open(a, "t-3", { cols: 80, rows: 24, cwd: dir });
    terms.input("t-3", "export KEEP=still-here; echo SEEN-BEFORE\r");
    expect(await until(() => a.text().includes("SEEN-BEFORE"))).toBe(true);
    terms.detach(a);
    expect(terms.has("t-3")).toBe(true);
    const b = viewer();
    terms.open(b, "t-3", { cols: 80, rows: 24, cwd: dir });
    expect((b.got[0] as { replay: string }).replay).toContain("SEEN-BEFORE");
    terms.input("t-3", "echo KEEP=$KEEP\r");
    expect(await until(() => b.text().includes("KEEP=still-here"))).toBe(true); // the same shell
  });
  test("two viewers of one terminal both see its output", async () => {
    const terms = make();
    const a = viewer(), b = viewer();
    terms.open(a, "t-4", { cols: 80, rows: 24, cwd: dir });
    terms.open(b, "t-4", { cols: 80, rows: 24, cwd: dir });
    terms.input("t-4", "echo BOTH\r");
    expect(await until(() => a.text().includes("BOTH") && b.text().includes("BOTH"))).toBe(true);
  });
  test("exit is reported, and opening again starts a fresh shell", async () => {
    const terms = make();
    const v = viewer();
    terms.open(v, "t-5", { cols: 80, rows: 24, cwd: dir });
    terms.input("t-5", "exit 3\r");
    expect(await until(() => v.got.some((m) => m.t === "term.exit"))).toBe(true);
    expect(v.got.find((m) => m.t === "term.exit")).toMatchObject({ code: 3 });
    const w = viewer();
    terms.open(w, "t-5", { cols: 80, rows: 24, cwd: dir });
    expect(w.got[0]).toMatchObject({ t: "term.opened", alive: true, replay: "" });
  });
  test("an idle terminal with nobody watching is killed after the grace period", async () => {
    const terms = make({ idleMs: 150 });
    const v = viewer();
    terms.open(v, "t-6", { cols: 80, rows: 24, cwd: dir });
    terms.detach(v);
    expect(await until(() => !terms.has("t-6"), 2000)).toBe(true);
  });
  test("a flood is cut to its tail with a marker, never buffered whole", async () => {
    const terms = make({ floodMax: 20_000, flushMs: 200 });
    const v = viewer();
    terms.open(v, "t-7", { cols: 80, rows: 24, cwd: dir });
    terms.input("t-7", "head -c 400000 /dev/zero | tr '\\0' x; echo; echo FLOOD-END\r");
    expect(await until(() => v.text().includes("FLOOD-END"), 8000)).toBe(true);
    expect(v.text()).toContain("output truncated");
    expect(Math.max(...v.got.filter((m) => m.t === "term.data").map((m) => (m as { data: string }).data.length))).toBeLessThan(40_000);
  });
  test("limits and bad input are refused with a reason", () => {
    const terms = make({ max: 1 });
    const v = viewer();
    terms.open(v, "../x", { cols: 80, rows: 24 });
    expect(v.got.at(-1)).toMatchObject({ t: "error", error: "invalid terminal id" });
    terms.open(v, "t-8", { cols: 80, rows: 24, cwd: dir });
    terms.open(v, "t-9", { cols: 80, rows: 24, cwd: dir });
    expect(v.got.at(-1)).toMatchObject({ t: "error", error: expect.stringContaining("at most 1") });
    terms.input("t-8", 42 as never); // ignored, no throw
    terms.resize("t-8", Number.NaN, -5); // clamped, no throw
  });
  test("it can be turned off for the whole server", () => {
    const terms = make({ enabled: false });
    const v = viewer();
    terms.open(v, "t-10", { cols: 80, rows: 24 });
    expect(v.got.at(-1)).toMatchObject({ t: "error", error: expect.stringContaining("turned off") });
    expect(terms.size).toBe(0);
  });
  test("the shell does not inherit the agent's control channel", async () => {
    process.env.MSWEA_CONTROL_FILE = "/tmp/should-not-leak";
    const terms = make();
    const v = viewer();
    terms.open(v, "t-11", { cols: 80, rows: 24, cwd: dir });
    delete process.env.MSWEA_CONTROL_FILE;
    terms.input("t-11", "echo CTRL=[$MSWEA_CONTROL_FILE] ID=$MINITUI_WEB_TERMINAL_ID\r");
    expect(await until(() => v.text().includes("ID=t-11"))).toBe(true);
    expect(v.text()).toContain("CTRL=[]");
  });
});
