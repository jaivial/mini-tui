/**
 * Wires the work queue to the web server's sessions: the one chat (the dispatcher), the worker
 * sessions behind each task, and the loopback API the agents' queue tools call.
 */
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { loadSettings } from "../settings";
import { loadLastModel } from "../lastModel";
import { DEFAULT_MODEL } from "../config";
import type { RunEvent } from "../traj/schema";
import { clampConcurrency, WorkQueue, type QueueTask } from "./workQueue";
import type { LiveSession, RunProfile, SessionManager, SessionStatus } from "./sessions";
import { saveTask } from "../sessions";
import { log } from "./log";

/** The secret the agents' queue tools present; a page cannot know it. */
export const QUEUE_TOKEN = randomBytes(24).toString("hex");

export interface QueueHostOptions {
  sessions: () => SessionManager;
  /** Where the agents reach the queue API (loopback). */
  url: () => string;
  onChange: () => void;
}

export function concurrency(): number {
  return clampConcurrency(loadSettings().queueConcurrency);
}

/** The text a finished run leaves: its submission, else its last assistant words. */
export function finalText(session: LiveSession | undefined): { text: string; ok: boolean } {
  if (!session) return { text: "", ok: false };
  const events = session.events;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as RunEvent;
    if (e.type === "exit") return { text: e.submission || e.exitStatus, ok: e.exitStatus === "Submitted" };
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as RunEvent;
    if (e.type === "assistant" && e.text.trim()) return { text: e.text, ok: session.exitStatus === "Submitted" };
    if (e.type === "error") return { text: e.text, ok: false };
  }
  return { text: session.exitStatus || "", ok: session.exitStatus === "Submitted" };
}

export class QueueHost {
  queue: WorkQueue;
  #o: QueueHostOptions;

  constructor(o: QueueHostOptions) {
    this.#o = o;
    const sessions = () => o.sessions();
    this.queue = new WorkQueue({
      db: sessions().db(),
      concurrency,
      model: () => this.mainSession()?.model || loadLastModel() || DEFAULT_MODEL,
      defaultCwd: () => homedir(),
      onChange: o.onChange,
      host: {
        startWorker: async (task, prompt) => {
          const s = await sessions().create({ prompt, cwd: task.cwd, model: task.model || undefined, target: "local", profile: this.workerProfile(task), title: task.title });
          log("queue.worker.start", { task: task.id, session: s.id });
          return s.id;
        },
        continueWorker: async (sessionId, message) => {
          const sm = sessions();
          if (!sm.get(sessionId)) await sm.openHistory(sessionId);
          await sm.send(sessionId, message);
        },
        workerRunning: (sessionId) => sessions().agentRunning(sessionId),
        messageWorker: (sessionId, message) => void sessions().messageAgent(sessionId, message),
        stopWorker: (sessionId) => {
          try {
            sessions().interrupt(sessionId);
          } catch {
            // not held: nothing runs
          }
        },
        workerResult: (sessionId) => finalText(sessions().get(sessionId)),
        saveCard: (sessionId, title, description) => {
          try {
            saveTask(sessions().db(), sessionId, { title, description, todos: {} });
          } catch {
            // the card is cosmetic
          }
        },
      },
    });
  }

  // ---- the one chat

  mainId(): string {
    return this.queue.meta("main_session");
  }

  mainSession(): LiveSession | undefined {
    const id = this.mainId();
    return id ? this.#o.sessions().get(id) : undefined;
  }

  setMain(id: string): void {
    this.queue.setMeta("main_session", id);
  }

  dispatcherProfile(): RunProfile {
    return {
      role: "dispatcher",
      specs: ["mini.yaml", "dispatcher.yaml"],
      // Writing a brief needs little reasoning: a small thinking budget keeps the turn short.
      env: { ...this.#queueEnv(), MINI_AGENT_TOOLSET: "dispatcher", MINI_AGENT_GOAL_ORACLE: "off", MINI_AGENT_CACHE_WARMER: "off", XIAOMI_THINKING_BUDGET: "256" },
    };
  }

  workerProfile(task: Pick<QueueTask, "id">): RunProfile {
    // The worker's own verification is its closure: the model judge doubled short tasks and could
    // reject a correct answer into a loop (measured on the pi-vs-mini corpus). MINITUI_WORKER_JUDGE=1
    // turns it back on.
    const judge = process.env.MINITUI_WORKER_JUDGE === "1" ? {} : { MINI_AGENT_GOAL_ORACLE: "off" };
    return { role: "worker", specs: [], env: { ...this.#queueEnv(), ...judge, MINI_AGENT_TOOLSET: "worker", MINITUI_TASK_ID: task.id, MINI_AGENT_CACHE_WARMER: "off", MINI_AGENT_THINKING: process.env.MINI_AGENT_THINKING ?? "adaptive" } };
  }

  #queueEnv(): Record<string, string> {
    // A provider call stuck far past its usual latency gets a duplicate in flight (first wins).
    return { MINITUI_QUEUE_URL: this.#o.url(), MINITUI_QUEUE_TOKEN: QUEUE_TOKEN, MINI_AGENT_ORCHESTRATOR: "0", MINI_AGENT_HEDGE_S: process.env.MINI_AGENT_HEDGE_S ?? "15" };
  }

  /** The run profile of a session after a restart: the chat, a task's worker, or none. */
  profileOf(sessionId: string): RunProfile | undefined {
    if (sessionId && sessionId === this.mainId()) return this.dispatcherProfile();
    const task = this.queue.bySession(sessionId);
    return task ? this.workerProfile(task) : undefined;
  }

  /** A message from the human to the queue's chat. Creates the chat on its first message. */
  /** The human's last message to the chat: what `@MESSAGE` in a brief expands to. */
  lastMessage = "";

  async prompt(body: { prompt: string; model?: string; attachments?: unknown }): Promise<LiveSession> {
    const sm = this.#o.sessions();
    const text = body.prompt.trim();
    this.lastMessage = text;
    const suffix = this.queue.queueState(text);
    let id = this.mainId();
    if (id && !sm.get(id)) {
      try {
        await sm.openHistory(id);
      } catch {
        id = "";
      }
    }
    const main = id ? sm.get(id) : undefined;
    if (main && main.messages.length) {
      if (body.model && body.model !== main.model) sm.setModel(id, body.model);
      await sm.send(id, text, body.attachments, suffix);
      return sm.get(id)!;
    }
    if (main) sm.close(main.id);
    const created = await sm.create({ prompt: text, model: body.model, target: "local", attachments: body.attachments, profile: this.dispatcherProfile(), agentSuffix: suffix });
    this.setMain(created.id);
    return created;
  }

  /** A fresh chat; the queue and its tasks stay. */
  newChat(): void {
    const id = this.mainId();
    if (id) this.#o.sessions().close(id);
    this.setMain("");
  }

  // ---- worker → chat

  /** A session's agent ended: if it was a worker, its task settles and the chat hears about it. */
  runExited(sessionId: string, status: SessionStatus): void {
    const before = this.queue.bySession(sessionId);
    if (!before || before.status !== "running") return;
    this.queue.workerExited(sessionId, status === "running" || status === "idle" ? "done" : status);
    const after = this.queue.get(before.id);
    if (!after) return;
    const first = after.result.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
    this.notifyChat(`${after.status === "done" ? "✓" : "✗"} ${after.id} · ${after.title} — ${after.status}${first ? `: ${first.slice(0, 240)}` : ""}`);
  }

  notifyChat(text: string): void {
    const id = this.mainId();
    if (id) this.#o.sessions().injectNotice(id, text);
  }
}
