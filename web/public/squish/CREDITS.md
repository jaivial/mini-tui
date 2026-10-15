# Squishmoji avatars

`squish/*.svg` are static, pre-rendered squishmoji avatars generated with
[`@usespaceui/squishmoji`](https://github.com/usespaceui/squishmoji) (MIT), the
same SpaceUI family as the Blobmoji set they replace. They are NOT the React
runtime: each file is a standalone SVG exported once by
`scripts/gen-squishmoji.ts` (deterministic seeds — rerun it to regenerate
byte-identical art) and served as plain images.

They are the bot/session avatars (see `src/lib/avatar.ts`); they are decorative
and always rendered `aria-hidden` — the session title carries the meaning.
