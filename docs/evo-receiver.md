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
