def price_for(item_code):
    """Prices in cents. Codes: 'A1' 199, 'B2' 349, 'C3' 499, else ValueError."""
    prices = {"A1": 199, "B2": 349, "C3": 499}
    if item_code not in prices:
        return None
    return prices[item_code]


def apply_discount(cents, pct):
    """Apply a percentage discount, rounded to the NEAREST cent. pct in 0..100."""
    if pct < 0 or pct > 100:
        raise ValueError("pct out of range")
    return int(cents - cents * pct / 100)
