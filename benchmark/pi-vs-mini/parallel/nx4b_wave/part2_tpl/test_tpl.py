from tpl import render

assert render("hi {{ name }}", {"name": "ana"}) == "hi ana"
assert render("hi {{ name }}", {}) == "hi "
assert render("hi {{name}}", {"name": "ana"}) == "hi ana", "flexible whitespace"
assert render("{{ name | upper }}", {"name": "ana"}) == "ANA"
assert render("{{ name | lower }}", {"name": "ANA"}) == "ana"
assert render("{{ n | add:3 }}", {"n": 4}) == "7"
assert render("{% if name %}yes{% else %}no{% endif %}", {"name": ""}) == "no"
assert render("{% if name %}yes{% else %}no{% endif %}", {"name": "x"}) == "yes"
assert render("{% if name == ana %}A{% else %}B{% endif %}", {"name": "ana"}) == "A"
assert render("{% if name != ana %}A{% else %}B{% endif %}", {"name": "bo"}) == "A"
assert render("x{% if a %}1{% endif %}y{% if b %}2{% endif %}z", {"a": 1}) == "x1yz"
assert render("{% if a %}1{% if b %}2{% endif %}{% endif %}", {"a": 1, "b": 2}) == "12"
try:
    render("{{ n | bogus }}", {"n": 1})
    raise SystemExit("expected ValueError")
except ValueError:
    pass
print("part2 tpl PASS")
