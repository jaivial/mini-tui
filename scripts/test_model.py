"""Test a model connection through mini's own model layer.

Usage: python3 test_model.py "<model name>"   (key provided via env)
Exits 0 when a one-token completion succeeds, 1 otherwise. Importing minisweagent
loads the global config; provider keys from the TUI arrive as env vars.
"""

import sys


def main() -> None:
    model_name = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        from minisweagent.models import get_model

        model = get_model(model_name)
        message = model.query([{"role": "user", "content": "Reply with the single word: ok"}])
        text = str(message.get("content") or (message.get("extra") or {}).get("submission") or "").strip()
        if text:
            print("ok")
            return
    except Exception as error:  # noqa: BLE001 - any failure means the connection is broken
        print(f"error: {error}", file=sys.stderr)
    raise SystemExit(1)


if __name__ == "__main__":
    main()
