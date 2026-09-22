"""Generate a short session title with the same model layer mini uses.

Usage: python3 gen_title.py "<task>" "<model name>"
Prints a JSON string (possibly empty on any failure). Importing minisweagent
loads the global config (~/.config/mini-swe-agent/.env), where the API keys live.
"""

import json
import sys


def main() -> None:
    task = sys.argv[1] if len(sys.argv) > 1 else ""
    model_name = sys.argv[2] if len(sys.argv) > 2 else ""
    try:
        from minisweagent.models import get_model

        model = get_model(model_name)
        message = model.query(
            [
                {
                    "role": "user",
                    "content": (
                        "Write a short title (max 8 words, no quotes, no trailing punctuation) "
                        "for this coding task. Reply with ONLY the title.\n\nTASK:\n" + task
                    ),
                }
            ]
        )
        extra = message.get("extra") or {}
        text = str(extra.get("submission") or message.get("content") or "").strip()
        title = " ".join(text.splitlines()[0].split()) if text else ""
        print(json.dumps(title[:60]))
    except Exception:
        print(json.dumps(""))


if __name__ == "__main__":
    main()
