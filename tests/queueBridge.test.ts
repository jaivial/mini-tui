/**
 * End-to-end harness for the chat ↔ queue bridge (WA-3), against the real
 * ChannelInbox (bind/accept) and a fake queue binary: directives in a session
 * reply become durable queue tasks, queue outcomes come back to the originating
 * thread only, follow-up routing is deterministic, and a fenced interrupt is
 * retried only after the worker-stopped event — with `--reconciled yes`.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { ChannelInbox, type Inbound } from "../src/channels/inbox";
import { QueueBridge, parseDirectives } from "../src/channels/queueBridge";
import type { EvoSender } from "../src/channels/evoSend";
import type { PendingRow } from "../src/channels/consumer";
import { makeFakeQueue, readQueueState, setScenario, writeQueueState, type QueueScenario } from "./helpers/fake-queue";

const THREAD = "34692747052@s.whatsapp.net";
const SENDER = "242554100576489@lid";
const ACCOUNT = "evo";
const PROJECT = "mini-tui";

let homeBackup: string | undefined;
let dir: string;
let n = 0;

// ── Fakes ──

function fakeSender(): EvoSender & { sent: Array<{ number: string; text: string; quotedId: string | null }> } {
  const sent: Array<{ number: string; text: string; quotedId: string | null }> = [];
  return {
    sent,
    async sendText(args) {
      const id = `w-${sent.length + 1}`;
      sent.push({ number: args.number, text: args.text, quotedId: args.quoted?.id ?? null });
      return { kind: "sent", replyId: id };
    },
    async recentOutgoing(thread, limit = 50) {
      return sent.filter((s) => s.number === thread).slice(-limit).map((s, i) => ({ id: `w-${i + 1}`, text: s.text, quotedStanzaId: s.quotedId, ts: Date.now() / 1000 }));
    },
    async sendImage(args) {
      const id = `w-img-${sent.length + 1}`;
      sent.push({ number: args.number, text: "[[image]]", quotedId: null });
      return { kind: "sent", replyId: id };
    },
    async sendDocument(args) {
      const id = `w-doc-${sent.length + 1}`;
      sent.push({ number: args.number, text: "[[document]]", quotedId: null });
      return { kind: "sent", replyId: id };
    },
  };
}

/** Deferred bridge work (routeFollowup/reportStatus) is fire-and-forget in the
 * consumer; tests wait for its observable effect instead of a handle. */
async function waitUntil(what: string, cond: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await Bun.sleep(25);
  }
}

interface Harness {
  dir: string;
  inbox: ChannelInbox;
  sender: ReturnType<typeof fakeSender>;
  bridge: QueueBridge;
  queue: ReturnType<typeof makeFakeQueue>;
  graphDb: string;
  message(text: string, id: string): Inbound;
  accept(text: string, id: string): { seq: number };
  /** The accepted inbox row, exactly as the consumer would read it. */
  rowForAccepted(messageId: string): PendingRow;
}

function makeHarness(scenario: QueueScenario = {}, options: { reconcileTimeoutS?: number; reconcileSettleMs?: number; embedDir?: string } = {}): Harness {
  n += 1;
  const hdir = join(dir, `h${n}`); // isolated scenario + call log per harness
  const inbox = new ChannelInbox(join(hdir, "channels.sqlite"));
  inbox.bind({ channel: "whatsapp", account: ACCOUNT, thread: THREAD, session: "sess-1", project: PROJECT, allowedSenders: [SENDER] });
  const sender = fakeSender();
  const queue = makeFakeQueue(hdir, scenario);
  const graphDb = join(hdir, "graph.sqlite");
  process.env.MINITUI_TASK_GRAPH_DB = graphDb;
  const bridge = new QueueBridge({
    db: inbox.db,
    sender,
    consumer: "queue-events",
    queueBin: queue.script,
    cwd: join(dir, "workdir"),
    pollMs: 60_000,
    reconcileTimeoutS: options.reconcileTimeoutS,
    reconcileSettleMs: options.reconcileSettleMs,
    embedDir: options.embedDir,
    log: () => {},
  });
  const message = (text: string, id: string): Inbound => ({
    channel: "whatsapp", account: ACCOUNT, thread: THREAD, messageId: id, sender: SENDER, sentAt: Date.now(), text, attachments: [],
  });
  return {
    dir: hdir,
    inbox,
    sender,
    bridge,
    queue,
    graphDb,
    message,
    accept(text, id) {
      return inbox.accept(message(text, id));
    },
    rowForAccepted(messageId): PendingRow {
      return inbox.db.query("SELECT seq,channel,account,thread,message_id,sent_at,payload,session,project FROM channel_inbox WHERE message_id=?1").get(messageId) as PendingRow;
    },
  };
}

/** The full reply→bridge path for one message: accept it through the real
 * ChannelInbox, plan the reply, run the deferred work, and let the creation
 * sweep land the `queue put` (the deferred sweep is fire-and-forget and
 * guarded, so wait for `creating` rows to resolve). */
async function plan(h: Harness, messageId: string, reply: string): Promise<{ text: string; seq: number; task: string }> {
  const { seq } = h.accept(reply, messageId);
  const planned = h.bridge.planReply(h.rowForAccepted(messageId), h.message(reply, messageId), reply);
  if (planned.after) await planned.after();
  await h.bridge.sweepCreatingTasks();
  await waitUntil("creation sweep", () => {
    const row = h.inbox.db.query("SELECT COUNT(*) AS c FROM channel_tasks WHERE state='creating'").get() as { c: number };
    return row.c === 0;
  });
  return { text: planned.text, seq, task: `chat-${seq}` };
}

/** accept + planReply only (no deferred work, no sweep): for sweep-level tests. */
function planIntent(h: Harness, messageId: string, reply: string): { seq: number; task: string } {
  const { seq } = h.accept(reply, messageId);
  h.bridge.planReply(h.rowForAccepted(messageId), h.message(reply, messageId), reply);
  return { seq, task: `chat-${seq}` };
}

const graph = (h: Harness) => readQueueState(h.graphDb);

beforeAll(() => {
  // Goal files go under $HOME/.local/share/mini-tui/queue-goals: keep them in the sandbox.
  homeBackup = process.env.HOME;
  dir = mkdtempSync(join(tmpdir(), "mini-tui-queue-bridge-"));
  process.env.HOME = dir;
});

afterAll(() => {
  process.env.HOME = homeBackup;
  process.env.MINITUI_TASK_GRAPH_DB = homeBackup === undefined ? undefined : process.env.MINITUI_TASK_GRAPH_DB;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// ── Directive parsing ──

describe("parseDirectives", () => {
  test("strips directives and keeps the visible text", () => {
    const parsed = parseDirectives("Lo apunto.\n\n[[mini-queue: arreglar el login]]");
    expect(parsed.text).toBe("Lo apunto.");
    expect(parsed.queue).toBe("arreglar el login");
    expect(parsed.status).toBeUndefined();
  });

  test("the last directive of a kind wins", () => {
    const parsed = parseDirectives("a [[mini-queue: primero]] b [[mini-queue: después]] [[mini-followup: nota]]");
    expect(parsed.queue).toBe("después");
    expect(parsed.followup).toBe("nota");
    expect(parsed.text).toBe("a  b");
  });

  test("[[mini-status]] carries no value", () => {
    const parsed = parseDirectives("estado:\n[[mini-status]]");
    expect(parsed.status).toBe(true);
    expect(parsed.text).toBe("estado:");
  });

  test("empty-valued queue/followup directives are dropped, not acted on", () => {
    const parsed = parseDirectives("x [[mini-queue: ]] [[mini-followup:]]");
    expect(parsed.queue).toBeUndefined();
    expect(parsed.followup).toBeUndefined();
    expect(parsed.text).toBe("x");
  });

  test("unterminated brackets are plain text, not directives", () => {
    const text = "esto [[mini-queue: no cierra";
    const parsed = parseDirectives(text);
    expect(parsed.queue).toBeUndefined();
    expect(parsed.text).toBe(text);
  });
});

// ── Task creation ──

describe("task creation", () => {
  test("planReply journals durable intent and the sweep puts it", async () => {
    const h = makeHarness();
    const { text, task } = await plan(h, "msg-7", "Lo hago.\n\n[[mini-queue: arreglar el bug del login]]");
    expect(text).toContain("Lo hago.");
    expect(text).toContain(task);
    expect(text).not.toContain("[[mini-queue");

    const row = h.inbox.db.query("SELECT * FROM channel_tasks WHERE task=?1").get(task) as any;
    expect(row.state).toBe("queued");
    expect(row.goal).toBe("arreglar el bug del login");
    expect(row.project).toBe(PROJECT);
    expect(row.thread).toBe(THREAD);

    const put = h.queue.calls().find((c) => c[0] === "put") as string[];
    expect(put[put.indexOf("--id") + 1]).toBe(task);
    expect(put[put.indexOf("--project") + 1]).toBe(PROJECT);
    const goalFile = put[put.indexOf("--goal-file") + 1];
    expect(readFileSync(goalFile, "utf8")).toBe("arreglar el bug del login");
    expect((statSync(goalFile).mode & 0o777).toString(8)).toBe("600");
  });

  test("no directive → no task, no queue call", async () => {
    const h = makeHarness();
    const { text } = await plan(h, "msg-3", "respuesta normal");
    expect(text).toBe("respuesta normal");
    expect(h.inbox.db.query("SELECT * FROM channel_tasks").all()).toEqual([]);
    expect(h.queue.calls()).toEqual([]);
  });

  test("a failed put stays `creating` with attempts bumped, then recovers", async () => {
    const h = makeHarness({ failPut: true });
    const { seq, task } = planIntent(h, "msg-4", "hi [[mini-queue: goal]]");
    await h.bridge.sweepCreatingTasks();
    let row = h.inbox.db.query("SELECT * FROM channel_tasks WHERE task=?1").get(task) as any;
    expect(row.state).toBe("creating");
    expect(row.attempts).toBe(1);

    setScenario(h.dir, { failPut: false });
    await h.bridge.sweepCreatingTasks();
    row = h.inbox.db.query("SELECT * FROM channel_tasks WHERE task=?1").get(task) as any;
    expect(row.state).toBe("queued");
  });

  test("concurrent sweeps put the intent exactly once", async () => {
    const h = makeHarness({ putSleepMs: 250 });
    const { task } = planIntent(h, "msg-5", "hi [[mini-queue: goal]]");
    await Promise.all([h.bridge.sweepCreatingTasks(), h.bridge.sweepCreatingTasks()]);
    expect(h.queue.calls().filter((c) => c[0] === "put")).toHaveLength(1);
    expect(graph(h).tasks[task].status).toBe("pending");
  });
});

// ── Queue outcomes back to the thread ──

describe("event delivery", () => {
  const seedMapping = async (h: Harness) => plan(h, "msg-7", "ok [[mini-queue: construir la funcionalidad]]");

  test("done is delivered to the creating thread, quoted; the cursor passes it", async () => {
    const h = makeHarness();
    const { task } = await seedMapping(h);
    writeQueueState(h.graphDb, (s) => {
      s.tasks[task].status = "done";
      s.tasks[task].events.push({ seq: ++s.seq, task, kind: "state_changed", status: "done" });
    });
    await (h.bridge as any).consumeQueueEvents();
    expect(h.sender.sent).toHaveLength(1);
    expect(h.sender.sent[0].text).toContain(`✅ ${task} terminada`);
    expect(h.sender.sent[0].quotedId).toBe("msg-7");
    const cursor = (h.inbox.db.query("SELECT cursor FROM queue_event_consumers WHERE consumer='queue-events'").get() as any).cursor;
    expect(cursor).toBeGreaterThan(0);

    await (h.bridge as any).consumeQueueEvents();
    expect(h.sender.sent).toHaveLength(1); // dedupe: no second delivery
  });

  test("an event with no chat mapping is skipped, never delivered anywhere", async () => {
    const h = makeHarness();
    await seedMapping(h);
    writeQueueState(h.graphDb, (s) => {
      s.tasks["ext-99"] = { id: "ext-99", project: "otro", cwd: "/tmp", goal: "x", status: "done", owner: null, fence: 0, lease_until: null, result: null, goal_version: 1, events: [] };
      s.tasks["ext-99"].events.push({ seq: ++s.seq, task: "ext-99", kind: "state_changed", status: "done" });
    });
    await (h.bridge as any).consumeQueueEvents();
    expect(h.sender.sent).toEqual([]);
    // The cursor moved past the unmapped event (replay doesn't resend it).
    const cursor = (h.inbox.db.query("SELECT cursor FROM queue_event_consumers").get() as any)?.cursor ?? 0;
    expect(cursor).toBeGreaterThan(0);
  });

  test("blocked carries the task's result reason", async () => {
    const h = makeHarness();
    const { task } = await seedMapping(h);
    writeQueueState(h.graphDb, (s) => {
      s.tasks[task].status = "blocked";
      s.tasks[task].result = "tests fallan en CI";
      s.tasks[task].events.push({ seq: ++s.seq, task, kind: "state_changed", status: "blocked" });
    });
    await (h.bridge as any).consumeQueueEvents();
    expect(h.sender.sent).toHaveLength(1);
    expect(h.sender.sent[0].text).toContain(`⚠️ ${task} bloqueada`);
    expect(h.sender.sent[0].text).toContain("tests fallan en CI");
  });

  test("running chatter is not delivered", async () => {
    const h = makeHarness();
    const { task } = await seedMapping(h);
    writeQueueState(h.graphDb, (s) => {
      s.tasks[task].status = "running";
      s.tasks[task].events.push({ seq: ++s.seq, task, kind: "state_changed", status: "running" });
    });
    await (h.bridge as any).consumeQueueEvents();
    expect(h.sender.sent).toEqual([]);
  });
});

// ── Follow-up routing ──

describe("followup routing", () => {
  const seedTask = (h: Harness, id: string, status = "pending", goal = "objetivo original") =>
    writeQueueState(h.graphDb, (s) => {
      s.tasks[id] = { id, project: PROJECT, cwd: "/tmp", goal, status, owner: null, fence: 0, lease_until: null, result: null, goal_version: 2, events: [] };
    });
  const mapTask = (h: Harness, id: string, seq: number) =>
    h.inbox.db.query("INSERT INTO channel_tasks(task,inbox_seq,channel,account,thread,session,project,cwd,goal,state,attempts,created_at,updated_at) VALUES(?1,?2,'whatsapp',?3,?4,'sess-1',?5,'/tmp','g','queued',0,1,2)").run(id, seq, ACCOUNT, THREAD, PROJECT);

  test("explicit id wins and amends with the current goal version", async () => {
    const h = makeHarness();
    seedTask(h, "chat-9");
    await plan(h, "msg-10", "ok [[mini-followup: añade tests de regresión chat-9]]");
    await waitUntil("amend call", () => h.queue.calls().some((c) => c[0] === "amend"));
    const amend = h.queue.calls().find((c) => c[0] === "amend") as string[];
    expect(amend[amend.indexOf("--id") + 1]).toBe("chat-9");
    expect(amend[amend.indexOf("--goal-version") + 1]).toBe("2");
    await waitUntil("thread note", () => h.sender.sent.some((s) => s.text.includes("Añadido a chat-9")));
    expect(graph(h).tasks["chat-9"].goal_version).toBe(3);
  });

  test("a followup pointing at another project's task is refused in-thread", async () => {
    const h = makeHarness();
    seedTask(h, "ext-1");
    writeQueueState(h.graphDb, (s) => { s.tasks["ext-1"].project = "backoffice"; });
    await plan(h, "msg-11", "ok [[mini-followup: ext-1 cambia esto]]");
    await waitUntil("refusal note", () => h.sender.sent.some((s) => s.text.includes("pertenece al proyecto")));
    expect(h.queue.calls().some((c) => c[0] === "amend")).toBe(false);
  });

  test("two plausible open candidates → the bridge asks, never amends on a hunch", async () => {
    const h = makeHarness();
    seedTask(h, "chat-3", "pending", "migrar la base de datos");
    seedTask(h, "chat-4", "pending", "migrar el caché de sesiones");
    mapTask(h, "chat-3", 3);
    mapTask(h, "chat-4", 4);
    await plan(h, "msg-12", "ok [[mini-followup: sobre la migración, falta lo del índice]]");
    await waitUntil("ask note", () => h.sender.sent.some((s) => s.text.includes("podría encajar en varias tareas")));
    expect(h.queue.calls().some((c) => c[0] === "amend")).toBe(false);
    const ask = h.sender.sent.find((s) => s.text.includes("podría encajar en varias tareas"))!;
    expect(ask.text).toContain("chat-3");
    expect(ask.text).toContain("chat-4");
  });

  test("with embeddings, one clear winner is amended without asking", async () => {
    const h = makeHarness({ searchResults: [{ id: "chat-3", similarity: 0.82 }, { id: "chat-4", similarity: 0.4 }] }, { embedDir: "/tmp/fake-minilm" });
    seedTask(h, "chat-3", "pending", "migrar la base de datos");
    seedTask(h, "chat-4", "pending", "migrar el caché de sesiones");
    mapTask(h, "chat-3", 3);
    mapTask(h, "chat-4", 4);
    await plan(h, "msg-12", "ok [[mini-followup: la migración de la base de datos necesita el índice nuevo]]");
    await waitUntil("amend call", () => h.queue.calls().some((c) => c[0] === "amend"));
    const amend = h.queue.calls().find((c) => c[0] === "amend") as string[];
    expect(amend[amend.indexOf("--id") + 1]).toBe("chat-3");
    await waitUntil("thread note", () => h.sender.sent.some((s) => s.text.includes("Añadido a chat-3")));
  });

  test("a refused amend is surfaced honestly, not retried blind", async () => {
    const h = makeHarness({ amendError: "goal version stale for chat-9" });
    seedTask(h, "chat-9");
    await plan(h, "msg-13", "ok [[mini-followup: chat-9 esto]]");
    await waitUntil("refused note", () => h.sender.sent.some((s) => s.text.includes("No pude actualizar chat-9")));
    expect(h.queue.calls().filter((c) => c[0] === "amend")).toHaveLength(1); // one attempt, never blind-retried
  });

  test("no open candidates → the bridge says so and offers queueing", async () => {
    const h = makeHarness();
    await plan(h, "msg-14", "ok [[mini-followup: lo que sea]]");
    await waitUntil("no-candidates note", () => h.sender.sent.some((s) => s.text.includes("No hay tareas abiertas del proyecto")));
  });
});

// ── Fenced interrupt + reconcile ──

describe("reconcile of a running-task amendment", () => {
  const seedRunning = (h: Harness) =>
    writeQueueState(h.graphDb, (s) => {
      s.tasks["chat-9"] = { id: "chat-9", project: PROJECT, cwd: "/tmp", goal: "trabajo largo", status: "running", owner: "wa-chat-lane", fence: 3, lease_until: Date.now() + 60_000, result: null, goal_version: 2, events: [] };
    });
  const mapRunning = (h: Harness) =>
    h.inbox.db.query("INSERT INTO channel_tasks(task,inbox_seq,channel,account,thread,session,project,cwd,goal,state,attempts,created_at,updated_at) VALUES('chat-9',9,'whatsapp',?1,?2,'sess-1',?3,'/tmp','trabajo largo','queued',0,1,2)").run(ACCOUNT, THREAD, PROJECT);

  test("retry happens only after the worker-stopped event — and carries --reconciled yes", async () => {
    const h = makeHarness({}, { reconcileTimeoutS: 0, reconcileSettleMs: 0 });
    seedRunning(h);
    mapRunning(h);
    await plan(h, "msg-15", "ok [[mini-followup: chat-9 cambia el enfoque]]");
    // The fake queue fenced the running task: the amend itself emitted interrupted.
    expect(graph(h).tasks["chat-9"].status).toBe("interrupted");
    await (h.bridge as any).reconcileRunningAmendments();
    const retry = h.queue.calls().find((c) => c[0] === "retry") as string[];
    expect(retry[retry.indexOf("--id") + 1]).toBe("chat-9");
    expect(retry[retry.indexOf("--reconciled") + 1]).toBe("yes");
    expect(graph(h).tasks["chat-9"].status).toBe("pending");
    expect(h.sender.sent.some((s) => s.text.includes("relanzamiento falló"))).toBe(false);
  });
  test("the queue itself refuses a flagless retry of an interrupted task", async () => {
    // Guards the `retry --id` fix: without --reconciled the real (and fake)
    // queue refuses, so the bridge MUST always pass --reconciled yes here.
    const h = makeHarness({}, { reconcileTimeoutS: 0 });
    seedRunning(h);
    await (h.bridge as any).reconcileRunningAmendments(); // nothing registered: no calls
    expect(h.queue.calls().some((c) => c[0] === "retry")).toBe(false);
    const { queueCommand } = await import("../src/mini/queue");
    const result = await queueCommand(["retry", "--id", "chat-9"], undefined, { bin: h.queue.script });
    expect(result.code).not.toBe(0);
    expect(result.error).toContain("--reconciled");
  });

  test("timeout without a worker-stopped event → operator note, no relaunch", async () => {
    const h = makeHarness({}, { reconcileTimeoutS: 0 });
    writeQueueState(h.graphDb, (s) => {
      s.tasks["chat-9"] = { id: "chat-9", project: PROJECT, cwd: "/tmp", goal: "trabajo", status: "interrupted", owner: null, fence: 4, lease_until: null, result: null, goal_version: 3, events: [] };
    });
    mapRunning(h);
    // The amendment happened in a previous process lifetime: only the pending
    // reconcile registration carries over.
    (h.bridge as any).reconciles.set("chat-9", { startedAt: Date.now() });
    await (h.bridge as any).reconcileRunningAmendments();
    expect(h.queue.calls().some((c) => c[0] === "retry")).toBe(false);
    expect(h.sender.sent.some((s) => s.text.includes("no ha confirmado su parada"))).toBe(true);
  });
});

// ── Status reporting ──

describe("status reporting", () => {
  test("[[mini-status]] reports open and recent tasks to the thread", async () => {
    const h = makeHarness();
    writeQueueState(h.graphDb, (s) => {
      s.tasks["chat-9"] = { id: "chat-9", project: PROJECT, cwd: "/tmp", goal: "trabajo largo\nsegunda línea", status: "running", owner: "wa-chat-lane", fence: 1, lease_until: Date.now() + 60_000, result: null, goal_version: 2, events: [] };
    });
    await plan(h, "msg-16", "estado:\n[[mini-status]]");
    await waitUntil("status note", () => h.sender.sent.some((s) => s.text.includes("chat-9")));
    const note = h.sender.sent.find((s) => s.text.includes("chat-9"))!;
    expect(note.text).toContain("[running] v2");
    expect(note.text).toContain("trabajo largo");
    expect(note.text).toContain("worker wa-chat-lane");
  });
});
