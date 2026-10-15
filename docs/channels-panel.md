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
  two pairing paths, fetched by the server from the weai-mini API strictly
  over loopback (127.0.0.1) with a server-held apikey from the service
  environment (`INSTANCE_TOKEN_MINI_ASSISTANT` or `EVO_CONNECT_API_KEY`;
  never the client, never logged, never proxied raw). The upstream connect
  endpoint regenerates the QR on every call (~60 s TTL), so the section
  offers a regenerate button and the server rate-limits calls (5 s). A
  connected instance answers `already_connected` and the panel shows no QR.
- **Emparejar con código**: the same block offers pairing by phone number —
  the user types their number, the server calls weai's
  `GET /instance/connect/<name>?number=<num>` and relays only the short
  pairing code, shown big with a live expiry countdown (~60 s). States:
  invalid number (client-side + server validation, 400), rate limit
  (`code_rate_limited`, 429, shared 5 s window per code request),
  `already_connected`, `no_code_available` and unreachable. A code already
  live on the weai socket is answered as is — the same code, not a new one.

The whole block lives in `web/src/lib/components/WhatsAppConnect.svelte` and
is mounted twice: in the **Canales** section of the session-tasks drawer and
in a dedicated **Canales** tab of the Settings modal.

Endpoints (all GET, same-origin enforced like the queue endpoints):
`/api/channels/inbox`, `/api/channels/evo/status`, `/api/channels/evo/qr`,
`/api/channels/evo/code?number=<phone>`.

Response bodies are bounded and validated fail-closed in
`web/src/lib/channelsClient.ts`; the section polls every 10 s while the drawer
is open and releases its poller when it closes.

Verified with cu against a live store and a loopback mock weai (the real
instance stays untouched): bindings, messages, cursor, QR render + regenerate
+ rate-limit, pairing code generate + countdown + rate-limit + already
connected, Settings tab and drawer mount, at 1200x850 and 390x844; no secret
material in any response body.
