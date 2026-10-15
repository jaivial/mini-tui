# Emoji avatars

`emoji/*.png` are Blobmoji ("flat") emoji served by the SpaceUI multi-CDN
(https://cdn.spaceui.one/common/emoji/blobmoji/flat/<codepoints>.png), the asset
set used by https://github.com/usespaceui/emoji. Blobmoji is Google's Android
emoji restyled as blobs, licensed Apache-2.0
(https://github.com/CyberAgent/blobmoji — the set this CDN mirrors).

They are the bot/session avatars (see `src/lib/avatar.ts`); they are decorative
and always rendered `aria-hidden` — the session title carries the meaning.
