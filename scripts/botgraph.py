#!/usr/bin/env python3
"""botgraph — shared graph RAG + cross-bot kanban visibility for mini-tui bots.

Every bot gets a namespaced subgraph in the production neo4j-rust server
(bolt://127.0.0.1:7687, systemd neo4j-rust.service). Bots write/read ONLY
their own (:Bot {id})-[:OWNS]->(:BotFact) subgraph, can SEARCH the whole
shared fact graph (what other bots saved), run read-only Cypher against the
general graph (VillaCarmen + everything), and list other bots' task cards
and the shared Hermes kanban board READ-ONLY.

Namespacing contract (do not break):
  - bot id: stable slug per bot/session (e.g. "wa2", "e2e-a").
  - facts live under label :BotFact with id "<bot>/<key>" and property `bot`.
  - only labels :Bot / :BotFact are ever written by this tool.
  - the base graph (VillaCarmen, ~8036 nodes) is never modified.

If the `neo4j` python driver is not importable, the script re-execs itself
under ~/.venvs/neo4j-e2e/bin/python (where the driver lives).

Usage:
  botgraph save   --bot BOT --key K --text T [--kind KIND]     upsert a fact
  botgraph find   --q Q [--bot BOT] [--limit N]                search all facts
  botgraph get    --bot BOT [--key K]                          read own subgraph
  botgraph forget --bot BOT [--key K]                          delete own facts
  botgraph bots                                                list bots + counts
  botgraph link   --bot BOT --from-key K1 --to-key K2 [--rel R] link own facts
  botgraph query  --cypher C [--param JSON] [--limit N]        read-only Cypher
  botgraph kanban [--session ID]                               read-only task view
  botgraph e2e                                                  cross-bot E2E
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import time

URI = os.getenv("BOTGRAPH_NEO4J_URI", "bolt://127.0.0.1:7687")
DRIVER_VENV = os.path.expanduser("~/.venvs/neo4j-e2e/bin/python")
#: per-query ceiling handed to the driver, so no query can pin a bot forever
QUERY_TIMEOUT_S = float(os.getenv("BOTGRAPH_QUERY_TIMEOUT_S", "30"))
BUN_CANDIDATES = ("~/.bun/bin/bun", "/usr/local/bin/bun", "/usr/bin/bun")
MINITUI_CANDIDATES = ("~/.local/bin/mini-tui", "~/bin/mini-tui", "~/.bun/bin/mini-tui")
MINITUI = os.getenv("BOTGRAPH_MINITUI") or "mini-tui"   # legacy name; see _minitui_bin()
HERMES = shutil.which("hermes") or "hermes"

WRITE_WORDS = ("CREATE", "MERGE", "SET ", "DELETE", "DETACH", "REMOVE", "FOREACH", "CALL {")


def _first_executable(cands) -> str | None:
    for c in cands:
        p = os.path.expanduser(c)
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


def _child_env() -> dict:
    """Environment for the child processes this tool launches.

    `mini-tui` is a bash wrapper that `exec`s `bun` BY NAME, and bun lives in
    ~/.bun/bin. Neither ~/.bun/bin nor ~/.local/bin is on PATH for a non-login
    environment (cron, systemd unit, agent shell), so the wrapper died with
    `exec: bun: not found`. Measured on the production host 2026-10-16: that
    string was handed back as if it were the bot's task card.
    """
    env = dict(os.environ)
    extra = [os.path.expanduser("~/.bun/bin"), os.path.expanduser("~/.local/bin"),
             os.path.expanduser("~/bin")]
    bun = _first_executable(BUN_CANDIDATES)
    if bun:
        extra.insert(0, os.path.dirname(bun))
    extra.extend(sorted(glob.glob(os.path.expanduser("~/.nvm/versions/node/*/bin")), reverse=True))
    parts = [p for p in env.get("PATH", "").split(os.pathsep) if p]
    for d in reversed(extra):
        if os.path.isdir(d) and d not in parts:
            parts.insert(0, d)
    env["PATH"] = os.pathsep.join(parts)
    return env


def _minitui_bin() -> str:
    """Absolute path to the mini-tui launcher, not a PATH guess."""
    override = os.getenv("BOTGRAPH_MINITUI")
    if override:
        return override
    found = _first_executable(MINITUI_CANDIDATES)
    if found:
        return found
    return shutil.which("mini-tui", path=_child_env()["PATH"]) or "mini-tui"


def _ensure_driver() -> None:
    try:
        import neo4j  # noqa: F401
    except ImportError:
        if os.environ.get("BOTGRAPH_REEXEC") != "1" and os.path.exists(DRIVER_VENV):
            env = dict(os.environ, BOTGRAPH_REEXEC="1")
            os.execve(DRIVER_VENV, [DRIVER_VENV, __file__] + sys.argv[1:], env)
        sys.exit("botgraph: python driver `neo4j` not available (tried %s)" % DRIVER_VENV)


def _driver():
    from neo4j import GraphDatabase

    d = GraphDatabase.driver(URI, auth=None)
    d.verify_connectivity()
    return d


def _run(cypher: str, params: dict | None = None):
    """Run Cypher with a ceiling: without one, a bad query pins the bot forever."""
    d = _driver()
    try:
        with d.session() as s:
            return [r.data() for r in s.run(cypher, params or {}, timeout=QUERY_TIMEOUT_S)]
    finally:
        d.close()


# ---------------------------------------------------------------- graph RAG

def cmd_save(a) -> None:
    if not a.bot or not a.key:
        sys.exit("--bot and --key are required")
    fact_id = f"{a.bot}/{a.key}"
    rows = _run(
        """
        MERGE (b:Bot {id: $bot})
        ON CREATE SET b.name = $bot, b.created_at = $now
        SET b.updated_at = $now
        MERGE (f:BotFact {id: $fid})
        SET f.bot = $bot, f.key = $key, f.text = $text, f.kind = $kind, f.ts = $now
        MERGE (b)-[:OWNS]->(f)
        RETURN f.id AS id
        """,
        {"bot": a.bot, "fid": fact_id, "key": a.key, "text": a.text,
         "kind": a.kind or "note", "now": int(time.time() * 1000)},
    )
    print(json.dumps({"saved": rows[0]["id"] if rows else None, "bot": a.bot, "key": a.key}))


def cmd_find(a) -> None:
    where = ["(f.text CONTAINS $q OR f.key CONTAINS $q OR f.kind CONTAINS $q)"]
    if a.bot != "all":
        where.append("f.bot = $bot")
    rows = _run(
        f"""
        MATCH (f:BotFact) WHERE {' AND '.join(where)}
        RETURN f.bot AS bot, f.key AS key, f.kind AS kind, f.text AS text, f.ts AS ts
        ORDER BY f.ts DESC LIMIT $limit
        """,
        {"q": a.q, "bot": a.bot, "limit": a.limit},
    )
    print(json.dumps({"query": a.q, "scope": a.bot, "hits": rows}, ensure_ascii=False, indent=2))


def cmd_get(a) -> None:
    if a.key:
        rows = _run(
            "MATCH (:Bot {id: $bot})-[:OWNS]->(f:BotFact {key: $key}) "
            "RETURN f.bot AS bot, f.key AS key, f.kind AS kind, f.text AS text, f.ts AS ts",
            {"bot": a.bot, "key": a.key},
        )
    else:
        rows = _run(
            "MATCH (:Bot {id: $bot})-[:OWNS]->(f:BotFact) "
            "RETURN f.bot AS bot, f.key AS key, f.kind AS kind, f.text AS text, f.ts AS ts "
            "ORDER BY f.ts DESC",
            {"bot": a.bot},
        )
    print(json.dumps({"bot": a.bot, "facts": rows}, ensure_ascii=False, indent=2))


def cmd_forget(a) -> None:
    if a.key:
        n = _run("MATCH (:Bot {id: $bot})-[:OWNS]->(f:BotFact {key: $key}) DETACH DELETE f RETURN count(*) AS c",
                 {"bot": a.bot, "key": a.key})[0]["c"]
    else:
        n = _run("MATCH (b:Bot {id: $bot}) OPTIONAL MATCH (b)-[:OWNS]->(f:BotFact) DETACH DELETE b, f RETURN count(*) AS c",
                 {"bot": a.bot})[0]["c"]
    print(json.dumps({"forgot": n, "bot": a.bot}))


def cmd_bots(a) -> None:
    rows = _run(
        "MATCH (b:Bot) OPTIONAL MATCH (b)-[:OWNS]->(f:BotFact) "
        "RETURN b.id AS bot, b.updated_at AS updated_at, count(f) AS facts ORDER BY bot"
    )
    print(json.dumps({"bots": rows}, ensure_ascii=False, indent=2))


def cmd_link(a) -> None:
    rows = _run(
        """
        MATCH (:Bot {id: $bot})-[:OWNS]->(f1:BotFact {key: $k1})
        MATCH (:Bot {id: $bot})-[:OWNS]->(f2:BotFact {key: $k2})
        MERGE (f1)-[r:RELATED {kind: $rel}]->(f2)
        RETURN f1.key AS from_key, f2.key AS to_key
        """,
        {"bot": a.bot, "k1": a.from_key, "k2": a.to_key, "rel": a.rel},
    )
    if not rows:
        sys.exit("link: both facts must exist in the bot's own subgraph")
    print(json.dumps({"linked": rows[0], "rel": a.rel}))


def cmd_query(a) -> None:
    head = " ".join(a.cypher.split()).upper()
    if not a.write and any(w in head for w in WRITE_WORDS):
        sys.exit("query: write keywords detected; pass --write to allow mutations")
    params = json.loads(a.param) if a.param else {}
    rows = _run(a.cypher + (f" LIMIT {int(a.limit)}" if a.limit and "LIMIT" not in head else ""))
    print(json.dumps({"rows": rows}, ensure_ascii=False, indent=2, default=str))


# ------------------------------------------------- kanban / task visibility

def _mini_tui(*args: str) -> tuple[int, str]:
    """Run the mini-tui CLI. Returns (exit code, combined output)."""
    try:
        p = subprocess.run([_minitui_bin(), *args], capture_output=True, text=True,
                           timeout=30, env=_child_env())
    except (OSError, subprocess.TimeoutExpired) as e:
        return 1, f"mini-tui {' '.join(args)} could not run: {e}"
    return p.returncode, p.stdout + p.stderr


def _kanban_sessions() -> tuple[list[dict], str]:
    """(sessions, error). An empty list with an error is NOT 'no sessions'."""
    rc, out = _mini_tui("sessions", "--json")
    if rc != 0:
        return [], f"`mini-tui sessions --json` failed (exit {rc}): {out.strip()[:400]}"
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        return [], f"`mini-tui sessions --json` did not return JSON: {out.strip()[:400]}"
    return (data if isinstance(data, list) else []), ""


def cmd_kanban(a) -> None:
    """READ-ONLY: other bots' task cards + shared Hermes kanban board.

    Failures are reported AS failures. The old code pasted the child's stderr
    into `card`, so a launcher that could not start looked like a task card
    reading `exec: bun: not found`, and a failure to LIST sessions looked like
    "there are no sessions".
    """
    report: dict = {"read_only": True, "ok": True, "errors": [],
                    "task_cards": [], "hermes_kanban": None}

    if a.session:
        sessions = [a.session]
    else:
        raw, err = _kanban_sessions()
        sessions = [str(s.get("id") or s.get("session") or s.get("name"))
                    for s in raw if (s.get("id") or s.get("session") or s.get("name"))]
        if err:
            report["ok"] = False
            report["errors"].append(err)

    for sid in sessions:
        rc, out = _mini_tui("tasks", "show", sid)
        if rc != 0:
            report["ok"] = False
            report["errors"].append(
                f"`mini-tui tasks show {sid}` failed (exit {rc}): {out.strip()[:400]}")
            report["task_cards"].append({"session": sid, "card": None})
        else:
            report["task_cards"].append({"session": sid, "card": out.strip()})

    if not a.no_hermes:
        try:
            p = subprocess.run([HERMES, "kanban", "list"], capture_output=True, text=True,
                               timeout=30, env=_child_env())
        except (OSError, subprocess.TimeoutExpired) as e:
            report["ok"] = False
            report["errors"].append(f"`hermes kanban list` could not run: {e}")
        else:
            if p.returncode == 0 and p.stdout.strip():
                report["hermes_kanban"] = p.stdout.strip()
            else:
                report["ok"] = False
                report["errors"].append(
                    f"`hermes kanban list` failed (exit {p.returncode}): "
                    f"{(p.stdout + p.stderr).strip()[:400]}")
    print(json.dumps(report, ensure_ascii=False, indent=2))


# --------------------------------------------------------------------- E2E

def cmd_e2e(a) -> int:
    """Cross-bot E2E: bot A saves -> bot B finds; bot B sees bot A's kanban card."""
    cli = os.path.abspath(__file__)
    py = sys.executable

    def run(bot: str, *args: str) -> dict | str:
        cmd = [py, cli, *args, "--bot", bot] if args[0] in ("save", "get", "forget", "link") else [py, cli, *args]
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if p.returncode != 0:
            raise RuntimeError(f"{args[0]} failed: {p.stderr.strip()}")
        try:
            return json.loads(p.stdout)
        except json.JSONDecodeError:
            return p.stdout

    ok = True

    def check(name: str, cond: bool, detail: str = "") -> None:
        nonlocal ok
        print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f" — {detail}" if detail and not cond else ""))
        ok = ok and cond

    base = int(time.time())
    print("E2E bot-graph: A guarda -> B encuentra; B ve el kanban de A")

    # 0. clean slate for the e2e bots + node-count baseline of the base graph
    run("e2e-a", "forget")
    run("e2e-b", "forget")
    baseline = int(run("e2e-b", "query", "--cypher", "MATCH (n) RETURN count(n) AS c",
                       "--limit", "1")["rows"][0]["c"])

    # 1. bot A writes its namespaced subgraph
    run("e2e-a", "save", "--key", "deploy", "--kind", "decision",
        "--text", f"API de pagos migrada al endpoint v2 (e2e {base})")
    run("e2e-a", "save", "--key", "contact", "--kind", "fact",
        "--text", f"Proveedor de SMS: MockSMS, soporte sms@mock.dev (e2e {base})")
    run("e2e-a", "link", "--from-key", "deploy", "--to-key", "contact")
    check("A escribe subgrafo namespaced (2 facts + 1 link)",
          len(run("e2e-a", "get")["facts"]) == 2)

    # 2. bot B finds A's info in the SHARED graph (cross-bot search)
    hits = run("e2e-b", "find", "--q", "MockSMS")
    check("B encuentra info de A via busqueda general",
          any(h["bot"] == "e2e-a" for h in hits["hits"]), str(hits))
    by_scope = run("e2e-b", "find", "--q", "e2e", "--bot", "e2e-a")
    check("B acota la busqueda al subgrafo de A", len(by_scope["hits"]) == 2)
    own = run("e2e-b", "get")
    check("B ve solo su propio subgrafo en `get` (namespacing)", own["facts"] == [])

    # 3. bot B lists kanban: sees A's task card (read-only)
    subprocess.run([_minitui_bin(), "tasks", "set", "--session", "e2e-bot-a", "--title",
                    f"Revisar API de pagos v2 (e2e {base})", "--pending", "leer fact de e2e-a"],
                   capture_output=True, text=True, timeout=30, env=_child_env())
    kb = run("e2e-b", "kanban", "--session", "e2e-bot-a")
    card = kb["task_cards"][0]["card"] if kb["task_cards"] else ""
    check("B ve el kanban/tarjeta de A (read-only)", bool(card) and f"e2e {base}" in card,
          repr(card) + " | " + " | ".join(kb.get("errors") or []))
    check("la vista de kanban es read-only", kb.get("read_only") is True)

    # 3b. the caller's PATH must not matter: a bot's shell has no ~/.bun/bin and
    # no ~/.local/bin, and that used to hand back `exec: bun: not found` as a card
    stripped = subprocess.run([py, cli, "kanban", "--session", "e2e-bot-a", "--no-hermes"],
                              capture_output=True, text=True, timeout=60,
                              env=dict(os.environ, PATH="/usr/sbin:/usr/bin:/sbin:/bin"))
    try:
        stripped_kb = json.loads(stripped.stdout)
    except json.JSONDecodeError:
        stripped_kb = {"ok": False, "task_cards": [], "errors": [stripped.stderr.strip()[:200]]}
    stripped_card = stripped_kb["task_cards"][0]["card"] if stripped_kb.get("task_cards") else None
    check("kanban funciona sin bun ni ~/.local/bin en el PATH del que llama",
          stripped.returncode == 0 and bool(stripped_card) and f"e2e {base}" in stripped_card,
          f"rc={stripped.returncode} card={stripped_card!r} err={stripped_kb.get('errors')}")

    # 4. read-only guard on the general graph
    guard = subprocess.run([py, cli, "query", "--cypher", "CREATE (x:TROLL) RETURN x"],
                           capture_output=True, text=True, timeout=30)
    check("query rechaza escrituras sin --write", guard.returncode != 0)

    # 5. cleanup: bots delete their own subgraphs
    run("e2e-a", "forget")
    run("e2e-b", "forget")
    subprocess.run([_minitui_bin(), "tasks", "clear", "e2e-bot-a"], capture_output=True,
                   text=True, timeout=30, env=_child_env())
    check("cleanup: subgrafos e2e borrados", run("e2e-a", "get")["facts"] == [])
    after = run("e2e-b", "query", "--cypher", "MATCH (n) RETURN count(n) AS c", "--limit", "1")["rows"][0]["c"]
    check("grafo base intacto tras el E2E", int(after) == int(baseline), f"{baseline} -> {after}")

    print("E2E bot-graph: " + ("ALL PASS" if ok else "FAILURES"))
    return 0 if ok else 1


# -------------------------------------------------------------------- main

def main() -> None:
    _ensure_driver()
    p = argparse.ArgumentParser(prog="botgraph", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("save"); s.add_argument("--bot", required=True); s.add_argument("--key", required=True)
    s.add_argument("--text", required=True); s.add_argument("--kind", default="note"); s.set_defaults(f=cmd_save)

    s = sub.add_parser("find"); s.add_argument("--q", required=True); s.add_argument("--bot", default="all")
    s.add_argument("--limit", type=int, default=50); s.set_defaults(f=cmd_find)

    s = sub.add_parser("get"); s.add_argument("--bot", required=True); s.add_argument("--key"); s.set_defaults(f=cmd_get)

    s = sub.add_parser("forget"); s.add_argument("--bot", required=True); s.add_argument("--key"); s.set_defaults(f=cmd_forget)

    sub.add_parser("bots").set_defaults(f=cmd_bots)

    s = sub.add_parser("link"); s.add_argument("--bot", required=True); s.add_argument("--from-key", required=True)
    s.add_argument("--to-key", required=True); s.add_argument("--rel", default="RELATED"); s.set_defaults(f=cmd_link)

    s = sub.add_parser("query"); s.add_argument("--cypher", required=True); s.add_argument("--param")
    s.add_argument("--limit", type=int, default=200); s.add_argument("--write", action="store_true")
    s.set_defaults(f=cmd_query)

    s = sub.add_parser("kanban"); s.add_argument("--session"); s.add_argument("--no-hermes", action="store_true")
    s.set_defaults(f=cmd_kanban)

    sub.add_parser("e2e").set_defaults(f=cmd_e2e)

    a = p.parse_args()
    sys.exit(a.f(a) or 0)


if __name__ == "__main__":
    main()
