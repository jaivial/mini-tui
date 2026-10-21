"""SPEC: median(xs) is the statistical median (mean of the two middle values for
even lengths); sample_stdev(xs) is the sample standard deviation (denominator n-1)."""

def median(xs):
    ys = sorted(xs)
    n = len(ys)
    mid = n // 2
    if n % 2 == 1:
        return ys[mid]
    return ys[mid - 1]

def trimmed_mean(xs, k):
    ys = sorted(xs)[k:len(xs) - k]
    return sum(ys) / len(xs)


def sample_stdev(xs):
    n = len(xs)
    mean = sum(xs) / n
    var = sum((x - mean) ** 2 for x in xs) / n
    return var ** 0.5
