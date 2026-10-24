import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { clampConcurrency, similarity, WorkQueue, type QueueTask, type WorkerHost } from "../src/web/workQueue";

/** A fake session layer: workers "run" until the test ends them. */
function harness(concurrency = 2) {
  const running = new Set<string>();
  const messages: Array<[string, string]> = [];
  const continued: Array<[string, string]> = [];
  const results = new Map<string, { text: string; ok: boolean }>();
  let n = 0;
  const host: WorkerHost = {
    startWorker: async () => {
      const id = `s${++n}`;
      running.add(id);
      return id;
    },
    continueWorker: async (id, message) => {
      running.add(id);
      continued.push([id, message]);
    },
    workerRunning: (id) => running.has(id),
    messageWorker: (id, message) => void messages.push([id, message]),
    stopWorker: (id) => void running.delete(id),
    workerResult: (id) => results.get(id) ?? { text: "ok", ok: true },
    saveCard: () => {},
  };
  let conc = concurrency;
  const q = new WorkQueue({ db: new Database(":memory:"), host, concurrency: () => conc, model: () => "m/x", defaultCwd: () => "/tmp" });
  const finish = (task: QueueTask, ok = true) => {
    running.delete(task.sessionId);
    results.set(task.sessionId, { text: ok ? "done it" : "broke", ok });
    q.workerExited(task.sessionId, ok ? "done" : "error");
  };
  const settle = () => new Promise((r) => setTimeout(r, 5));
  return { q, running, messages, continued, finish, settle, setConcurrency: (c: number) => (conc = c) };
}

const spec = (title: string, prompt = `${title} — do the thing`) => ({ title, description: title, prompt });

describe("the work queue", () => {
  test("concurrency is clamped to 1..300 and defaults to 300", () => {
    expect(clampConcurrency(undefined)).toBe(300);
    expect(clampConcurrency(0)).toBe(1);
    expect(clampConcurrency(1000)).toBe(300);
    expect(clampConcurrency(5)).toBe(5);
  });

  test("8 tasks at concurrency 5: 5 run, 3 wait, and a free slot takes the next one", async () => {
    const h = harness(5);
    const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
    const r = h.q.create({ spec: { tasks: words.map((w) => spec(`build ${w} widget`, `create the ${w} module in its own folder`)) } as never });
    expect(r.ok).toBe(true);
    await h.settle();
    expect(h.q.counts()).toMatchObject({ running: 5, queued: 3 });
    const first = h.q.list().find((t) => t.status === "running")!;
    h.finish(first);
    await h.settle();
    expect(h.q.counts()).toMatchObject({ running: 5, queued: 2, done: 1 });
    // FIFO: the oldest queued task is the one that started.
    expect(h.q.get("t6")!.status).toBe("running");
  });

  test("raising the concurrency starts waiting work at once", async () => {
    const h = harness(1);
    h.q.create({ spec: { tasks: [spec("parse apache logs"), spec("render svg charts"), spec("write release notes")] } as never });
    await h.settle();
    expect(h.q.counts().running).toBe(1);
    h.setConcurrency(3);
    h.q.resize();
    await h.settle();
    expect(h.q.counts().running).toBe(3);
  });

  test("a near-duplicate of an active task is refused with that task's id", async () => {
    const h = harness(2);
    h.q.create({ spec: spec("report of users in /etc/passwd", "write report.json with the number of users and the distinct shells from /etc/passwd") });
    await h.settle();
    const dup = h.q.create({ spec: spec("passwd users report", "write report.json with the number of users and distinct shells from /etc/passwd, sorted") });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.duplicateOf).toBe("t1");
    // Forced: it is created.
    expect(h.q.create({ spec: { ...spec("passwd users report", "write report.json with the number of users and distinct shells from /etc/passwd"), new_task: true } }).ok).toBe(true);
  });

  test("redirect: a running worker gets the message; a finished task is re-opened on its own session", async () => {
    const h = harness(2);
    h.q.create({ spec: spec("compress images folder") });
    await h.settle();
    const t = h.q.get("t1")!;
    expect((await h.q.redirect("t1", "also strip EXIF")).ok).toBe(true);
    expect(h.messages).toEqual([[t.sessionId, "[redirect from the dispatcher] also strip EXIF"]]);
    h.finish(h.q.get("t1")!);
    expect(h.q.get("t1")!.status).toBe("done");
    await h.q.redirect("t1", "and keep a backup");
    await h.settle();
    const after = h.q.get("t1")!;
    expect(after.status).toBe("running");
    expect(after.attempts).toBe(2);
    expect(after.sessionId).toBe(t.sessionId);
    expect(h.continued[0]![1]).toContain("and keep a backup");
  });

  test("a queued task's redirect is folded into its brief when it starts", async () => {
    const h = harness(1);
    h.q.create({ spec: { tasks: [spec("first long job"), spec("second job of the day")] } as never });
    await h.settle();
    await h.q.redirect("t2", "use python 3.12");
    expect(h.q.get("t2")!.status).toBe("queued");
    expect(h.q.get("t2")!.redirects).toEqual(["use python 3.12"]);
  });

  test("cancel stops a running worker and frees its slot", async () => {
    const h = harness(1);
    h.q.create({ spec: { tasks: [spec("index the docs"), spec("lint the repo")] } as never });
    await h.settle();
    const t1 = h.q.get("t1")!;
    expect(h.q.cancel("t1").ok).toBe(true);
    expect(h.running.has(t1.sessionId)).toBe(false);
    await h.settle();
    expect(h.q.get("t2")!.status).toBe("running");
  });

  test("worker card updates change the description only; recover() requeues what was running", async () => {
    const h = harness(2);
    h.q.create({ spec: spec("migrate the database") });
    await h.settle();
    h.q.update("t1", "copying table users (3 of 9)");
    expect(h.q.get("t1")!).toMatchObject({ title: "migrate the database", description: "copying table users (3 of 9)" });
    h.running.clear();
    h.q.recover();
    await h.settle();
    expect(h.q.get("t1")!).toMatchObject({ status: "running", attempts: 2 });
  });

  test("the dispatcher's queue state names the closest tasks to a new message", async () => {
    const h = harness(5);
    h.q.create({ spec: { tasks: [spec("fix the login page css", "the login button overlaps the form on mobile"), spec("benchmark sqlite inserts")] } as never });
    await h.settle();
    const state = h.q.queueState("the login form still overlaps on small screens");
    expect(state).toContain("<queue_state>");
    expect(state).toMatch(/closest tasks[\s\S]*t1/);
  });

  test("similarity ranks the matching document first", () => {
    const s = similarity("shells in /etc/passwd", ["render a chart", "count shells in /etc/passwd", "zip the logs"]);
    expect(s.indexOf(Math.max(...s))).toBe(1);
  });
});

describe("dirIn", () => {
  test("finds the working directory a brief names", async () => {
    const { dirIn } = await import("../src/web/workQueue");
    expect(dirIn("Working directory: /tmp\n\nfix it")).toBe("/tmp");
    expect(dirIn("edit /tmp/definitely-not-here-xyz/a.js")).toBe("");
  });
});

describe("@MESSAGE in a brief", () => {
  test("is the human's message, verbatim", async () => {
    const h = harness(1);
    h.q.create({ spec: spec("fix the parser", "Goal: fix it.\n\n@MESSAGE\n\nVerify: run tests"), message: "the parser drops `a\\nb` lines" });
    expect(h.q.get("t1")!.prompt).toBe("Goal: fix it.\n\nthe parser drops `a\\nb` lines\n\nVerify: run tests");
  });
});

describe("the worker's directory", () => {
  test("falls back to the directory the human's message names", () => {
    const h = harness(1);
    h.q.create({ spec: spec("count words", "count the words in logs/app.log"), message: "Working directory: /tmp\n\ncount the words" });
    expect(h.q.get("t1")!.cwd).toBe("/tmp");
  });
});
