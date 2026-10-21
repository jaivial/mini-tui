# Task: make shop.prices match its documented contract

`shop/prices.py` documents its contract in the docstrings but `price_for`
violates it: unknown codes must raise `ValueError`, the function currently
returns `None`. `apply_discount` truncates with `int()` instead of rounding to the
nearest cent (e.g. 250 at 25 % is 187.5 and must become 188).

Make `python3 -m pytest -q test_prices.py` pass without touching the tests.
Work only in the current directory.
