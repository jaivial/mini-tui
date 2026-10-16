/**
 * A turn that fails must report WHY it failed — never an operator diagnostic that happens to be
 * the last line the agent wrote.
 *
 * The bug this pins, from production (seq=59, 2026-10-16, session wa-mini-assistant-8bfe4ead):
 * the bot was asked to look into a duplicate-task bug in the backoffice, attempt 1 died of
 * TimeExceeded, and attempt 2 resumed the session, collapsed the copies the dead turn left behind
 * (the E4 fix working) and printed a WARNING about it. That warning went to stderr, the headless
 * runner turns the log's tail into the result's `error`, and the consumer pastes `error` into the
 * note. So the user read:
 *
 *   (mini could not complete this turn: WARNING: the resumed session already held 1 unfinished
 *    copy of this task; collapsing them into one)
 *
 * which names a fix, not a failure, and hides the wall-clock limit that actually killed the turn.
 *
 * The fake agent reproduces that byte for byte: once the session has history (so the runner resumes
 * it) it prints the collapse notice to stderr, and the turn ends with TimeExceeded instead of an
 * answer. The assertions are on the TEXT THE USER READS, because that is the thing that was wrong.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import { ChannelInbox, type Inbound } from "../src/channels/inbox";
import { startChannelConsumer } from "../src/channels/consumer";
import { SendLedger, type EvoSender } from "../src/channels/evoSend";
import { describeTurnFailure, isTurnFailureNote, replyLanguage, stripTurnDiagnostics, turnFailureNote } from "../src/turnFailure";

const SENDER = "242554100576489@lid";
const ACCOUNT = "mini-assistant";
const GROUP = "120363411180584976@g.us";
const SESSION = "wa-mini-assistant-8bfe4ead";

const envBackup = { ...process.env };
const made: string[] = [];

afterAll(() => {
  process.env = envBackup;
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** The agent of the run that produced the bug: on a RESUMED turn (the runner only resumes once the
 * session holds history, which the first attempt's save created) it prints the collapse notice to
 * stderr exactly as agent-rs did, and it ends with the given exit status instead of an answer. */
function collapsingAgent(at: string, options: { collapseNotice: string; answer: boolean; exitStatus: string }) {
  mkdirSync(at, { recursive: true });
  const log = join(at, "calls.jsonl");
  const script = join(at, "mini");
  Bun.write(
    script,
    `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const out = at("-o"), resume = at("--resume"), task = at("-t") ?? "";
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ resume }) + "\\n");
let resumed = [];
try { if (resume) resumed = JSON.parse(readFileSync(resume, "utf8")).messages ?? []; } catch {}
// The E4 collapse, and the notice agent-rs printed about it. It goes to stderr, which the runner
// captures into the same log the error text is read from. Only a RESUMED turn can collapse.
if (resume) console.error(${JSON.stringify(options.collapseNotice)});
const journal = out.replace(/\\.json$/, ".jsonl");
const line = (o) => JSON.stringify(o) + "\\n";
// The real turn's session already held the dead attempt's copy of the task; keeping it in the
// replayed history is what makes the resumed turn a collapse in the first place.
const messages = resume ? [...resumed, { role: "user", content: "The user added a new task: " + task }] : [{ role: "system", content: "system" }, { role: "user", content: task }];
const answers = ${options.answer ? "true" : "false"};
if (answers) messages.push({ role: "assistant", content: "respuesta del bot" });
const info = answers
  ? { model_stats: { instance_cost: 0.01, api_calls: 2 }, exit_status: "Submitted", submission: "ok" }
  : { model_stats: { instance_cost: 0.01, api_calls: 3 }, exit_status: ${JSON.stringify(options.exitStatus)} };
writeFileSync(journal, line({ t: "meta", trajectory_format: "mini-swe-agent-1.1" }) + messages.map((m) => line({ t: "msg", m })).join("") + line({ t: "info", i: info }));
`,
  );
  chmodSync(script, 0o755);
  return script;
}

/** Drive one message through the real consumer and return what the user would have read.
 *
 * `history` is what the thread already held before this message: real prior turns, which is how the
 * language of a conversation is established. They go in through the same inbox the live consumer uses,
 * so the note sees the same thread a real user would. */
async function turn(senderText: string, options: { collapseNotice: string; answer?: boolean; exitStatus: string; maxTurnAttempts?: number; history?: string[] }): Promise<{ reply: string; calls: number }> {
  const dir = mkdtempSync(join(tmpdir(), "turn-failure-"));
  made.push(dir);
  const inbox = new ChannelInbox(join(dir, "channels.sqlite"));
  inbox.bind({ channel: "whatsapp", account: ACCOUNT, thread: GROUP, session: SESSION, project: "wa-assistant", allowedSenders: [SENDER], policy: "all", model: "" });

  // Prior turns, oldest first. Each one is acknowledged in turn, because `acknowledge` demands the
  // caller's expected cursor: the history must sit BEHIND the consumer's cursor, or the turn under
  // test would be the fourth message instead of the first.
  let cursor = 0;
  for (const [i, text] of (options.history ?? []).entries()) {
    inbox.accept({ channel: "whatsapp", account: ACCOUNT, thread: GROUP, messageId: `hist-${i}`, sender: SENDER, sentAt: Date.now() - (options.history!.length - i) * 1000, text, attachments: [] });
    inbox.acknowledge("test-consumer", cursor, { seq: cursor + 1, session: SESSION, project: "wa-assistant" });
    cursor = i + 1;
  }

  const sent: string[] = [];
  const sender: EvoSender = {
    sendText: async ({ text }: { text: string }) => {
      sent.push(text);
      return { kind: "sent", replyId: `r${sent.length}` };
    },
    sendImage: async () => ({ kind: "sent", replyId: "r-img" }),
    recentOutgoing: async () => [],
  } as unknown as EvoSender;

  process.env.MINITUI_MINI_BIN = collapsingAgent(join(dir, "agent"), { collapseNotice: options.collapseNotice, answer: options.answer ?? false, exitStatus: options.exitStatus });
  process.env.MINITUI_EMBEDDED_AGENT = "0";
  process.env.MINITUI_DB_PATH = join(dir, "sessions.sqlite");
  process.env.MINITUI_NO_TITLE = "1";
  process.env.MINI_CHANNEL_SUBJECT = "";

  const consumer = startChannelConsumer({
    inbox,
    sender,
    ledger: new SendLedger(inbox.db),
    consumer: "test-consumer",
    sessionsDbPath: join(dir, "sessions.sqlite"),
    cwd: dir,
    model: "",
    idleMs: 20,
    maxTurnAttempts: options.maxTurnAttempts ?? 3,
    log: () => {},
  });
  const message: Inbound = { channel: "whatsapp", account: ACCOUNT, thread: GROUP, messageId: "e2e-fail", sender: SENDER, sentAt: Date.now(), text: senderText, attachments: [] };
  inbox.accept(message);

  const deadline = Date.now() + 30_000;
  while (!sent.length && Date.now() < deadline) await Bun.sleep(50);
  consumer.stop();
  await consumer.done;

  expect(sent.length).toBeGreaterThan(0);
  return { reply: sent[sent.length - 1]!, calls: 0 };
}

const COLLAPSE = "[turn] resumed session held 1 unfinished copy of this task; collapsed into one";
// What the PREVIOUS binary printed, and what a mixed-version rollout can still leave in the log.
const LEGACY = "WARNING: the resumed session already held 1 unfinished copy of this task; collapsing them into one";

/** Real messages from the QA group (120363411180584976@g.us), which is entirely Spanish. */
const SPANISH_THREAD = [
  "Estás trabajando en la versión anti bot de cu",
  "Estás en ello?",
  "Confirma con el nombre del modelo que estas usando ahora mismo.",
  "Muchas gracias, genial, ya lo hearé",
  "Vale pues continúa con esto con la nueva versión de cu",
  "prueba",
  "Responde solo con: TOKENHARBOR-ACTIVO",
];
/** An English thread decides for itself: the note follows the conversation it lands in. */
const ENGLISH_THREAD = [
  "please check the duplicate task bug",
  "can you help me with the backoffice issue",
  "thanks for the quick fix",
  "what time is it",
];

describe("a failed turn reports the cause, not the agent's diagnostics", () => {
  test("a turn that dies of TimeExceeded after a collapse says so, never 'unfinished copy'", async () => {
    const { reply } = await turn("Reviso el fallo de duplicado en los arroces del backoffice", {
      collapseNotice: COLLAPSE,
      exitStatus: "TimeExceeded",
    });
    expect(reply).not.toContain("unfinished copy");
    expect(reply).not.toContain("collapsing them into one");
    expect(reply).not.toContain("WARNING");
    expect(reply).toContain("tiempo límite");
  });

  test("the same holds for the OLD notice wording still in the log during a rollout", async () => {
    const { reply } = await turn("Reviso el fallo de duplicado en los arroces del backoffice", {
      collapseNotice: LEGACY,
      exitStatus: "TimeExceeded",
    });
    expect(reply).not.toContain("unfinished copy");
    expect(reply).toContain("tiempo límite");
  });

  test("a turn that WORKS after a collapse never mentions the collapse", async () => {
    const { reply } = await turn("Reviso el fallo de duplicado en los arroces del backoffice", {
      collapseNotice: COLLAPSE,
      answer: true,
      exitStatus: "TimeExceeded",
      maxTurnAttempts: 2,
    });
    expect(reply).toBe("respuesta del bot");
    expect(reply).not.toContain("unfinished copy");
    expect(reply).not.toContain("collapsing");
  });

  test("an English sender is answered in English", async () => {
    const { reply } = await turn("please check the duplicate task bug in the backoffice", {
      collapseNotice: COLLAPSE,
      exitStatus: "TimeExceeded",
      history: ENGLISH_THREAD,
    });
    expect(reply).toContain("ran out of time");
    expect(reply).not.toContain("tiempo límite");
  });

  // This is the live QA finding of 2026-10-16, verbatim. The group 120363411180584976@g.us had twenty
  // consecutive Spanish messages, and the failing line was "di hola y nada mas" — no accent, no ñ,
  // no ñ-decodable function word in any quantity. Guessed from that line alone, the note came back
  // English, inside a conversation the reader never left.
  test("a short accentless line in a Spanish THREAD is answered in Spanish", async () => {
    const { reply } = await turn("di hola y nada mas", {
      collapseNotice: COLLAPSE,
      exitStatus: "TimeExceeded",
      history: SPANISH_THREAD,
    });
    expect(reply).toContain("tiempo límite");
    expect(reply).not.toContain("ran out of time");
  });
});

describe("the diagnostics filter and the note it feeds", () => {
  test("a tail of pure diagnostics yields no cause at all, so the exit status is used", () => {
    expect(stripTurnDiagnostics("[turn] resumed session held 1 unfinished copy of this task; collapsed into one")).toBe("");
    expect(stripTurnDiagnostics("WARNING: the resumed session already held 3 unfinished copies of this task; collapsing them into one")).toBe("");
  });

  test("a real failure beside a diagnostic survives; the diagnostic does not", () => {
    const tail = ["some tool output", "[turn] resumed session held 1 unfinished copy of this task; collapsed into one"].join("\n");
    expect(stripTurnDiagnostics(tail)).toBe("some tool output");
  });

  test("TimeExceeded maps to something the user can act on", () => {
    expect(describeTurnFailure("", "TimeExceeded", "es")).toBe("el turno superó el tiempo límite");
    expect(describeTurnFailure("the run ended with TimeExceeded", undefined, "en")).toBe("the turn ran out of time");
  });

  test("a provider failure is named as one, not pasted as a stack", () => {
    expect(describeTurnFailure("ProviderError: HTTP 503 from https://api.example.com/v1", undefined, "es")).toBe("falló el proveedor del modelo");
    expect(describeTurnFailure("HTTP 429 Too Many Requests", undefined, "es")).toContain("cuota");
  });

  test("an unmapped cause yields no reason, and the note says only that it failed", () => {
    expect(describeTurnFailure("exit 137", undefined, "es")).toBe("");
    expect(turnFailureNote("exit 137", "", "es")).toBe("(no he podido completar esta tarea)");
  });

  test("the note is recognizable as a failure note and never as an answer", () => {
    expect(isTurnFailureNote(turnFailureNote("", "TimeExceeded", "es"))).toBe(true);
    expect(isTurnFailureNote(turnFailureNote("", "TimeExceeded", "en"))).toBe(true);
    expect(isTurnFailureNote("respuesta del bot")).toBe(false);
    expect(isTurnFailureNote("(mini could not complete this turn: algo)")).toBe(false);
  });

  test("language follows the sender's own words", () => {
    expect(replyLanguage("Reviso el fallo de duplicado")).toBe("es");
    expect(replyLanguage("please check the duplicate bug")).toBe("en");
  });

  test("language follows the THREAD when the sender's line carries no signal", () => {
    // The failing line of the live QA: four words, no accent, no ñ. On its own it carries no signal,
    // and it lands in a thread that carries plenty — so the note must follow the thread.
    expect(replyLanguage("di hola y nada mas", SPANISH_THREAD)).toBe("es");
    expect(replyLanguage("hola", SPANISH_THREAD)).toBe("es");
    expect(replyLanguage("que hora es", SPANISH_THREAD)).toBe("es");
    // The other direction is symmetric: an English thread is not dragged into Spanish by a short line.
    expect(replyLanguage("hola", ENGLISH_THREAD)).toBe("en");
    expect(replyLanguage("please check", ENGLISH_THREAD)).toBe("en");
    // A thread with ñ or ¿ is decided outright, whatever else is in it.
    expect(replyLanguage("¿que pasa?", ENGLISH_THREAD)).toBe("es");
  });

  test("with nothing to go on, the note is Spanish rather than a coin flip", () => {
    // "di hola y nada mas" and "hola" both carry zero Spanish markers and zero English ones. Read
    // alone they are undecidable, and this is the sentence the live QA tripped on. The bound threads
    // are Spanish and a wrong guess makes the note unreadable, so silence resolves to Spanish.
    expect(replyLanguage("hola")).toBe("es");
    expect(replyLanguage("di hola y nada mas")).toBe("es");
    expect(replyLanguage("")).toBe("es");
  });
});

describe("the thread sample the note reads its language from", () => {
  const dir = mkdtempSync(join(tmpdir(), "thread-texts-"));
  made.push(dir);
  const inbox = new ChannelInbox(join(dir, "channels.sqlite"));
  const other = "34692747052@s.whatsapp.net";
  // accept() refuses an unbound route, exactly as it does in production: the sample is the
  // conversation the thread actually admitted, not any text anyone could put in a row.
  inbox.bind({ channel: "whatsapp", account: ACCOUNT, thread: GROUP, session: SESSION, project: "wa-assistant", allowedSenders: [SENDER], policy: "all", model: "" });
  inbox.bind({ channel: "whatsapp", account: ACCOUNT, thread: other, session: `${SESSION}-other`, project: "wa-assistant", allowedSenders: [SENDER], policy: "all", model: "" });
  const put = (thread: string, i: number, text: string) =>
    inbox.accept({ channel: "whatsapp", account: ACCOUNT, thread, messageId: `m${i}`, sender: SENDER, sentAt: Date.now() + i, text, attachments: [] });

  test("it reads this thread's own messages, newest first", () => {
    put(GROUP, 1, "Estás en ello?");
    put(GROUP, 2, "Muchas gracias, genial");
    expect(inbox.threadTexts(ACCOUNT, GROUP)).toEqual(["Muchas gracias, genial", "Estás en ello?"]);
  });

  test("another thread's words never leak into this one", () => {
    put(other, 3, "this is a completely different conversation in english");
    expect(inbox.threadTexts(ACCOUNT, GROUP).join(" ")).not.toContain("completely different");
    expect(inbox.threadTexts(ACCOUNT, other)).toEqual(["this is a completely different conversation in english"]);
  });

  test("an empty thread yields nothing rather than throwing", () => {
    expect(inbox.threadTexts(ACCOUNT, "nadie@s.whatsapp.net")).toEqual([]);
  });

  test("the sample is bounded, so a long thread cannot become the note's size", () => {
    for (let i = 10; i < 40; i++) put(GROUP, i, `mensaje numero ${i}`);
    expect(inbox.threadTexts(ACCOUNT, GROUP, 5)).toHaveLength(5);
    expect(() => inbox.threadTexts(ACCOUNT, GROUP, 0)).toThrow();
    expect(() => inbox.threadTexts(ACCOUNT, GROUP, 101)).toThrow();
  });
});
