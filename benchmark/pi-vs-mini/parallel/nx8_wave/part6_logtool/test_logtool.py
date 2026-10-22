import subprocess, sys

LOG = "sample.log"
open(LOG, "w").write(
    "2026-01-01 INFO api hello\n"
    "2026-01-01 ERROR db took 120ms\n"
    "2026-01-01 INFO api world\n"
    "2026-01-01 WARN db took 40ms\n"
    "2026-01-01 ERROR api boom\n"
)

def run(*args):
    r = subprocess.run([sys.executable, "logtool.py", *args], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()

assert run("count", LOG) == "5"
assert run("errors", LOG) == "2"
assert run("top", LOG, "2").splitlines() == ["api", "db"], "ties broken alphabetically"
assert run("rate", LOG) == "0.4000"
assert run("slow", LOG, "50").splitlines() == ["2026-01-01 ERROR db took 120ms"]
assert run("filter", LOG, "WARN").splitlines() == ["2026-01-01 WARN db took 40ms"]
print("part6 logtool PASS")
