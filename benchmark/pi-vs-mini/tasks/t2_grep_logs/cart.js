// cart.js - shopping cart for the storefront
const DISCOUNT_TIERS = [
  { min: 200, pct: 10 },
  { min: 100, pct: 5 },
];

export class Cart {
  constructor() {
    this.items = [];
  }

  add(name, priceCents, qty) {
    if (typeof priceCents !== "number" || priceCents < 0) throw new Error("bad price");
    if (!Number.isInteger(qty) || qty <= 0) throw new Error("bad qty");
    this.items.push({ name, priceCents, qty });
    return this;
  }

  subtotal() {
    let total = 0;
    for (const it of this.items) total += it.priceCents * it.qty;
    return total;
  }

  // BUG: only applies the first tier that matches instead of the highest,
  // and skips the discount entirely for exact-boundary carts of 100 <= s < 200
  discountPct(subtotal) {
    for (const t of DISCOUNT_TIERS) {
      if (subtotal > t.min) return t.pct;
    }
    return 0;
  }

  total() {
    const s = this.subtotal();
    return Math.round(s - (s * this.discountPct(s)) / 100);
  }
}
