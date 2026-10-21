#!/usr/bin/env python3
"""Heavy seeded logs for the Nx (delegable) corpus: parts of a minute-scale workload.

Each part is a full analysis + report over one 30k-line log: totals, error rate,
error-shape top-3, latency percentiles, worst hour, top service. Verifiers
recompute every number from the log, so the corpus stays deterministic and the
report's content is objectively checkable. Logs land in each task dir (the
runner copies the task dir as the workspace).
"""
import os
import random

BASE = os.path.dirname(os.path.abspath(__file__))
N_LINES = 30000

LOGS = {
    "miss":   [("token-svc", 3300), ("session-svc", 2200), ("password-svc", 1500),
               ("mfa-svc", 1400), ("oauth-svc", 1000), ("audit-svc", 600)],
    "orders": [("charge-svc", 3400), ("refund-svc", 2200), ("ledger-svc", 1800),
               ("fraud-svc", 1300), ("payout-svc", 800), ("receipt-svc", 500)],
    "index":  [("indexer", 3100), ("query-svc", 2500), ("ranker", 1800),
               ("suggest", 1300), ("crawler", 800), ("dict-svc", 500)],
    "notify": [("sender-svc", 3200), ("template-svc", 2300), ("bounce-svc", 1800),
               ("list-svc", 1400), ("tracking-svc", 800), ("archive-svc", 500)],
}
SHAPES = ["TimeoutException waiting for upstream", "NullPointerException at Checkout",
          "SQLException: connection reset", "RateLimitException: quota exceeded",
          "IOException: broken pipe"]


def write_log(name, services, seed):
    rng = random.Random(seed)
    names = [s for s, _ in services]
    weights = [w for _, w in services]
    lines = []
    for i in range(N_LINES):
        hour = (i * 7 + rng.randint(0, 3)) % 24          # worst hour = hour 3 (seeded bias below)
        if name == "miss" and rng.random() < 0.30:
            hour = 3
        elif name == "orders" and rng.random() < 0.30:
            hour = 17
        elif name == "index" and rng.random() < 0.30:
            hour = 8
        elif name == "notify" and rng.random() < 0.30:
            hour = 21
        minute, second = i % 60, (i * 11) % 60
        if rng.random() < 0.13:
            level, shape = "ERROR", rng.choices(SHAPES, [40, 25, 20, 10, 5])[0]
        elif rng.random() < 0.10:
            level, shape = "WARN", "slow operation"
        else:
            level, shape = "INFO", "request handled"
        lat = int(rng.lognormvariate(4.1, 0.7))
        svc = rng.choices(names, weights)[0]
        lines.append(f"2026-10-21T{hour:02d}:{minute:02d}:{second:02d}Z {level} {svc} {lat}ms {shape}\n")
    path = os.path.join(BASE, "logs", f"{name}.log")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.writelines(lines)
    print(f"{path}: {len(lines)} lines")


if __name__ == "__main__":
    for k, (name, services) in enumerate(LOGS.items()):
        write_log(name, services, seed=900 + k)
    import shutil
    needs = {"ph1_single": ["miss"],
             "ph2_pair": ["miss", "orders"],
             "ph4_quad": ["miss", "orders", "index", "notify"],
             "het2_pair": ["miss"],
             "het4_quad": ["miss"]}
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
    print("heavy task logs placed")
