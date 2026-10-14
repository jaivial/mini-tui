# Durable channel consumer handoff

Named consumers read accepted inbox messages after their own durable cursor.
Read alone does not acknowledge, start work or approve the message contents.
A caller acknowledges only after its own durable handoff. The next inbox row
must match seq/session/project and the expected prior cursor under an immediate
transaction. This prevents skipping messages or redirecting an accepted delivery
through a later binding change. Concurrent stale acknowledgements fail closed.

Delivery is at least once, not exactly once: caller side effects need their own
idempotency keyed by the accepted message. After an uncertain acknowledgement,
inspect pending() before retrying. Transcription updates stay on the original
row and do not automatically replay acknowledged messages.

## Consumer daemon and outbound sender (WA-2)

`consumer.ts` + `evoSend.ts` (entry point: `consumerMain.ts`) implement the
first real consumer, `whatsapp-outbound`:

- A new consumer starts at the present: `ChannelInbox.sync(consumer)` plants its
  cursor at the newest accepted seq, so history accepted before it first ran is
  never replayed as live turns.
- Each accepted message runs as one turn in the binding's session — the same
  `sessions.db` row and `/resume` history every UI shares (created on the first
  message, resumed on every later one). One thread is one stable session.
- The session's reply is recorded in the `channel_sends` ledger (keyed by the
  accepted seq) BEFORE the HTTP call, then sent via
  `POST /message/sendText/{instance}` with `quoted.key.id` set from the
  original message's replyTo (else its own id). Only a confirmed 201 plus the
  CAS `acknowledge` advances the inbox cursor.
- A failed send never acknowledges the cursor. Any non-201/timeout is
  `uncertain`: the thread's recent outgoing history (`findMessages`,
  `fromMe=true`) is read and a resend happens only when the reply is provably
  absent (matched by quoted stanza id, else by exact text). This closes the
  double-send window after a crash between send and acknowledge.
- A turn that keeps failing (bounded retries) sends one honest failure note
  instead of blocking the cursor on a poison message.

Credentials (evo-weai instance token) come from a 0600 env file and are never
logged. No test suite changed.
