# Task: revenue report from sales.csv

`sales.csv` has columns `id,city,units,price,returned` (500 rows; `returned` is
`true`/`false`). Write `report.json` in the current directory with:

- `"cities"`: an object keyed by city. Each value has `"orders"` (row count),
  `"units"` (sum of units of non-returned rows), `"revenue"` (sum of
  units*price of non-returned rows, rounded to 2 decimals) and
  `"returned_orders"` (count of returned rows).
- `"top_city"`: the city with the highest non-returned revenue.

Work only in the current directory. report.json must be valid JSON.
