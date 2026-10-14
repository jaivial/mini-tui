# Channel media: bounded download, transcription, honest refusals

What the consumer does with accepted attachments (WA-4). Every path here is
real: no fake OCR, no ASCII probing, no guessed document contents.

## Download (bounded, keyed)

Media is fetched through evo-weai `POST /chat/getBase64FromMediaMessage/{instance}`,
keyed ONLY by the stored `providerRef` (the WhatsApp stanza id) and the
accepted thread. No inbound body can point the code at an arbitrary URL.
`EVO_MEDIA_MAX_BYTES` (default 20 MB) caps the decoded payload; larger media
is refused, never truncated.

## Storage (identity, expiry, ownership)

- Directory `EVO_MEDIA_DIR` (default `~/.local/share/mini-tui/media`), 0700;
  files 0600, written via a private temp file (no world-readable partials).
- Identity: `seq<inbox seq>-<sanitized attachment id><ext>` — the accepted
  route, not message content.
- Bounds: `EVO_MEDIA_DIR_MAX_BYTES` (default 256 MB) enforced on write, plus
  `EVO_MEDIA_RETAIN_DAYS` (default 7) expiry.
- Cleanup ownership: the consumer. `sweep()` runs at each late-media pass
  (default every 10 min): expired entries first, then oldest-first until the
  total is back under the cap.

## Audio → transcription (heavy lane)

whisper.cpp (local build, CPU only — this host has no GPU). Each whisper run
is spawned under a systemd user scope capped at `EVO_TRANSCRIBE_CPU_QUOTA`
(default 25%) and `EVO_TRANSCRIBE_MEM_MAX` (default 2 GB), so transcription
can never squeeze the box's benchmark or serving processes. The ffmpeg/ffprobe
conversion steps (ogg/opus → 16 kHz mono WAV) run outside the scope but are
bounded: inputs are already size-capped and each step has its own timeout.
`EVO_TRANSCRIBE_MAX_AUDIO_S` (default 600) caps duration.

States written through `ChannelInbox.transcript(seq, attachmentId, text,
state)` — attached to the ORIGINAL message, never a new task:

- `complete`: text recognized, every segment's mean content-token probability
  >= 0.8 (whisper.cpp exposes confidence per token).
- `uncertain`: text recognized but some segment is below that band. The turn
  frame and the reply must say the transcription may be imperfect.
- `failed`: no speech, over-cap audio, tool failure or timeout — with the
  reason in the frame.

Transcription happens BEFORE the session turn, so the normal path answers with
the transcript in hand. A transient fetch failure leaves the attachment
`pending`: the turn says it is not available yet, and the idle sweep retries.
When a transcript completes after the message was already answered, the state
is written through `inbox.transcript` (which records the durable
`channel_updates` row, see docs/channel-updates.md) and a short quoted
follow-up with the transcript is sent to the thread; a durable log prevents
re-sending it.

Configuration (all optional, see `consumerMain.ts` header): `EVO_MEDIA_DIR`,
`EVO_MEDIA_MAX_BYTES`, `EVO_MEDIA_DIR_MAX_BYTES`, `EVO_MEDIA_RETAIN_DAYS`,
`EVO_MEDIA_TIMEOUT_MS`, `EVO_TRANSCRIBE_BIN`, `EVO_TRANSCRIBE_MODEL`,
`EVO_TRANSCRIBE_CPU_QUOTA`, `EVO_TRANSCRIBE_MEM_MAX`,
`EVO_TRANSCRIBE_MAX_AUDIO_S`, `EVO_TRANSCRIBE_TIMEOUT_S`, `EVO_LATE_SWEEP_MS`.
If the whisper binary or model is missing the consumer starts with media
handling disabled: voice notes stay pending and are answered honestly.

## Images

The headless session path has no image payload support, so there is no vision
route: the turn frame states the session cannot see the image and the session
must say honestly that images are not supported yet. Images are not downloaded
or stored (no future use without a vision route).

## Documents

Bounded download + 0600 retention with expiry (a future extractor can use
them), but no text extraction is wired: the frame forbids guessing and says
honestly that documents cannot be read yet. Extraction gets wired only when a
real extractor exists on the host.
