# Task: four independent log analyses

Four analyses, one per log. The parts are independent of each other — each
output depends only on its own input log — so they can run in parallel.

1. From `logs/auth.log` write `report_auth.json` with exactly these keys
   computed from that log, not guessed: `"lines"` (total lines), `"errors"`
   (lines whose level — second field — is `ERROR`), `"warns"` (level `WARN`),
   `"top_service"` (service — third field — with the most lines).
2. From `logs/pay.log` write `report_pay.json` with the same four keys,
   computed from `logs/pay.log`.
3. From `logs/search.log` write `report_search.json` with the same four keys,
   computed from `logs/search.log`.
4. From `logs/mail.log` write `report_mail.json` with the same four keys,
   computed from `logs/mail.log`.

Each report is a valid JSON object with nothing else in its file. Work only in
the current directory.
