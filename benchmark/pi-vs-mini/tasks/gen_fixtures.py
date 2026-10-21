#!/usr/bin/env python3
"""Deterministic generators for the three corpus fixtures that are too big for git.

`t1_wordfreq/logs/app.log`, `t6_readme_summary/logs/access.log` and
`t10_crash_report/logs/service.log` are generated, seeded logs: the verifiers
derive their ground truth from the log itself, so any compliant log works and a
fixed seed keeps every rerun identical. Run when the logs are missing —
`run_bench.py` does that automatically before the first task.
"""
import os
import random

BASE = os.path.dirname(os.path.abspath(__file__))


def write(task, rel, lines):
    path = os.path.join(BASE, task, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.writelines(lines)
    print(f"{path}: {len(lines)} lines")


def t1_app_log():
    """20000 x `<date> <time> <LEVEL> worker-<N> <word> id=<I> value=<V>`."""
    rng = random.Random(42)
    words = ["request", "cache", "worker", "flush", "retry", "index", "queue",
             "socket", "timer", "batch", "token", "cursor", "buffer", "stream",
             "signal", "ticket", "socket", "lease", "quota", "shadow"]
    # skewed counts so the top-5 is unambiguous (no tie near rank 5)
    weights = [600, 520, 460, 400, 350] + [120, 110, 100, 95, 90, 80, 75, 70,
               65, 60, 55, 50, 45, 40, 35]
    levels = ["INFO"] * 8 + ["WARN"] * 2 + ["ERROR"]
    lines = []
    for i in range(20000):
        date = f"2026-10-{19 + i // 10000}"
        time = f"{(i // 3600) % 24:02d}:{(i // 60) % 60:02d}:{i % 60:02d}"
        word = rng.choices(words, weights)[0]
        lines.append(f"{date} {time} {rng.choice(levels)} worker-{i % 8} "
                     f"{word} id={100000 + i} value={rng.randint(1, 9999)}\n")
    write("t1_wordfreq", "logs/app.log", lines)


def t6_access_log():
    """5000 combined-format lines ending in `rt=<ms>`; /api/users 500s, /api/reports slowest."""
    rng = random.Random(7)
    routes = [("/api/users", 0.30), ("/api/orders", 0.20), ("/static/app.js", 0.20),
              ("/api/reports", 0.15), ("/login", 0.10), ("/health", 0.05)]
    ips = ["10.0.0.%d" % n for n in range(1, 12)]
    lines = []
    for i in range(5000):
        route = rng.choices([r for r, _ in routes], [w for _, w in routes])[0]
        if route == "/api/users":
            status = 500 if rng.random() < 0.45 else 200          # the failing route
        elif route == "/api/orders":
            status = 503 if rng.random() < 0.12 else 200
        else:
            status = 200 if rng.random() > 0.02 else 404
        rt = {" /api/reports": 0}.get("", 0)
        if route == "/api/reports":
            rt = rng.randint(800, 1400)                            # highest mean rt
        elif route == "/api/users":
            rt = rng.randint(40, 180)
        else:
            rt = rng.randint(5, 90)
        hh, mm, ss = i // 300, (i // 5) % 60, (i * 7) % 60
        size = rng.randint(180, 4200)
        lines.append(f'{rng.choice(ips)} - - [21/Oct/2026:{hh:02d}:{mm:02d}:{ss:02d} +0000] '
                     f'"GET {route} HTTP/1.1" {status} {size} "https://site.example/page" '
                     f'"Mozilla/5.0" rt={rt}\n')
    write("t6_readme_summary", "logs/access.log", lines)


def t10_service_log():
    """3000 x `<iso-timestamp> <LEVEL> <message>` with the three ERROR shapes."""
    rng = random.Random(1234)
    things = ["upstream payment-gateway", "redis lock", "s3 upload", "ldap bind",
              "kafka producer", "dns resolver"]
    reasons = ["connection reset during transaction", "deadlock detected on orders_pkey",
               "syntax error near \"orders\"", "duplicate key value violates unique constraint"]
    classes = [("com.shop.checkout.CartService", "CartService.java"),
               ("com.shop.orders.OrderMapper", "OrderMapper.java"),
               ("com.shop.auth.SessionManager", "SessionManager.java")]
    lines = []
    for i in range(3000):
        ts = f"2026-10-21T{(i // 600) % 24:02d}:{(i // 10) % 60:02d}:{i % 10}0,20{i % 90:02d}"
        roll = rng.random()
        if roll < 0.12:
            cls, f = rng.choice(classes)
            msg = f"NullPointerException at {cls} ({f}:{rng.randint(20, 480)})"
            level = "ERROR"
        elif roll < 0.20:
            msg = f"TimeoutException waiting for {rng.choice(things)}"
            level = "ERROR"
        elif roll < 0.26:
            msg = f"SQLException: {rng.choice(reasons)}"
            level = "ERROR"
        else:
            level = "INFO" if roll < 0.9 else "WARN"
            msg = f"handled request #{i} in {rng.randint(2, 400)}ms"
        lines.append(f"{ts} {level} {msg}\n")
    write("t10_crash_report", "logs/service.log", lines)


if __name__ == "__main__":
    t1_app_log()
    t6_access_log()
    t10_service_log()
