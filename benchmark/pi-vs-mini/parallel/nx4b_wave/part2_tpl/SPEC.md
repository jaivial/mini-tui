# Part 2 — mini template engine (Python)

Make `python3 test_tpl.py` pass. `tpl.py` implements `render(template, ctx)`:

- `{{ name }}` -> `str(ctx["name"])`; unknown name -> `""`
- `{{ name | upper }}` -> uppercase; `{{ name | lower }}`; `{{ n | add:3 }}`
  (integer add)
- `{% if cond %}...{% else %}...{% endif %}` where `cond` is `name` (truthy in
  ctx) or `name == literal` / `name != literal` (string compare). Nestable.
- Whitespace inside tags is flexible. Unknown filters raise `ValueError`.

Do not change the test.
