import statistics
from stats import median, sample_stdev, trimmed_mean
assert median([1, 2, 3, 4]) == 2.5, "even length: mean of the two middle values"
assert median([1, 3, 2]) == 2, "odd length: the middle value"
assert abs(sample_stdev([2, 4, 4, 4, 5, 5, 7, 9]) - statistics.stdev([2, 4, 4, 4, 5, 5, 7, 9])) < 1e-9, "sample stdev, denominator n-1"
assert abs(trimmed_mean([1, 2, 3, 4, 100], 1) - 3) < 1e-9, "drop one each end, mean the rest"
print("stats tests PASS")
