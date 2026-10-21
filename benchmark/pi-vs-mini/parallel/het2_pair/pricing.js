// Tiered pricing. SPEC: price(unit, qty) = unit * qty with a quantity discount
// of 15% when qty >= 10, 5% when qty >= 5, else none; the result is rounded to
// whole cents (2 decimals).
export function price(unit, qty) {
  let total = unit * qty;
  if (qty > 10) {
    total *= 0.9;
  } else if (qty >= 5) {
    total *= 0.95;
  }
  return Math.round(total * 100) / 100;
}
