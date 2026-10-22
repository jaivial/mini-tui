"""Statistical toolkit. Several behaviors are wrong or missing (SPEC.md)."""

import math


def percentile(xs, p):
    ys = sorted(xs)
    return ys[math.floor(p / 100 * len(ys))]


def weighted_mean(xs, ws):
    return sum(x * w for x, w in zip(xs, ws)) / len(xs)


def histogram(xs, bins):
    return [0] * bins


def pearson(xs, ys):
    n = len(xs)
    mx = sum(xs) / n
    my = sum(ys) / n
    cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    return cov / n


def outliers(xs):
    return sorted(xs)


def ewma(xs, alpha):
    return xs
