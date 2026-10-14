# Channels panel (read-only) and WhatsApp connection

The Session tasks drawer includes a **Canales** section, read-only like the
project queue above it. It shows what the channel layer already stores, never
mutates it: the inbox database is opened with a read-only SQLite connection
(`src/web/channels.ts`), no cursor is advanced, no delivery is replayed.

- **Rutas enlazadas**: channel/account/thread → session/project bindings with
  their configured allowlists. These are operator configuration, shown as
  stored; secrets (webhook secret, instance API key) are never read into a
  response.
- **Mensajes recientes**: the last 20 accepted messages (bounded: text
  truncated to 800 chars server-side, attachments as metadata with transcript
  state — pending/complete/uncertain/failed). The raw payload is never sent.
- **Consumidores**: durable cursor positions with their lag (accepted seq minus
  cursor). A lag > 0 is shown as unacknowledged work, not as an error: there
  is no delivery-error store yet.
- **Conectar WhatsApp**: the assistant instance's connection state and its
  pairing QR, fetched by the server from the weai-mini API strictly over
  loopback (127.0.0.1) with a server-held apikey from the service environment
  (`INSTANCE_TOKEN_MINI_ASSISTANT` or `EVO_CONNECT_API_KEY`; never the client,
  never logged, never proxied raw). The upstream connect endpoint regenerates
  the QR on every call (~60 s TTL), so the section offers a regenerate button
  and the server rate-limits calls (5 s). A connected instance answers
  `already_connected` and the panel shows no QR.

Endpoints (all GET, same-origin enforced like the queue endpoints):
`/api/channels/inbox`, `/api/channels/evo/status`, `/api/channels/evo/qr`.

Response bodies are bounded and validated fail-closed in
`web/src/lib/channelsClient.ts`; the section polls every 10 s while the drawer
is open and releases its poller when it closes.

Verified with cu against a live store and a loopback mock weai (the real
instance stays untouched): bindings, messages, cursor, QR render + regenerate
+ rate-limit, at 1200x850 and 390x844; no secret material in any response
body.
