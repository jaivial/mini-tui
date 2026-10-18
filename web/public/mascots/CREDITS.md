# Mascot renders

AI-generated (MiniMax image-01 via `mmx image generate`, character-reference chained from
`wave`), cut out to transparent WebP (border flood-fill matte, 560px tall).

## Layout

- The 560px originals live in `web/assets/mascot-master/`, deliberately **outside this
  folder**: Vite copies everything under `public/` into `dist` verbatim, so masters kept
  here would be deployed and served even though no page requests them. They are the source
  of truth, so a re-run always starts from the source art and not from a derivative.
- `<mood>-56.webp`, `<mood>-112.webp`, `<mood>-168.webp` — what the app actually ships: one
  square rendition per device pixel ratio (1x/2x/3x of the 56px box `Mascot.svelte` paints).

Rebuild with `python3 web/scripts/gen-mascots.py`; `--check` verifies without writing.

## Why they are square

`Mascot.svelte` puts the image in a square box with `object-fit: contain`, so the padding a
non-square source needs is computed at paint time anyway. Baking it in is not a visual
change (measured: max per-pixel delta 0 at 56, 112 and 168) and it makes the `srcset` width
descriptors exact.

Decorative only: always rendered `aria-hidden` with `pointer-events: none`.
