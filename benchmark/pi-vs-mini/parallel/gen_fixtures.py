#!/usr/bin/env python3
"""Deterministic logs for the parallel (decomposable) corpus.

Every subtask reads its OWN log and writes its OWN report, so a wave of workers
never touches the same file. The verifiers derive ground truth from the same
logs, so any compliant log works; the seed keeps reruns identical. Service-name
weights are built with no tie near the top so `top_service` is unambiguous.
"""
import os
import random

BASE = os.path.dirname(os.path.abspath(__file__))

# (name, [(service, weight)], n_lines) — weights sum to 10000 for clean choices.
LOGS = [
    ("auth",   [("token-svc", 3400), ("session-svc", 2200), ("password-svc", 1600),
                ("mfa-svc", 1300), ("oauth-svc", 900), ("audit-svc", 600)]),
    ("pay",    [("charge-svc", 3600), ("refund-svc", 2100), ("ledger-svc", 1800),
                ("fraud-svc", 1400), ("payout-svc", 700), ("receipt-svc", 400)]),
    ("search", [("indexer", 3200), ("query-svc", 2600), ("ranker", 1700),
                ("suggest", 1300), ("crawler", 800), ("dict-svc", 400)]),
    ("mail",   [("sender-svc", 3300), ("template-svc", 2300), ("bounce-svc", 1700),
                ("list-svc", 1400), ("tracking-svc", 900), ("archive-svc", 400)]),
]
N_LINES = 12000


def write_log(name, services, seed):
    rng = random.Random(seed)
    names = [s for s, _ in services]
    weights = [w for _, w in services]
    lines = []
    for i in range(N_LINES):
        ts = f"2026-10-21T{(i // 3000) % 24:02d}:{(i // 50) % 60:02d}:{(i * 7) % 60:02d}Z"
        roll = rng.random()
        if roll < 0.10:
            level, msg = "ERROR", f"op failed after {rng.randint(2, 30)} retries"
        elif roll < 0.22:
            level, msg = "WARN", f"slow op: {rng.randint(400, 3000)}ms"
        else:
            level, msg = "INFO", f"handled in {rng.randint(1, 120)}ms"
        svc = rng.choices(names, weights)[0]
        lines.append(f"{ts} {level} {svc} {msg}\n")
    path = os.path.join(BASE, "logs", f"{name}.log")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.writelines(lines)
    print(f"{path}: {len(lines)} lines")


if __name__ == "__main__":
    for k, (name, services) in enumerate(LOGS):
        write_log(name, services, seed=100 + k)
    # The runner copies a task dir as the agent's workspace, so each task carries
    # the logs its parts need (hardlinks where possible; plain copy across dirs).
    import shutil
    needs = {"tp1_single": ["auth"],
             "tp2_pair": ["auth", "pay"],
             "tp4_quad": ["auth", "pay", "search", "mail"]}
    for task, names in needs.items():
        dst = os.path.join(BASE, task, "logs")
        os.makedirs(dst, exist_ok=True)
        for name in names:
            src = os.path.join(BASE, "logs", f"{name}.log")
            link = os.path.join(dst, f"{name}.log")
            if not os.path.exists(link):
                try:
                    os.link(src, link)
                except OSError:
                    shutil.copy2(src, link)
    print("task logs placed")
