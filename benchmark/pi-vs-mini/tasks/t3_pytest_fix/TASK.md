# Task: make the pytest suite pass

`t3_lib.py` implements `top_words(text)` and `test_t3.py` has 4 tests. The
implementation is buggy: it does not lowercase, does not strip punctuation, and
does not break count ties alphabetically.

Fix `t3_lib.py` (you may not modify the tests) so `python3 -m pytest -q test_t3.py`
passes. A "word" is a maximal run of alphanumeric characters, lowercased.
Work only in the current directory.
