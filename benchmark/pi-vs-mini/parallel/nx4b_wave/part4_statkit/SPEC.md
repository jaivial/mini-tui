# Part 4 — statkit (Python)

Make `python3 test_statkit.py` pass. `statkit.py` must provide: `percentile`,
`weighted_mean`, `histogram`, `pearson`, `outliers`, `ewma`.

- `percentile(xs, p)` — nearest-rank (ceil(p/100*n)-th smallest), p in (0,100]
- `weighted_mean(xs, ws)` — sum(x*w)/sum(w); raises `ValueError` on empty or
  mismatched lengths
- `histogram(xs, bins)` — `bins` equal-width from min to max (inclusive right
  edge on the last); returns the list of counts
- `pearson(xs, ys)` — Pearson correlation; raises `ValueError` if either has
  zero variance
- `outliers(xs)` — values outside [q1 - 1.5*IQR, q3 + 1.5*IQR], q1/q3 by
  nearest-rank percentile, returned sorted
- `ewma(xs, alpha)` — exponential moving average, seeded with xs[0], one value
  per input

Do not change the test.
