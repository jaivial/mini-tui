# Audio updates after delivery

A consumer can already have acknowledged an accepted audio message when its
transcript completes. Advancing the message cursor must not hide that update.
Transcript mutation now records a durable update in the same transaction.
updates(after,limit) reads a separate ordered feed, joining the original accepted
route and current message payload. Complete, uncertain and failed states remain
explicit. The original message ID and inbox seq never change; no duplicate task
is created. Multiple attachment updates can project the current shared payload.

Callers retain their own update cursor after durable handoff. Reading/receiving
this feed does not authenticate message contents, approve sends or launch tasks.
No live transcription pipeline, channel binding or receiver is enabled here.
Runtime proof pending; no tests or benchmark changed.
