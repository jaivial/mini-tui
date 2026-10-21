from shop.prices import price_for, apply_discount
import pytest

def test_known():
    assert price_for("A1") == 199

def test_unknown_raises():
    with pytest.raises(ValueError):
        price_for("ZZ")

def test_discount_rounds_to_nearest_cent():
    # 250 - 25% = 187.5 -> must round to 188 (nearest cent), not truncate to 187
    assert apply_discount(250, 25) == 188
    assert apply_discount(199, 10) == 179

def test_discount_rejects():
    with pytest.raises(ValueError):
        apply_discount(100, 150)
