from stats2 import mode, percentile, trimmed_mean
assert mode([1, 2, 2, 3, 3]) == 2, "tie at 2 and 3: the smallest wins"
assert mode([5, 5, 1]) == 5, "clear winner"
assert percentile([1, 2, 3, 4], 50) == 2, "nearest-rank p50"
assert percentile([1, 2, 3, 4], 75) == 3, "nearest-rank p75"
assert abs(trimmed_mean([1, 2, 3, 4, 100], 1) - 3) < 1e-9, "trimmed mean"
print("stats2 tests PASS")
