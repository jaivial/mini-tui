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

> **The scope needs the user manager, and a system unit does not have it.**
> `mini-channel-consumer` runs as a SYSTEM unit, where systemd does not export
> `XDG_RUNTIME_DIR`, so `systemd-run --user` fails with "Failed to connect to
> bus". Because that is an *environmental* failure the transcriber reports it
> as `transient` — which is correct (a later pass should retry) and also means
> **every voice note degrades silently to "temporarily unavailable"**. The fix
> is the drop-in `deploy/mini-channel-consumer-v6e.conf`, which exports
> `XDG_RUNTIME_DIR=/run/user/1003`; `tests/deploy-consumer-runtime-dir.test.ts`
> locks it. If transcription ever goes quiet, check this before the model.

### The model, and why

Measured on this host with a real Spanish note (15.5 s, TTS, same cgroup lane):

| model | wall | CPU user | note |
|---|---|---|---|
| `ggml-base.bin` (multilingual) | **2.8 s** | 6.8 s | **shipped default** |
| `ggml-small.bin` (multilingual) | 6.6 s | 24.3 s | 3.3× the CPU, no measurable gain on short notes |
| `tiny` / `tiny.en` | — | — | rejected: multilingual tiny mangles Spanish; `tiny.en` cannot read it at all |

**`base` multilingual** is the deployed model. On short voice notes its output
is indistinguishable from `small` while costing a third of the CPU — and inside
a 50% CPU scope that is the difference between ~2.8 s and ~6.6 s of the sender
waiting. A bigger model earns its cost on long notes or dense jargon (product
names, addresses), which is exactly when `EVO_TRANSCRIBE_MODEL` should be
re-pointed. An English-only model is never the right answer for this channel.

### Pin the language; auto-detection is not good enough here

`EVO_TRANSCRIBE_LANG` (default `es`) passes `-l es` to whisper-cli. This is not
cosmetic: with auto-detection whisper reported **`en`** on an all-Spanish clip
and mangled the numbers ("las ocho" → "a las 8"). Forced `-l es` returns them
correctly. Set it empty (`EVO_TRANSCRIBE_LANG=`) only for a genuinely
multilingual thread, and expect worse numbers.

### Measured end to end

`createWhisperTranscriber` run from the unit's own environment against the real
15.5 s note: **2788 ms**, `state=complete`, text `"…una nota de voz real para
probar la transcripción. Mañana tengo una reunión a las nueve en la oficina de
Valencia…"`. The honesty contract still holds against real inputs: over-cap
audio → `failed` + `audio is 15s; transcription cap is 1s` (definitive, not
transient), undecodable input → `failed` + the ffmpeg reason.

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
`EVO_TRANSCRIBE_LANG`, `EVO_TRANSCRIBE_CPU_QUOTA`, `EVO_TRANSCRIBE_MEM_MAX`,
`EVO_TRANSCRIBE_MAX_AUDIO_S`, `EVO_TRANSCRIBE_TIMEOUT_S`, `EVO_LATE_SWEEP_MS`.
If the whisper binary or model is missing the consumer starts with media
handling disabled: voice notes stay pending and are answered honestly.

## Voice notes OUT (`[[mini-voice: <path>]]`)

The reverse direction, over evo-weai
`POST /message/sendWhatsAppAudio/{instance}` with `ptt: true` — that flag is
what renders the push-to-talk bubble instead of a music attachment (verified:
201 with a real `audioMessage` back, 249 KB note accepted by WhatsApp).

The model emits the directive on the last line of its reply; the consumer
strips it before sending, so the sender never sees markup. Validation mirrors
`[[mini-image:]]` and is deliberately strict:

- the path must resolve **inside** a configured root (`EVO_VOICE_DIRS`, default
  `~/.local/share/mini-tui/voice`) — a model can never attach an arbitrary host
  file;
- it must be a regular, non-empty file under `VOICE_MAX_BYTES` (5 MB);
- it must carry an **audio** extension — this directive must not become a file
  drop;
- at most 2 per reply; an empty root list strips the markup and delivers
  nothing.

Delivery is best-effort exactly like a screenshot: the text reply is already
durable and the cursor advanced, so a failed note is a log line
(`channel.consumer.voice_*`), never a redelivery loop. The note is never
invented — no marker, no audio, no send.

## E2E

`scripts/e2e_deliver_audio.py` covers both directions against the real group.
The inbound leg is staged (nobody can record a note into the chat from here,
and the fork does not index media for messages the API itself sent — it answers
`404 no media for message …`), so the harness sends the audio for real and then
injects the same audio as the `audioMessage` envelope Evolution would deliver,
with the accepted opus bytes cached under the media-store identity the consumer
looks up first. What whisper transcribes is therefore the real accepted audio,
not a fixture; the receiver, the inbox, the transcription, the turn, the quoted
reply and the voice note back are all the production path.

## Typing presence and semantic reactions

See `src/channels/typing.ts` and `src/channels/semanticReaction.ts`. Both are
best-effort by contract and neither can reach the turn: a stuck "typing…" is
worse than none, and a missing emoji costs one symbol.

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
