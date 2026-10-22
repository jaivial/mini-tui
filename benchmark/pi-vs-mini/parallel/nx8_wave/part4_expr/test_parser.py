from parser import evaluate
import pytest

assert evaluate("1+2*3") == 7
assert evaluate("(1+2)*3") == 9
assert evaluate("10/4") == 2, "floor division"
assert evaluate("-2*3") == -6, "unary minus binds tighter than *"
assert evaluate("7--3") == 10, "unary minus after an operator"
assert evaluate("8/2/2") == 2, "left associativity"
with pytest.raises(ZeroDivisionError):
    evaluate("1/0")
print("part4 expr PASS")
