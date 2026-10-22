import math
import pytest
from statkit import percentile, weighted_mean, histogram, pearson, outliers, ewma

assert percentile([1, 2, 3, 4], 50) == 2
assert percentile([1, 2, 3, 4], 100) == 4
assert percentile([5], 50) == 5
assert weighted_mean([2, 4], [1, 3]) == 3.5
with pytest.raises(ValueError):
    weighted_mean([], [])
with pytest.raises(ValueError):
    weighted_mean([1, 2], [1])
assert histogram([0, 1, 2, 3], 2) == [2, 2]
assert histogram([1, 1, 1], 3) == [3, 0, 0]
assert abs(pearson([1, 2, 3], [2, 4, 6]) - 1.0) < 1e-9
assert abs(pearson([1, 2, 3], [-2, -4, -6]) + 1.0) < 1e-9
with pytest.raises(ValueError):
    pearson([1, 1, 1], [1, 2, 3])
assert outliers([10, 12, 11, 13, 12, 100]) == [100]
assert outliers([1, 2, 3]) == []
assert ewma([1, 2, 3], 0.5) == [1, 1.5, 2.25]
print("part4 statkit PASS")
