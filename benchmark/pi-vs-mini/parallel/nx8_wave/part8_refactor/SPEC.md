# Part 8 — refactor (JS)

`messy.js` works and its tests pass, but it is a mess. Refactor it WITHOUT
changing behavior (`node test_messy.js` must still pass, and `messy.js` must
keep exporting the same four names):

1. extract the duplicated clamp logic into one `clamp` helper
2. rename the functions `f1`, `f2`, `f3` to `scale`, `offset`, `normalize`; keep the old names as aliases so the unchanged tests still import them
3. replace the magic numbers with named constants MIN and MAX
4. delete the commented-out dead block
5. one return per function in normalize
6. write `REFACTOR.md` listing each of the 6 changes

The grader runs the tests and checks REFACTOR.md mentions these markers:
`clamp`, `scale`, `offset`, `normalize`, `MIN`, `dead`.
