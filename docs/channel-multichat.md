# WA-5: WhatsApp multichat — multiple identities, group sessions, bindings CLI

One mini deployment can now answer for **several bot identities** (one per
evo-weai instance/number) and treats **every group thread as its own isolated
session**. Operator state lives in explicit bindings; nothing is ever derived
from message content.

## Multiple accounts (multi-identity fan-in)

Configuration is operator-only, from the 0600 service env files:

Receiver (`mini-evo-receiver`, src/web/serve.ts):

    EVO_RECEIVER_ACCOUNTS=[{"account":"mini-assistant","webhookSecret":"…32+z"},
                           {"account":"second-bot","webhookSecret":"…"}]

Consumer (`mini-channel-consumer`, src/channels/consumerMain.ts):

    EVO_ACCOUNTS=[{"account":"mini-assistant","instance":"mini-assistant","token":"…","jid":"346…@s.whatsapp.net,2425…@lid"},
                  {"account":"second-bot","instance":"second-instance","token":"…","jid":"…"}]

`jid` may list every form the account is mentioned by (WhatsApp groups often
mention the community LID, not the phone jid — comma-separate them). The
single-account envs keep working; `EVO_ACCOUNT_JID` adds the needle there.

Both fall back to the WA-1/WA-2 single-account variables when the JSON is
absent, so existing deployments keep running untouched.

Identity hygiene (invariant, enforced in code):

- The offered `x-webhook-secret` selects the account; `body.instance` is never
  trusted. Every configured secret is compared in constant time.
- A row accepted for account A is only ever answered with A's instance token
  (`senderForAccount`): no cross-account sends, ever.
- The mention-gate needle is each account's own `jid` from config — identity
  data never comes from the webhook body.

Bindings are namespaced by `(channel, account, thread)`, so the same phone
number chatting with two bots produces two independent conversations.

## Group sessions

- A `@g.us` thread binds like any thread (`channel_bindings`, WA-1 schema) plus
  two WA-5 columns: `policy` and `model`.
- **Mention gate (default):** a group message is only answered when it
  explicitly mentions the account's own jid (`mentions` captured from
  `contextInfo.mentionedJid` / `mentionedJidArray`, matched by full jid or bare
  number). Set `policy='all'` on a binding to answer everything. Ignored group
  messages are acknowledged with a `channel.consumer.group_ignored` log line —
  the cursor never blocks on a group that did not ask for the bot.
- **Per-binding model:** `model` (mini `provider/model` shape) is resolved at
  turn time from the current binding — CLI changes apply to the very next
  message, persist with the session, and drive the conversation turns. The
  session's queued work keeps using the queue's own worker configuration
  (worker models follow the coordinator config; the binding model is chat UX,
  never a benchmark knob).
- **Sender allowlist** stays mandatory per binding (WA-1 accept rule).

### New session = new group

The session's model may end a reply with `[[mini-newgroup: <subject>]]`. The
bridge (src/channels/groupBridge.ts) then, behind the inbox cursor:

1. creates the group on the requesting account's own instance
   (`POST /group/create/{instance}`, the requester as participant);
2. sets the static bizbots mascot frame as group photo (`updateGroupPicture`;
   WhatsApp group photos are static JPG — the animated pet stays in the web
   panel/stickers);
3. binds the new group to a **fresh session** (`wa-<account>-<hex8>`) with its
   own allowlist (requester only) and default mention policy — one group id is
   one isolated session: its own conversation history, model and allowlist;
   no group ever sees another group's context;
4. confirms in the requesting thread with the new group's jid.

### The operator's `/newsession` command

Typing

    /newsession <short subject>

in a bound thread (the whole message — a mention inside another sentence is
just text) starts a brand-new isolated session in ONE deterministic step, with
NO model turn and no injection surface (src/channels/sessionCommand.ts):

1. creates a fresh WhatsApp group with the requester as participant;
2. sets that session's squishmoji avatar as the group photo (same face the web
   sidebar shows; static mascot frame as fallback);
3. binds it to a fresh `wa-<account>-<hex8>` session — mention policy,
   allowlist = exactly the requester;
4. confirms in the requesting thread with the new group's jid (the original
   thread and its binding stay untouched).

Authority is the binding's own allowlist: only a sender already allowed in
that thread can run the command — anyone else's `/newsession …` is refused at
the accept boundary (422) like any other message from an unapproved sender.
The command deliberately bypasses the group mention gate (an explicit
operator command is more specific than a mention policy), never the allowlist.
The group-create API refuses `@lid` participants (400 bad-request), so the
requester's LID is resolved to its phone jid through the account's own trusted
jid forms (EVO_ACCOUNTS `jid`) for that call only — the new binding's
allowlist keeps the original LID form deliveries actually arrive with.

### Titles: AI-generated, editable forever (v5-A)

Every session gets a title of AT MOST 4 words in the user's own language,
generated with the model from its first message/task (src/title.ts, the same
`mini-agent-rs title` helper the CLI uses; the first words of the message are
the fallback when generation fails or no model is reachable):

- **Web**: the fallback title is replaced as soon as the AI title lands; the
  sidebar row can be renamed at any time (double-click or the row's pencil) —
  `POST /sessions/<id>/title` renames live and saved sessions alike, and the
  shared stream pushes the new name to every open panel.
- **WhatsApp**: a fresh bound session is titled from its first message; a
  rename also renames the GROUP's subject
  (`POST /group/updateGroupSubject/<instance>` — the session's name is what
  the members see). The operator command is

      /rename <new title>

  same authority shape as `/newsession`: allowlist only, no model turn,
  acknowledged before the work runs. An AI title never lands over a rename:
  whoever renamed it (web or `/rename`) wins.

### One number, two authors (`fromMe` in groups)

On this deployment the bot and the operator share ONE WhatsApp number, so in
groups EVERY delivery — the operator's real messages AND the bot's own API
replies — arrives with `fromMe=true`. Group deliveries are therefore accepted
regardless of the direction bit; loop prevention is identity by correlation,
never by the bit:

- a delivered id that is a recorded reply id (`channel_sends.reply_id`) is
  refused at the accept boundary (evoReceiver);
- any other delivered id that appears in the thread's recent outgoing history
  is the bot's own (non-ledgered) send: the consumer acknowledges it without
  a turn (consumer.ts own-send guard).

Outside groups the bit still means "sent by a linked device": mirrors and API
echoes are dropped exactly as before.

## Operator CLI (bindings)

    EVO_INBOX_DB=~/.local/share/mini-tui/channels.sqlite \
      bun run src/channels/bindingsCli.ts <command> …

    list   [--account A] [--json]
    bind   --account A --thread T --allow jid[,jid…] [--session S] [--project P]
           [--policy default|mentions|all] [--model provider/model]
    unbind --account A --thread T
    allow  --account A --thread T (--add jid | --remove jid)
    model  --account A --thread T --model provider/model
    models                    — the model ids mini has configured (validation set)
    groups --account A        — the groups of the account's instance
    new-group --account A --subject S --participants N1[,N2…] [--model M]
              [--policy default|mentions|all] [--sticker WEBP] [--welcome TEXT]

`new-group` is the operator's own path to a fresh session (the chat-side flow
is the `[[mini-newgroup: …]]` directive): it creates the WhatsApp group on the
account's instance, sets the bizbots mascot frame as the group photo (static
JPG by design — WhatsApp group photos don't animate; `EVO_GROUP_PHOTO`
overrides the bundled one), binds it to a fresh `wa-<account>-<hex8>` session
with the requester as the only allowed sender, and prints the group jid.

Examples:

    # bind a new group (after the bridge or by hand) with mention gating
    bindingsCli bind --account mini-assistant \
      --thread '120363…@g.us' --allow '346…@s.whatsapp.net' --policy mentions

    # switch the model of one conversation, effective next message
    bindingsCli model --account mini-assistant \
      --thread '346…@s.whatsapp.net' --model opencode-go/glm-5.3-flash

Re-running `bind` without `--session` keeps the stored session (rebinding never
forks a conversation). `unbind` rejects further messages from that thread; the
session and its history remain. Changes are read fresh by the consumer on every
turn — no restart needed, and they are durable (SQLite, WAL).

## Model validation

The CLI validates the model twice: the `provider/model` shape AND membership in
mini's configured connections (`~/.config/mini-tui/providers.json`,
`MINITUI_CONNECTIONS_PATH` overrides) — an unknown model is refused at the CLI,
never silently misrouted. The consumer still passes the binding model to the
headless runner per turn; a provider that died since the binding was written
fails the turn and the thread gets the honest failure note. The chosen model
persists with the session and is re-applied on every resume; queue work keeps
the queue's own worker configuration (chat UX, never a benchmark knob).
