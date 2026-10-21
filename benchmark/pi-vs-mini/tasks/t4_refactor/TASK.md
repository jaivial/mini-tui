# Task: harden and modernize utils.js

`utils.js` is CommonJS. Convert it to an ES module keeping both named exports
(`slugify`, `parseDuration`) and behaviour, and harden `parseDuration`:

- accepts `"250ms"`, `"30s"`, `"1m30s"`, `"2h"` and returns milliseconds (int)
- accepts combinations like `"1m30s500ms"`
- returns `null` (not NaN, not undefined) for `""`, `undefined`, `"junk"`,
  `"10x"`, `"m30"` and any non-matching input
- `slugify("  Hola, Mundo! ")` -> `"hola-mundo"` (as it already does)

`utils.js` must keep working as an ES module (`import { slugify } from "./utils.js"`).
Work only in the current directory.
