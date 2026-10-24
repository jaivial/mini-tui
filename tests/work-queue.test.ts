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

describe("@MESSAGE in a part's brief", () => {
  test("is the human's message, verbatim", async () => {
    const h = harness(2);
    h.q.create({ spec: { tasks: [spec("part one", "Do part one of:\n@MESSAGE"), spec("part two", "do part two")] } as never, message: "the parser drops `a\\nb` lines" });
    expect(h.q.get("t1")!.prompt).toBe("Do part one of:\nthe parser drops `a\\nb` lines");
  });
});

describe("the worker's directory", () => {
  test("falls back to the directory the human's message names", () => {
    const h = harness(1);
    h.q.create({ spec: spec("count words", "count the words in logs/app.log"), message: "Working directory: /tmp\n\ncount the words" });
    expect(h.q.get("t1")!.cwd).toBe("/tmp");
  });
});

describe("a single task without a prompt", () => {
  test("runs on the human's message verbatim plus the dispatcher's notes", () => {
    const h = harness(1);
    const r = h.q.create({ spec: { title: "fix limiter", description: "fix it", notes: "Verify: node --test" }, message: "the limiter in `lib.js` leaks a slot" });
    expect(r.ok).toBe(true);
    expect(h.q.get("t1")!.prompt).toBe("the limiter in `lib.js` leaks a slot\n\nVerify: node --test");
  });
  test("several tasks each need their own prompt", () => {
    const h = harness(1);
    const r = h.q.create({ spec: { tasks: [{ title: "a", description: "a" }, { title: "b", description: "b", prompt: "do b" }] } as never, message: "do a and b" });
    expect(r.ok).toBe(false);
  });
});

describe("a single task WITH a prompt", () => {
  test("still runs on the human's words first; the prompt becomes notes", () => {
    const h = harness(1);
    h.q.create({ spec: { title: "fix", description: "fix", prompt: "Fix the limiter by picking the highest tier" }, message: "fix the limiter" });
    expect(h.q.get("t1")!.prompt).toBe("fix the limiter\n\nDispatcher notes:\nFix the limiter by picking the highest tier");
  });
});

describe("malformed input from a model", () => {
  test("non-text fields are not coerced into text", () => {
    const h = harness(1);
    expect(h.q.create({ spec: { title: 42, description: {}, prompt: ["a"] } as never }).ok).toBe(false);
    expect(h.q.create({ spec: { tasks: [null, 5] } as never }).ok).toBe(false);
    expect(h.q.create({ spec: { tasks: "not a list", title: "t", description: "d", prompt: "p" } as never }).ok).toBe(true);
  });
  test("a redirect with no text, or to an unknown task, is refused", async () => {
    const h = harness(1);
    h.q.create({ spec: spec("index docs") });
    expect((await h.q.redirect("t1", "")).ok).toBe(false);
    expect((await h.q.redirect("nope", "x")).ok).toBe(false);
  });
  test("over 100 tasks in one call is refused", () => {
    const h = harness(1);
    const tasks = Array.from({ length: 101 }, (_, i) => spec(`t${i} unique words ${i}`));
    expect(h.q.create({ spec: { tasks } as never }).ok).toBe(false);
  });
});

describe("cancel while a worker is still starting", () => {
  test("the worker is stopped once its session exists, and the task stays cancelled", async () => {
    let release: (id: string) => void = () => {};
    const stopped: string[] = [];
    const host = {
      startWorker: () => new Promise<string>((r) => (release = r)),
      continueWorker: async () => {},
      workerRunning: () => true,
      messageWorker: () => {},
      stopWorker: (id: string) => void stopped.push(id),
      workerResult: () => ({ text: "", ok: true }),
      saveCard: () => {},
    };
    const q = new WorkQueue({ db: new Database(":memory:"), host, concurrency: () => 1, model: () => "m" });
    q.create({ spec: spec("slow start") });
    expect(q.get("t1")!.status).toBe("running");
    q.cancel("t1");
    release("s-late");
    await new Promise((r) => setTimeout(r, 5));
    expect(q.get("t1")!.status).toBe("cancelled");
    expect(stopped).toEqual(["s-late"]);
  });

  test("a worker that ends before its session id is saved still settles its task", async () => {
    const host = {
      startWorker: async () => "s-fast",
      continueWorker: async () => {},
      workerRunning: () => false,
      messageWorker: () => {},
      stopWorker: () => {},
      workerResult: () => ({ text: "all done", ok: true }),
      saveCard: () => {},
    };
    const q = new WorkQueue({ db: new Database(":memory:"), host, concurrency: () => 1, model: () => "m" });
    q.create({ spec: spec("fast one") });
    await new Promise((r) => setTimeout(r, 5));
    expect(q.get("t1")!).toMatchObject({ status: "done", result: "all done" });
  });
});

describe("one running task per directory tree", () => {
  test("overlaps: same dir and nested dirs overlap; home, /tmp and / overlap nothing", async () => {
    const { overlaps } = await import("../src/web/workQueue");
    const { homedir } = await import("node:os");
    expect(overlaps("/srv/app", "/srv/app")).toBe(true);
    expect(overlaps("/srv/app", "/srv/app/web")).toBe(true);
    expect(overlaps("/srv/app/", "/srv/app")).toBe(true);
    expect(overlaps("/srv/app", "/srv/application")).toBe(false);
    expect(overlaps(homedir(), `${homedir()}/proj`)).toBe(false);
    expect(overlaps("/tmp", "/tmp/x")).toBe(false);
    expect(overlaps(homedir(), homedir())).toBe(false);
  });

  test("a task in a busy directory waits; one elsewhere goes past it", async () => {
    const { mkdirSync } = await import("node:fs");
    for (const d of ["/tmp/wq-a", "/tmp/wq-a/sub", "/tmp/wq-b"]) mkdirSync(d, { recursive: true });
    const h = harness(5);
    h.q.create({ spec: { tasks: [
      { title: "edit a", description: "a", prompt: "edit things", cwd: "/tmp/wq-a" },
      { title: "edit a sub", description: "a/sub", prompt: "edit other things", cwd: "/tmp/wq-a/sub" },
      { title: "edit b", description: "b", prompt: "edit more", cwd: "/tmp/wq-b" },
    ] } as never });
    await h.settle();
    expect([h.q.get("t1")!.status, h.q.get("t2")!.status, h.q.get("t3")!.status]).toEqual(["running", "queued", "running"]);
    h.finish(h.q.get("t1")!);
    await h.settle();
    expect(h.q.get("t2")!.status).toBe("running");
  });
});

describe("the model a task runs on", () => {
  test("is the chat's model when the task is created; tasks already launched keep theirs", async () => {
    let current = "a/one";
    const started: string[] = [];
    const host = {
      startWorker: async (t: QueueTask) => (started.push(t.model), "s" + started.length),
      continueWorker: async () => {},
      workerRunning: () => true,
      messageWorker: () => {},
      stopWorker: () => {},
      workerResult: () => ({ text: "", ok: true }),
      saveCard: () => {},
    };
    const q = new WorkQueue({ db: new Database(":memory:"), host, concurrency: () => 5, model: () => current });
    q.create({ spec: spec("first job") });
    current = "b/two";
    q.create({ spec: spec("second job") });
    await new Promise((r) => setTimeout(r, 5));
    expect(q.get("t1")!.model).toBe("a/one");
    expect(q.get("t2")!.model).toBe("b/two");
    expect(started).toEqual(["a/one", "b/two"]);
  });
});
