# Task: error breakdown of a service log as JSON

`logs/service.log` (3000 lines, `<iso-timestamp> <LEVEL> <message>`) contains
three distinct ERROR message shapes:

- `NullPointerException at <class> (<file>:<line>)`
- `TimeoutException waiting for <thing>`
- `SQLException: <reason>`

Write `report.json` in the current directory: valid JSON with, per error type,
its exact count in the file, plus a `"total_errors"` key with the overall ERROR
line count and a `"first_seen"` object mapping each error type to the timestamp
of its first occurrence. Work only in the current directory.
