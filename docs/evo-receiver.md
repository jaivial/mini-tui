# Evo receiver preparation

A prepared handler accepts JSON POST deliveries authenticated with a private
x-webhook-secret. Account identity comes only from trusted host configuration,
not body.instance. Request bytes and reading time are bounded. Normalized inbound
messages still require explicit ChannelInbox account/thread/sender bindings.
Duplicate IDs use the durable inbox; rejected batches can have accepted prefixes,
so retries must preserve original IDs. No route or service is started here.

Evo source supports configured webhook headers. A future operator configuration
can send x-webhook-secret, without exposing any Evo API key to this endpoint.
Do not log the secret or webhook body. The receiver returns only counts/errors,
never the private routing map. It does not start tasks, infer consent, send replies
or fetch media URLs.

Jaime chose the phone number he personally links through evo-weai QR/pairing code.
The QR/code step remains his action. No instance is connected/mutated by this PR.
Before live activation: identify the selected instance/account, configure the
private credential, agree exact chat/sender routes, and have Jaime link his phone.
Runtime/authentication proof pending. No tests or benchmark changed.

## Mounted route (WA-1)

`src/web/serve.ts` mounts the receiver at `POST /api/channels/evo` when the
service environment carries `EVO_RECEIVER_ACCOUNT` (the bound account — the
webhook body never selects one) and a 32+ byte `EVO_WEBHOOK_SECRET`. Without
both, the path answers 404 like any unknown route. `EVO_INBOX_DB` overrides
the inbox location (default `~/.local/share/mini-tui/channels.sqlite`); keep
the environment file 0600 and never log the secret. Answers are counts only:
`{accepted, duplicates}`. An inbound row still requires an explicit
`channel_bindings` row for its account/thread and an approved sender.
