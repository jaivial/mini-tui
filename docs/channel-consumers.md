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

No consumer loop, authenticated receiver, live binding, send or task launch is
configured by this module. Runtime evidence and actual channel integration
remain pending. No tests or benchmark changed.
