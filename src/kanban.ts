/**
 * The bot's kanban: the tasks a main bot is running, each handed to ONE subagent.
 *
 * A card has a column (backlog, doing, review, done, blocked), at most one assignee (the subagent
 * that owns it and orchestrates its own helpers), a result, and links to related cards. Cards live
 * in the sessions database, per bot, so any turn of the bot (or a human) can read what is pending
 * without polling anything: subagent completions arrive as messages and the bot moves the card.
 *
 * Memory is a small graph: cards are nodes, `kanban link` adds edges, and `kanban search` ranks cards
 * by word overlap and then pulls in their direct neighbours (one hop), so a new task sees the earlier
 * work it builds on.
 */
import type { Database } from "bun:sqlite";
import { findLiveRunByControl, openDb, DEFAULT_DB_PATH } from "./sessions";

export const COLUMNS = ["backlog", "doing", "review", "done", "blocked"] as const;
export type Column = (typeof COLUMNS)[number];

export interface Card {
  id: string;
  session: string;
  title: string;
  description: string;
  column: Column;
  assignee: string;
  result: string;
  notes: string[];
  createdAt: number;
  updatedAt: number;
}

export function ensureKanban(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kanban_cards (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      col TEXT NOT NULL DEFAULT 'backlog',
      assignee TEXT NOT NULL DEFAULT '',
      result TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS kanban_cards_session ON kanban_cards(session_id, col);
    CREATE TABLE IF NOT EXISTS kanban_links (
      a TEXT NOT NULL, b TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'related',
      PRIMARY KEY (a, b)
    );
  `);
}

type Row = { id: string; session_id: string; title: string; description: string; col: string; assignee: string; result: string; notes: string; created_at: number; updated_at: number };
const toCard = (r: Row): Card => ({
  id: r.id, session: r.session_id, title: r.title, description: r.description, column: r.col as Column,
  assignee: r.assignee, result: r.result, notes: safeNotes(r.notes), createdAt: r.created_at, updatedAt: r.updated_at,
});
function safeNotes(s: string): string[] {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

const newId = () => "k-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

export function addCard(db: Database, session: string, f: { title: string; description?: string; column?: Column }): Card {
  ensureKanban(db);
  const id = newId(); const now = Date.now();
  db.query("INSERT INTO kanban_cards (id, session_id, title, description, col, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, session, f.title.slice(0, 200), (f.description ?? "").slice(0, 4000), f.column ?? "backlog", now, now);
  return getCard(db, id)!;
}

/** Every card of every bot, newest first (the web board; bounded). */
export function allCards(db: Database, limit = 400): Card[] {
  ensureKanban(db);
  return (db.query("SELECT * FROM kanban_cards ORDER BY updated_at DESC LIMIT ?").all(limit) as Row[]).map(toCard);
}

export function getCard(db: Database, id: string): Card | null {
  ensureKanban(db);
  const r = db.query("SELECT * FROM kanban_cards WHERE id = ?").get(id) as Row | null;
  return r ? toCard(r) : null;
}

export function listCards(db: Database, session: string, column?: Column): Card[] {
  ensureKanban(db);
  const rows = (column
    ? db.query("SELECT * FROM kanban_cards WHERE session_id = ? AND col = ? ORDER BY updated_at DESC").all(session, column)
    : db.query("SELECT * FROM kanban_cards WHERE session_id = ? ORDER BY updated_at DESC").all(session)) as Row[];
  return rows.map(toCard);
}

export function updateCard(db: Database, id: string, f: { column?: Column; assignee?: string; result?: string; note?: string; title?: string; description?: string }): Card | null {
  const c = getCard(db, id);
  if (!c) return null;
  const notes = f.note ? [...c.notes, f.note.slice(0, 1000)].slice(-30) : c.notes;
  db.query("UPDATE kanban_cards SET title=?, description=?, col=?, assignee=?, result=?, notes=?, updated_at=? WHERE id=?")
    .run(f.title ?? c.title, f.description ?? c.description, f.column ?? c.column, f.assignee ?? c.assignee,
      (f.result ?? c.result).slice(0, 8000), JSON.stringify(notes), Date.now(), id);
  return getCard(db, id);
}

export function linkCards(db: Database, a: string, b: string, kind = "related"): void {
  ensureKanban(db);
  db.query("INSERT OR REPLACE INTO kanban_links (a, b, kind) VALUES (?,?,?)").run(a, b, kind);
}

const words = (s: string) => new Set(s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9]+/).filter((w) => w.length > 2));

/** Cards of this bot ranked by word overlap with `query`, plus their direct neighbours (graph hop). */
export function searchCards(db: Database, session: string, query: string, limit = 8): { card: Card; score: number; via?: string }[] {
  const q = words(query);
  const all = listCards(db, session);
  const scored = all.map((card) => {
    const w = words(`${card.title} ${card.description} ${card.result} ${card.notes.join(" ")}`);
    let n = 0; for (const t of q) if (w.has(t)) n++;
    return { card, score: q.size ? n / q.size : 0 } as { card: Card; score: number; via?: string };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
  const seen = new Set(scored.map((s) => s.card.id));
  const out = [...scored];
  for (const s of scored.slice(0, 4)) {
    const edges = db.query("SELECT a, b FROM kanban_links WHERE a = ? OR b = ?").all(s.card.id, s.card.id) as { a: string; b: string }[];
    for (const e of edges) {
      const other = e.a === s.card.id ? e.b : e.a;
      if (seen.has(other)) continue;
      const c = getCard(db, other);
      if (c) { seen.add(other); out.push({ card: c, score: s.score * 0.5, via: s.card.id }); }
    }
  }
  return out.slice(0, limit + 4);
}

export interface KanbanArgs {
  command: "kanban";
  action: "add" | "move" | "assign" | "done" | "note" | "link" | "list" | "show" | "search";
  session?: string;
  id?: string;
  other?: string;
  title?: string;
  description?: string;
  column?: string;
  assignee?: string;
  text?: string;
  json: boolean;
}

const line = (c: Card) => `${c.id}  [${c.column}]${c.assignee ? ` @${c.assignee}` : ""}  ${c.title}`;

export function kanbanCommand(
  args: KanbanArgs,
  out: { stdout(s: string): void; stderr(s: string): void },
  resolve: (explicit: string | undefined, byControl: (control: string) => string | null) => string | null,
  dbPath: string = DEFAULT_DB_PATH,
): number {
  const db = openDb(dbPath);
  const print = (v: unknown) => out.stdout(JSON.stringify(v, null, 2) + "\n");
  try {
    ensureKanban(db);
    const session = resolve(args.session, (control) => findLiveRunByControl(db, control)?.session_id ?? null);
    if (!session && ["add", "list", "search"].includes(args.action)) {
      out.stderr("error: cannot tell which bot this board is for: pass --session <id>, or run inside a mini-tui session\n");
      return 2;
    }
    const col = args.column as Column | undefined;
    if (col && !COLUMNS.includes(col)) { out.stderr(`error: column must be one of ${COLUMNS.join(", ")}\n`); return 2; }
    const need = (id?: string) => { const c = id ? getCard(db, id) : null; if (!c) out.stderr(`error: no card ${id ?? "(missing id)"}\n`); return c; };
    switch (args.action) {
      case "add": {
        if (!args.title?.trim()) { out.stderr("error: add needs --title\n"); return 2; }
        const c = addCard(db, session!, { title: args.title, description: args.description, column: col });
        if (args.json) return print(c), 0;
        out.stdout(`card ${c.id} added to ${c.column}: ${c.title}\n`); return 0;
      }
      case "move": case "assign": case "done": case "note": {
        const c = need(args.id); if (!c) return 2;
        const patch: Parameters<typeof updateCard>[2] = {};
        if (args.action === "move") { if (!col) { out.stderr("error: move needs --column\n"); return 2; } patch.column = col; }
        if (args.action === "assign") {
          const who = args.assignee || c.id; // by convention the subagent is named after its card
          if (c.assignee && c.assignee !== who && c.column === "doing") { out.stderr(`error: card already belongs to @${c.assignee}: one task, one subagent\n`); return 2; }
          patch.assignee = who; patch.column = "doing";
        }
        if (args.action === "done") { patch.column = col ?? "done"; if (args.text) patch.result = args.text; }
        if (args.action === "note") { if (!args.text) { out.stderr("error: note needs --text\n"); return 2; } patch.note = args.text; }
        const u = updateCard(db, c.id, patch)!;
        if (args.json) return print(u), 0;
        out.stdout(`${line(u)}\n`); return 0;
      }
      case "link": {
        if (!need(args.id) || !need(args.other)) return 2;
        linkCards(db, args.id!, args.other!); out.stdout(`linked ${args.id} <-> ${args.other}\n`); return 0;
      }
      case "show": {
        const c = need(args.id); if (!c) return 2;
        if (args.json) return print(c), 0;
        out.stdout(`${line(c)}\n${c.description ? c.description + "\n" : ""}${c.result ? "result: " + c.result + "\n" : ""}${c.notes.map((n) => "- " + n).join("\n")}${c.notes.length ? "\n" : ""}`); return 0;
      }
      case "search": {
        const hits = searchCards(db, session!, args.text ?? args.title ?? "");
        if (args.json) return print(hits), 0;
        out.stdout(hits.length ? hits.map((h) => `${line(h.card)}${h.via ? `   (linked to ${h.via})` : ""}${h.card.result ? `\n    result: ${h.card.result.slice(0, 200)}` : ""}`).join("\n") + "\n" : "no related cards\n"); return 0;
      }
      default: {
        const cards = listCards(db, session!, col);
        if (args.json) return print(cards), 0;
        if (!cards.length) { out.stdout("the board is empty\n"); return 0; }
        for (const c of COLUMNS) {
          const here = cards.filter((x) => x.column === c);
          if (here.length) out.stdout(`${c.toUpperCase()}\n${here.map((x) => "  " + line(x)).join("\n")}\n`);
        }
        return 0;
      }
    }
  } finally {
    db.close();
  }
}

export function parseKanban(rest: string[], takeValue: (a: string[], i: number, f: string) => string): KanbanArgs {
  const a: KanbanArgs = { command: "kanban", action: "list", json: false };
  const pos: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const x = rest[i]!;
    if (x === "--json") a.json = true;
    else if (x === "--session" || x === "-s") a.session = takeValue(rest, i++, x);
    else if (x === "--title") a.title = takeValue(rest, i++, x);
    else if (x === "--description" || x === "--desc") a.description = takeValue(rest, i++, x);
    else if (x === "--column" || x === "--to") a.column = takeValue(rest, i++, x);
    else if (x === "--assignee" || x === "--agent") a.assignee = takeValue(rest, i++, x);
    else if (x === "--text" || x === "--result") a.text = takeValue(rest, i++, x);
    else if (x.startsWith("-")) throw new Error(`unknown option for kanban: ${x}`);
    else pos.push(x);
  }
  const [action, id, other] = pos;
  const known = ["add", "move", "assign", "done", "note", "link", "list", "show", "search"];
  if (action) {
    if (!known.includes(action)) throw new Error(`unknown kanban action: ${action} (${known.join(" | ")})`);
    a.action = action as KanbanArgs["action"];
  }
  if (a.action === "search" && id && !a.text) a.text = pos.slice(1).join(" ");
  else { if (id) a.id = id; if (other) a.other = other; }
  return a;
}

/**
 * A subagent named after its card reports back through the hub's roster: when it finishes, the
 * card follows without the parent having to poll. Waiting (turn over, can still be messaged) goes
 * to review; a clean stop is done; any other end is blocked with the exit status as its note.
 */
export function settleFromSubagent(db: Database, parentId: string, name: string, state: string, exitStatus: string, steps = 1): Card | null {
  const c = getCard(db, name);
  if (!c || c.session !== parentId) return null;
  if (c.column !== "doing" && c.column !== "review") return null;
  let column: Column | null = null;
  if (state === "waiting") column = "review";
  else if (state === "stopped" || state === "exited") column = steps > 0 && (!exitStatus || exitStatus === "Submitted") ? "done" : "blocked";
  if (!column || column === c.column) return null;
  return updateCard(db, c.id, { column, result: c.result || (exitStatus ? `subagent ${state}: ${exitStatus}` : steps === 0 ? `subagent ${state} before taking a step` : `subagent ${state}`), note: `auto: subagent ${state}${exitStatus ? ` (${exitStatus})` : ""}` });
}

/** A subagent's board is temporary: it goes with the subagent once it has stopped. */
export function dropBoard(db: Database, scope: string): number {
  ensureKanban(db);
  // The subagent's own board plus the boards of helpers nested under it (scope`~name`...): they all
  // go once the subagent has stopped.
  const like = scope.replace(/[\\%_]/g, "\\$&") + "~%";
  const ids = (db.query("SELECT id FROM kanban_cards WHERE session_id = ? OR session_id LIKE ? ESCAPE '\\'").all(scope, like) as { id: string }[]).map((r) => r.id);
  for (const id of ids) db.query("DELETE FROM kanban_links WHERE a = ? OR b = ?").run(id, id);
  db.query("DELETE FROM kanban_cards WHERE session_id = ? OR session_id LIKE ? ESCAPE '\\'").run(scope, like);
  return ids.length;
}
