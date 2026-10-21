// SPEC: tax(amountCents) = 8% of amount, rounded DOWN to whole cents.
//        bulkDiscount(qty) = 10% off the unit price when qty >= 6, else none.
export function tax(amountCents) {
  return Math.round(amountCents * 0.08);
}
export function bulkDiscount(qty) {
  return qty > 6 ? 0.9 : 1;
}
