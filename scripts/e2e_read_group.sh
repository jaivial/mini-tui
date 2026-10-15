#!/usr/bin/env bash
# Read the last N messages of a bound thread from the real WhatsApp API.
# The token is read from the service env and used in the pipeline only — never printed.
set -euo pipefail
THREAD="${1:?thread}"; LIMIT="${2:-12}"

ACCOUNTS=$(sudo -n cat /etc/mini-tui/evo-consumer.env | grep '^EVO_ACCOUNTS=' | cut -d= -f2-)
API=$(sudo -n cat /etc/mini-tui/evo-consumer.env | grep '^EVO_API_URL=' | cut -d= -f2-)
read -r TOKEN INSTANCE < <(printf '%s' "$ACCOUNTS" | python3 -c "
import sys, json
d = json.load(sys.stdin)[0]
print(d['token'], d['instance'])
")
[ -n "$TOKEN" ] || { echo 'no token in EVO_ACCOUNTS'; exit 1; }

curl -sS -X POST "${API}/chat/findMessages/${INSTANCE}" \
  -H "apikey: ${TOKEN}" -H 'content-type: application/json' \
  -d "{\"where\":{\"key\":{\"remoteJid\":\"${THREAD}\"}},\"offset\":0,\"limit\":${LIMIT}}" |
THREAD="$THREAD" python3 -c "
import sys, json, os, datetime
thread = os.environ['THREAD']
d = json.load(sys.stdin)
def walk(o):
    if isinstance(o, dict):
        if isinstance(o.get('messages'), dict) and 'records' in o['messages']:
            for r in o['messages']['records']:
                yield r
        for v in o.values():
            yield from walk(v)
    elif isinstance(o, list):
        for v in o:
            yield from walk(v)
for r in walk(d):
    key = r.get('key') or {}
    if key.get('remoteJid') != thread:
        continue
    msg = r.get('message') or {}
    txt = (msg.get('conversation')
           or (msg.get('extendedTextMessage') or {}).get('text')
           or (msg.get('imageMessage') or {}).get('caption') or '')
    ts = r.get('messageTimestamp')
    when = (datetime.datetime.fromtimestamp(ts).strftime('%m-%d %H:%M:%S')
            if isinstance(ts, (int, float)) else str(ts))
    print('  %s fromMe=%s %r' % (when, key.get('fromMe'), txt[:110]))
"