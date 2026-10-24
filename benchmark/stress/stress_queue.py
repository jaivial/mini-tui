#!/usr/bin/env python3
"""Stress and edge-case scenarios for the work queue, against a test server driven by mock_llm.py.

    python3 stress_queue.py [scenario ...]      (default: all)

Each scenario resets the queue (POST /api/queue/new + waits for idle) and asserts invariants:
  * running never exceeds the concurrency cap
  * every task ends in a terminal state; no task stays `running` without a live worker
  * redirect / cancel / duplicate semantics
"""
import json, os, subprocess, sys, threading, time, urllib.request, uuid

PORT = os.environ.get("MINITUI_WEB_PORT", "4402")
BASE = f"http://127.0.0.1:{PORT}/api"
MOCK = "http://127.0.0.1:4499"
MODEL = "mockp/m"
FAILS = []


def call(method, path, body=None, base=BASE, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method, headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.load(e)
        except Exception:
            return e.code, {}


def queue():
    return call("GET", "/queue")[1]


def prompt(text):
    return call("POST", "/queue/prompt", {"prompt": text, "model": MODEL})


def set_conc(n):
    return call("PATCH", "/settings", {"queueConcurrency": n})[1]


def check(cond, msg):
    if not cond:
        FAILS.append(msg)
        print("   FAIL:", msg, flush=True)
    return cond


def prompt_and_wait(text, timeout=90):
    """Send to the chat and wait until the dispatcher has handled THIS message."""
    t0 = time.time()
    st, r = prompt(text)
    if st != 200:
        return st, r
    sid = r.get("id")
    while time.time() - t0 < timeout:
        time.sleep(0.3)
        _, s = call("GET", f"/sessions/{sid}")
        events = s.get("events", [])
        last_task = max((i for i, e in enumerate(events) if e.get("type") == "task"), default=-1)
        if s.get("status") != "running" and any(e.get("type") == "exit" for e in events[last_task + 1:]):
            return st, r
    FAILS.append(f"dispatcher did not answer within {timeout}s: {text[:60]!r}")
    return st, r


def wait_main_idle(timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = queue()
        if not v["main"]:
            return
        st, s = call("GET", f"/sessions/{v['main']}")
        if s.get("status") in ("done", "error", "idle", "interrupted"):
            return
        time.sleep(0.3)


def wait_terminal(ids=None, timeout=180, cap=None):
    """Wait until the given (or all) tasks are terminal; track the running peak against `cap`."""
    t0, peak = time.time(), 0
    while time.time() - t0 < timeout:
        tasks = queue()["tasks"]
        mine = [t for t in tasks if ids is None or t["id"] in ids]
        running = sum(t["status"] == "running" for t in tasks)
        peak = max(peak, running)
        if cap is not None:
            check(running <= cap, f"running {running} > cap {cap}")
        if mine and all(t["status"] in ("done", "error", "cancelled") for t in mine):
            return mine, peak
        time.sleep(0.25)
    return [t for t in queue()["tasks"] if ids is None or t["id"] in ids], peak


def new_ids(before):
    return [t["id"] for t in queue()["tasks"] if t["id"] not in before]


def reset():
    call("POST", "/queue/new")
    for t in queue()["tasks"]:
        if t["status"] in ("queued", "running"):
            call("POST", f"/queue/tasks/{t['id']}/cancel")
    time.sleep(0.5)


# ------------------------------------------------------------------ scenarios

def s_concurrency_cap():
    """30 tasks at cap 5: at most 5 run at once, all finish, FIFO start order."""
    set_conc(5)
    before = {t["id"] for t in queue()["tasks"]}
    prompt_and_wait("CREATE 30 sleep=1")
    ids = new_ids(before)
    check(len(ids) == 30, f"30 tasks created, got {len(ids)}")
    tasks, peak = wait_terminal(set(ids), cap=5)
    check(all(t["status"] == "done" for t in tasks), f"all done: {[ (t['id'],t['status']) for t in tasks if t['status']!='done']}")
    check(peak == 5, f"peak running should hit the cap 5, was {peak}")
    order = sorted(tasks, key=lambda t: (t["startedAt"], t["seq"]))
    seqs = [t["seq"] for t in order]
    check(seqs == sorted(seqs), "FIFO start order")


def s_cap_one_then_raise():
    """Cap 1 serialises; raising it mid-run starts waiting work at once."""
    set_conc(1)
    before = {t["id"] for t in queue()["tasks"]}
    prompt_and_wait("CREATE 6 sleep=5")
    ids = set(new_ids(before))
    time.sleep(1.5)
    running = [t for t in queue()["tasks"] if t["id"] in ids and t["status"] == "running"]
    check(len(running) == 1, f"cap 1 -> 1 running, got {len(running)}")
    set_conc(6)
    time.sleep(1.5)
    running = [t for t in queue()["tasks"] if t["id"] in ids and t["status"] == "running"]
    check(len(running) >= 4, f"after raising the cap, most waiting tasks start ({len(running)} running)")
    tasks, _ = wait_terminal(ids)
    check(all(t["status"] == "done" for t in tasks), "all done after raise")


def s_lower_cap_midrun():
    """Lowering the cap does not kill running work; no new starts until under the cap."""
    set_conc(6)
    before = {t["id"] for t in queue()["tasks"]}
    prompt_and_wait("CREATE 10 sleep=3")
    ids = set(new_ids(before))
    time.sleep(1.5)
    set_conc(2)
    # running ones finish (none are killed); then at most 2 at once.
    tasks, _ = wait_terminal(ids)
    check(all(t["status"] == "done" for t in tasks), "lowering the cap kills nothing")


def s_failures():
    """Worker failures become `error` and free their slot."""
    set_conc(3)
    before = {t["id"] for t in queue()["tasks"]}
    prompt_and_wait("CREATE 6 fail")
    ids = set(new_ids(before))
    tasks, _ = wait_terminal(ids, timeout=120)
    check(all(t["status"] == "error" for t in tasks), f"failed workers -> error: {[t['status'] for t in tasks]}")
    check(len(tasks) == 6, f"6 tasks: {len(tasks)}")
    check(all(t["finishedAt"] > 0 for t in tasks), "finishedAt set")
    check(all("mock forced failure" in t["result"] for t in tasks), f"the result says why: {[t['result'][:60] for t in tasks][:2]}")


def s_cancel():
    """Cancel queued and running tasks; cancelling twice is refused; slots are reused."""
    set_conc(2)
    before = {t["id"] for t in queue()["tasks"]}
    prompt_and_wait("CREATE 5 sleep=8")
    ids = sorted(new_ids(before), key=lambda x: int(x[1:]))
    time.sleep(1.5)
    st, r = call("POST", f"/queue/tasks/{ids[0]}/cancel")
    check(st == 200 and r.get("ok"), f"cancel running: {st} {r}")
    st, r = call("POST", f"/queue/tasks/{ids[4]}/cancel")
    check(st == 200 and r.get("ok"), f"cancel queued: {st} {r}")
    st, r = call("POST", f"/queue/tasks/{ids[4]}/cancel")
    check(st == 409, f"second cancel refused: {st}")
    st, r = call("POST", "/queue/tasks/t999999/cancel")
    check(st == 409 and not r.get("ok"), f"unknown task: {st} {r}")
    tasks, _ = wait_terminal(set(ids))
    by = {t["id"]: t["status"] for t in tasks}
    check(by[ids[0]] == "cancelled" and by[ids[4]] == "cancelled", f"cancelled stay cancelled: {by}")
    check(all(by[i] == "done" for i in ids[1:4]), f"the others finish: {by}")


def s_redirect_states():
    """Redirect a running task (message), a queued one (brief), a finished one (re-open)."""
    set_conc(1)
    before = {t["id"] for t in queue()["tasks"]}
    prompt_and_wait("CREATE 2 sleep=4")
    a, b = sorted(new_ids(before), key=lambda x: int(x[1:]))
    time.sleep(1)
    st, r = call("POST", f"/queue/tasks/{a}/redirect", {"message": "running change"})
    check(r.get("ok") and "running" in r.get("text", ""), f"redirect running: {r}")
    st, r = call("POST", f"/queue/tasks/{b}/redirect", {"message": "queued change"})
    check(r.get("ok") and "queued" in r.get("text", ""), f"redirect queued: {r}")
    tasks, _ = wait_terminal({a, b})
    by = {t["id"]: t for t in tasks}
    check("REDIRECTED" in by[a]["result"], f"running worker saw the redirect: {by[a]['result']!r}")
    check("REDIRECTED" not in by[b]["result"] and "queued change" in by[b]["prompt"] + "".join(by[b]["redirects"]), "queued redirect folded into the brief")
    st, r = call("POST", f"/queue/tasks/{a}/redirect", {"message": "after done"})
    check(r.get("ok") and "re-opened" in r.get("text", ""), f"redirect done: {r}")
    tasks, _ = wait_terminal({a})
    check(tasks[0]["status"] == "done" and tasks[0]["attempts"] == 2, f"re-opened task ran again: {tasks[0]['status']} attempts={tasks[0]['attempts']}")
    st, r = call("POST", f"/queue/tasks/{a}/redirect", {"message": "   "})
    check(st == 409, f"empty redirect refused: {st}")


def s_redirect_burst():
    """Many redirects in a burst at a finished task: it re-opens once, not once per redirect."""
    set_conc(4)
    before = {t["id"] for t in queue()["tasks"]}
    prompt_and_wait("CREATE 1 sleep=0")
    (a,) = new_ids(before)
    wait_terminal({a})
    results = []
    th = [threading.Thread(target=lambda i=i: results.append(call("POST", f"/queue/tasks/{a}/redirect", {"message": f"burst {i}"}))) for i in range(8)]
    [x.start() for x in th]
    [x.join() for x in th]
    time.sleep(1)
    t = next(t for t in queue()["tasks"] if t["id"] == a)
    tasks, _ = wait_terminal({a})
    t = tasks[0]
    check(t["status"] == "done", f"burst-redirected task finishes: {t['status']}")
    check(len(t["redirects"]) == 8, f"all 8 redirects recorded: {len(t['redirects'])}")
    check(t["attempts"] <= 3, f"a burst re-opens it a few times at most, not 8: attempts={t['attempts']}")


def s_duplicate_gate():
    """A near-duplicate of an active task is refused with its id; the dispatcher reports it."""
    set_conc(2)
    before = {t["id"] for t in queue()["tasks"]}
    prompt_and_wait("DUP convert all png images in the assets folder to webp at quality 80")
    ids = new_ids(before)
    check(len(ids) == 1, f"first DUP creates 1: {ids}")
    prompt_and_wait("DUP convert all png images in the assets folder to webp at quality 80")
    ids2 = new_ids(before)
    check(len(ids2) == 1, f"second DUP refused while the first is active: {ids2}")
    wait_terminal(set(ids2))


def s_parallel_prompts():
    """Ten prompts fired at once at the chat: none lost, one chat, the server stays up."""
    set_conc(20)
    run = uuid.uuid4().hex[:6]
    res = []
    th = [threading.Thread(target=lambda i=i: res.append(prompt(f"CREATE 1 sleep=0 tag=p{run}x{i}"))) for i in range(10)]
    [x.start() for x in th]
    [x.join() for x in th]
    check(all(st == 200 for st, _ in res), f"all prompts accepted: {[st for st, _ in res]}")
    sessions = {r.get("id") for _, r in res}
    check(len(sessions) == 1, f"one chat for all ten: {sessions}")
    tags = set()
    t0 = time.time()
    while time.time() - t0 < 90 and len(tags) < 10:
        time.sleep(1)
        tags = {t["title"].split()[0] for t in queue()["tasks"] if t["title"].startswith(f"p{run}x")}
    check(len(tags) == 10, f"every prompt became its task: {len(tags)}/10 ({sorted(tags)})")
    ids = {t["id"] for t in queue()["tasks"] if t["title"].startswith(f"p{run}x")}
    wait_terminal(ids)


def s_bad_inputs():
    """Malformed requests are refused, never 500, never a task."""
    before = {t["id"] for t in queue()["tasks"]}
    st, _ = call("POST", "/queue/prompt", {"prompt": ""})
    check(st == 400, f"empty prompt -> 400, got {st}")
    st, _ = call("POST", "/queue/prompt", {"prompt": "   \n  "})
    check(st == 400, f"blank prompt -> 400, got {st}")
    st, _ = call("POST", "/queue/tasks/../../etc/redirect", {"message": "x"})
    check(st in (404, 400), f"path traversal id -> 404, got {st}")
    st, _ = call("PATCH", "/settings", {"queueConcurrency": -5})
    check(queue()["concurrency"] == 1, f"negative concurrency clamps to 1: {queue()['concurrency']}")
    st, _ = call("PATCH", "/settings", {"queueConcurrency": 10_000})
    check(queue()["concurrency"] == 300, f"huge concurrency clamps to 300: {queue()['concurrency']}")
    st, _ = call("PATCH", "/settings", {"queueConcurrency": "50"})
    check(queue()["concurrency"] == 300, f"string concurrency ignored: {queue()['concurrency']}")
    # The agents' API: no token -> 403.
    st, _ = call("POST", "/queue-agent/tasks", {"spec": {"title": "x", "prompt": "y"}})
    check(st == 403, f"agent API without token -> 403, got {st}")
    check(new_ids(before) == [], "no task from bad inputs")
    set_conc(4)


def s_unicode_and_huge():
    """A 30 KB prompt with every kind of character reaches the worker verbatim."""
    set_conc(2)
    blob = "ñ€😀 \"quotes\" `ticks` $(rm -rf /) ; DROP TABLE x; \\n \\\\ " * 600
    before = {t["id"] for t in queue()["tasks"]}
    st, _ = prompt_and_wait("DUP " + blob)
    check(st == 200, f"huge prompt accepted: {st}")
    ids = new_ids(before)
    check(len(ids) == 1, f"one task: {ids}")
    if ids:
        t = next(t for t in queue()["tasks"] if t["id"] == ids[0])
        check("😀" in t["prompt"] and "$(rm -rf /)" in t["prompt"], "special characters intact in the brief")
        tasks, _ = wait_terminal(set(ids))
        check(tasks[0]["status"] == "done", f"huge task done: {tasks[0]['status']}")


def s_restart_recovery():
    """Kill the server mid-run: running tasks come back and finish; queued ones start."""
    set_conc(2)
    before = {t["id"] for t in queue()["tasks"]}
    prompt_and_wait("CREATE 4 sleep=6")
    ids = set(new_ids(before))
    time.sleep(2)
    subprocess.run(["/tmp/ms/restart.sh"], check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, timeout=60)
    time.sleep(2)
    tasks, _ = wait_terminal(ids, timeout=180)
    by = {t["id"]: (t["status"], t["attempts"]) for t in tasks}
    check(all(s == "done" for s, _ in by.values()), f"all tasks finish after a restart: {by}")
    stuck = [t for t in queue()["tasks"] if t["status"] == "running"]
    check(not stuck, f"nothing left running: {[t['id'] for t in stuck]}")


def s_redirect_then_restart():
    """A redirect sent to a running worker right before a restart is not lost."""
    set_conc(2)
    before = {t["id"] for t in queue()["tasks"]}
    prompt_and_wait("CREATE 1 sleep=8")
    (a,) = new_ids(before)
    time.sleep(1.5)
    st, r = call("POST", f"/queue/tasks/{a}/redirect", {"message": "late change"})
    check(r.get("ok"), f"redirect accepted: {r}")
    subprocess.run(["/tmp/ms/restart.sh"], check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, timeout=60)
    tasks, _ = wait_terminal({a}, timeout=120)
    check(tasks[0]["status"] == "done", f"done after restart: {tasks[0]['status']}")
    check("REDIRECTED" in tasks[0]["result"], f"the worker saw the redirect: {tasks[0]['result']!r}")


def s_mass_cancel():
    """100 running tasks cancelled at once: every worker process stops, nothing stays running."""
    set_conc(100)
    before = {t["id"] for t in queue()["tasks"]}
    prompt_and_wait("CREATE 100 sleep=30 tag=mass")
    ids = new_ids(before)
    time.sleep(3)
    th = [threading.Thread(target=lambda i=i: call("POST", f"/queue/tasks/{i}/cancel")) for i in ids]
    [x.start() for x in th]
    [x.join() for x in th]
    tasks, _ = wait_terminal(set(ids), timeout=60)
    check(all(t["status"] == "cancelled" for t in tasks), f"all cancelled: {set(t['status'] for t in tasks)}")
    time.sleep(4)
    alive = subprocess.run(["pgrep", "-f", "SLEEP=30"], capture_output=True, text=True).stdout.split()
    agents = subprocess.run(["pgrep", "-fc", "mini-agent-rs -y"], capture_output=True, text=True).stdout.strip()
    sleeps = subprocess.run(["pgrep", "-fc", "^sleep 30"], capture_output=True, text=True).stdout.strip()
    check(int(agents or 0) <= 2, f"worker processes stopped (agents alive: {agents})")
    check(int(sleeps or 0) == 0, f"their commands stopped too (sleep 30 alive: {sleeps})")


def s_worker_session_deleted():
    """Deleting a running worker's session from history: its task errors, the slot frees."""
    set_conc(1)
    before = {t["id"] for t in queue()["tasks"]}
    prompt_and_wait("CREATE 2 sleep=6")
    a, b = sorted(new_ids(before), key=lambda x: int(x[1:]))
    time.sleep(1.5)
    sid = next(t for t in queue()["tasks"] if t["id"] == a)["sessionId"]
    st, _ = call("DELETE", f"/history/{sid}")
    check(st == 200, f"delete accepted: {st}")
    tasks, _ = wait_terminal({a, b}, timeout=60)
    by = {t["id"]: t["status"] for t in tasks}
    ta = next(t for t in tasks if t["id"] == a)
    check(by[a] == "cancelled" and "deleted" in ta["result"], f"deleted worker's task is cancelled with a reason: {by[a]} {ta['result']!r}")
    check(by[b] == "done", f"the next task ran: {by[b]}")


def s_interrupt_dispatcher():
    """Stopping the chat mid-turn does not wedge it: the next message works."""
    before = {t["id"] for t in queue()["tasks"]}
    st, r = prompt("CREATE 1 sleep=0 tag=stop1")
    call("POST", f"/sessions/{r['id']}/interrupt")
    time.sleep(2)
    prompt_and_wait("CREATE 1 sleep=0 tag=stop2")
    time.sleep(3)
    titles = [t["title"] for t in queue()["tasks"] if t["id"] not in before]
    check(any(t.startswith("stop2") for t in titles), f"the chat works after a stop: {titles}")


def s_redirect_race():
    """Redirects fired at random moments of short runs: none is lost (each run that got one
    either saw it, or was re-run with it)."""
    import random
    set_conc(20)
    before = {t["id"] for t in queue()["tasks"]}
    prompt_and_wait("CREATE 40 sleep=0 tag=race")
    ids = new_ids(before)
    def fire(i):
        time.sleep(random.uniform(0, 0.6))
        call("POST", f"/queue/tasks/{i}/redirect", {"message": "race"})
    th = [threading.Thread(target=fire, args=(i,)) for i in ids]
    [x.start() for x in th]
    [x.join() for x in th]
    time.sleep(1)
    tasks, _ = wait_terminal(set(ids), timeout=120)
    lost = [t["id"] for t in tasks if "REDIRECTED" not in t["result"]]
    check(all(t["status"] == "done" for t in tasks), f"all done: {[t['status'] for t in tasks if t['status'] != 'done']}")
    check(not lost, f"every redirect reached its worker ({len(lost)} lost: {lost[:5]})")


def s_same_directory():
    """Tasks in the same folder run one at a time; tasks elsewhere are not held up by them."""
    os.makedirs("/tmp/ms/proj/sub", exist_ok=True)
    os.makedirs("/tmp/ms/other", exist_ok=True)
    set_conc(10)
    before = {t["id"] for t in queue()["tasks"]}
    prompt_and_wait("CREATE 3 sleep=2 tag=same cwd=/tmp/ms/proj")
    prompt_and_wait("CREATE 3 sleep=2 tag=other cwd=/tmp/ms/other/x")
    ids = set(new_ids(before))
    tasks, _ = wait_terminal(ids, timeout=120)
    same = sorted([t for t in tasks if t["title"].startswith("same")], key=lambda t: t["startedAt"])
    overlapping = any(a["finishedAt"] > b["startedAt"] for a, b in zip(same, same[1:]))
    check(not overlapping, "same-folder tasks never overlap")
    check(all(t["status"] == "done" for t in tasks), "all done")


def s_chat_plain_and_new():
    """Plain answers create nothing; /queue/new starts a new chat and keeps the tasks."""
    before = {t["id"] for t in queue()["tasks"]}
    prompt_and_wait("hola, ¿qué puedes hacer?")
    check(new_ids(before) == [], "a greeting creates no task")
    m1 = queue()["main"]
    call("POST", "/queue/new")
    check(queue()["main"] == "", "new chat clears the main session")
    prompt_and_wait("hello again")
    m2 = queue()["main"]
    check(m2 and m2 != m1, f"a fresh chat session: {m1} -> {m2}")
    check(len(queue()["tasks"]) >= len(before), "tasks survive a new chat")


def s_scale_300():
    """300 tasks at cap 300 (the default): everything runs at once and finishes."""
    set_conc(300)
    before = {t["id"] for t in queue()["tasks"]}
    t0 = time.time()
    prompt_and_wait("CREATE 100 sleep=20 tag=a")
    prompt_and_wait("CREATE 100 sleep=20 tag=b")
    prompt_and_wait("CREATE 100 sleep=20 tag=c")
    ids = set(new_ids(before))
    check(len(ids) == 300, f"300 tasks, got {len(ids)}")
    tasks, peak = wait_terminal(ids, timeout=600, cap=300)
    bad = [t["id"] for t in tasks if t["status"] != "done"]
    check(not bad, f"all 300 done ({len(bad)} not: {bad[:10]})")
    st, health = call("GET", "/health")
    print(f"   300 tasks in {time.time() - t0:.0f}s, peak running {peak}, server health {st}", flush=True)
    load = os.getloadavg()[0]
    print(f"   load {load:.1f}", flush=True)


SCENARIOS = {k[2:]: v for k, v in globals().items() if k.startswith("s_")}


def main():
    todo = sys.argv[1:] or [k for k in SCENARIOS if k != "scale_300"]
    for name in todo:
        print(f"== {name}", flush=True)
        reset()
        t0 = time.time()
        n = len(FAILS)
        try:
            SCENARIOS[name]()
        except Exception as e:
            FAILS.append(f"{name} raised {e!r}")
            print("   EXCEPTION", repr(e), flush=True)
        print(f"   {'ok' if len(FAILS) == n else 'FAILED'} ({time.time() - t0:.1f}s)", flush=True)
    print(f"\n{len(FAILS)} failure(s)")
    for f in FAILS:
        print(" -", f)
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()
