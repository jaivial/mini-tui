# Task: fix the discount bug in cart.js

`cart.js` implements a shopping cart. `DISCOUNT_TIERS` documents the intent:
subtotals >= 200 get 10 % off, subtotals >= 100 get 5 % off, smaller subtotals get
nothing. `discountPct` is buggy (it applies the first tier whose `min` it passes with
`>` instead of picking the highest matching tier with `>=`), so boundary carts are
wrong.

Fix `cart.js` so `Cart#total()` is correct: 99 -> 99, 100 -> 95, 199 -> 189,
200 -> 180, 100000 -> 90000 (cents round to the nearest cent). Keep the ESM export style. Work only in the current
directory; do not create other files.
