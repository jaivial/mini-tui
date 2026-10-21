from t3_lib import top_words

def test_basic():
    assert top_words("a b a c a b") == [("a", 3), ("b", 2), ("c", 1)]

def test_empty():
    assert top_words("") == []

def test_tie_break_alphabetical():
    # b and c both appear twice; alphabetical order must break the tie
    assert top_words("c b c b") == [("b", 2), ("c", 2)]

def test_case_folding():
    assert top_words("Apple apple APPLE banana") == [("apple", 3), ("banana", 1)]
