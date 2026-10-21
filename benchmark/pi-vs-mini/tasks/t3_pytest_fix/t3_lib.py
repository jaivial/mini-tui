import re
from collections import Counter

def top_words(text):
    """Return the (word, count) pairs of `text`, most frequent first,
    ties broken alphabetically. Case-insensitive. Punctuation is not a word char."""
    # IMPLEMENTATION IS BUGGY: fix it so the tests pass.
    words = text.split()
    counts = Counter(words)
    return sorted(counts.items(), key=lambda kv: -kv[1])
