"""SPEC: mode(xs) is the most frequent value, ties broken by the SMALLEST value.
percentile(xs, p) is the nearest-rank percentile: the ceil(p/100*n)-th smallest."""

from collections import Counter
import math

def mode(xs):
    c = Counter(xs)
    best = max(c.values())
    return max(v for v, n in c.items() if n == best)

def percentile(xs, p):
    ys = sorted(xs)
    return ys[math.floor(p / 100 * len(ys))]
