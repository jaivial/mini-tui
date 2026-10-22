# Part 5 — insights.json

From `orders.csv` (order_id, customer_id, item_id, qty, amount_cents, date),
`customers.csv` and `items.csv`, write `insights.json` with EXACTLY these keys:

- `revenue_by_country`: every country -> total amount_cents of its orders
- `top_category`: the category with the most units sold (sum of qty)
- `aov_by_month`: every YYYY-MM -> average order amount_cents, rounded DOWN
- `best_customer`: the customer_id with the highest total amount_cents (tie: the
  smallest id)
- `orders_over_10k`: the number of orders with amount_cents > 10000
- `units_by_category`: every category -> total qty
- `revenue_total`: total amount_cents of all orders
- `months_active`: the number of distinct YYYY-MM values

All numbers are integers. Compute from the files, not guesses.
