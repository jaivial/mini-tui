# Part 1 — tokenizer (JS)

Implement `tokenize(input)` in `tokenizer.js`. It returns an array of tokens,
each `{type, value}`, scanning left to right:

- whitespace: skipped
- numbers: one or more digits; `value` is the Number
- identifiers: `[a-z_][a-z0-9_]*`; `value` is the string
- strings: double-quoted, no escapes; `value` is the inner text
- operators: `+ - * / ( ) = ,`; `value` is the char, `type` is `"op"`
- anything else: throw `Error("unexpected char: " + ch)`

`node test_tokenizer.js` must pass. Do not change the test.
