// SPEC: shipping(subtotalCents) = 750, or 0 when subtotalCents >= 10000.
//        handling(items) = 50 per item when items > 20, else 0.
export function shipping(subtotalCents) {
  return subtotalCents > 10000 ? 0 : 750;
}
export function handling(items) {
  return items >= 20 ? items * 50 : 0;
}
