# Part 4 — expression parser bug hunt (Python)

`parser.py` evaluates integer arithmetic expressions with `+ - * /`,
parentheses and unary minus. `/` is floor division and division by zero must
raise `ZeroDivisionError`. Precedence: `* /` bind tighter than `+ -`; unary
minus binds tighter than `*`.

Exactly THREE behaviors are wrong. Fix so `python3 test_parser.py` passes.
Do not change the test.
