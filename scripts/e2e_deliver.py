#!/usr/bin/env python3
"""Deliver one message into a bound thread through the receiver's real webhook.

The inbound leg is SIMULATED: I cannot make Jaime write in WhatsApp, so the
message is posted to :4318/api/channels/evo exactly as Evolution would (same
secret, same MESSAGES_UPSERT envelope, same group policy path). Everything
downstream is real: the receiver writes channel_inbox, the systemd consumer
picks it up, the agent runs, and the reply is sent to the actual WhatsApp
group through the weai API.

Usage: e2e_deliver.py <thread> "<text>" [tag]
Prints the inbox seq it landed on, then polls channel_sends for the reply.
"""
import json
import sqlite3
import subprocess
import sys
import time
import uuid

RECEIVER = "http://127.0.0.1:4318/api/channels/evo"
DB = "/home/jaime/.local/share/mini-tui/channels.sqlite"
THREAD, TEXT = sys.argv[1], sys.argv[2]
TAG = sys.argv[3] if len(sys.argv) > 3 else uuid.uuid4().hex[:8]
SENDER = "242554100576489@lid"  # the operator's own jid (the bot shares his number)


def secret() -> str:
    out = subprocess.run(
        ["sudo", "-n", "cat", "/etc/mini-tui/evo-receiver.env"],
        capture_output=True, text=True, check=True).stdout
    accounts = json.loads(
        [l for l in out.splitlines() if l.startswith("EVO_RECEIVER_ACCOUNTS=")][0].split("=", 1)[1])
    return accounts[0]["webhookSecret"]


def db():
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    return c


msg_id = f"E2E-{TAG}"
payload = {
    "event": "messages.upsert",
    "date_time": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
    "data": [{
        "key": {"id": msg_id, "remoteJid": THREAD, "fromMe": True, "participant": SENDER},
        "message": {"conversation": TEXT},
    }],
}
body = json.dumps(payload).encode()
proc = subprocess.run(
    ["curl", "-sS", "-X", "POST", RECEIVER,
     "-H", "content-type: application/json",
     "-H", f"x-webhook-secret: {secret()}",
     "--data-binary", "@-"],
    input=body, capture_output=True)
print(f"delivered {msg_id}: {proc.stdout.decode().strip()} {proc.stderr.decode().strip()}")

deadline = time.time() + 420
while time.time() < deadline:
    with db() as c:
        row = c.execute(
            "select s.state, s.reply_text from channel_sends s"
            " join channel_inbox i on i.seq = s.inbox_seq"
            " where i.message_id = ?", (msg_id,)).fetchone()
        if row and row["state"] == "sent":
            print("REPLY SENT TO WHATSAPP:")
            print(row["reply_text"])
            sys.exit(0)
    time.sleep(3)
print("TIMEOUT: no reply within 420s")
sys.exit(1)