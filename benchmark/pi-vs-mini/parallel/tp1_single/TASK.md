# Task: single log analysis (auth)

From `logs/auth.log` write `report_auth.json` (valid JSON, nothing else in the
file) with exactly these keys computed from the log, not guessed:

- `"lines"`: total number of log lines;
- `"errors"`: count of lines whose level (second field) is `ERROR`;
- `"warns"`: count of lines whose level is `WARN`;
- `"top_service"`: the service (third field) with the most lines.

Work only in the current directory.
