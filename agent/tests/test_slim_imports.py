"""The default package import must not pay for optional terminal/UI stacks."""

import os
import subprocess
import sys


def _import_modules(code: str):
    env = os.environ.copy()
    env.update({"MSWEA_SILENT_STARTUP": "1", "PYTHONPATH": os.pathsep.join(sys.path)})
    return subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        env=env,
        check=True,
    ).stdout.strip().splitlines()


def test_package_and_embedded_entry_are_lightweight():
    assert _import_modules("import minisweagent; print('rich' in __import__('sys').modules)") == ["False"]
    assert _import_modules("import minisweagent.run.tui; print('rich' in __import__('sys').modules)") == ["False"]
    assert _import_modules("import minisweagent.run.tui; print('typer' in __import__('sys').modules)") == ["False"]
    assert _import_modules("import minisweagent.run.tui; print('minisweagent.agents.interactive' in __import__('sys').modules)") == ["False"]
