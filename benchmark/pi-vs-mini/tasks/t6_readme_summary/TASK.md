# Task: why is the site failing? read the access log

`logs/access.log` is a 5000-line combined-format access log with an extra
`rt=<ms>` request-time field at the end of each line. Write `ANALYSIS.md` in the
current directory (markdown, any length) that states, with the exact numbers:

1. which route returns the 5xx responses and how many 5xx responses it returned;
2. the total number of 5xx responses in the file;
3. which route has the highest mean request time (`rt`) and roughly what that
   mean is in ms;
4. one sentence on what you would investigate next.

The numbers must be computed from the log, not guessed. Work only in the
current directory.
