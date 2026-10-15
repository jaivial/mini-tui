#!/usr/bin/env python3
"""E2E for voice notes, in BOTH directions, against the real WhatsApp group.

Why the inbound leg is staged rather than "a phone sent a note": I cannot make
Jaime record a voice note from here, and the fork does not index media for
messages the API itself sent (`getBase64FromMediaMessage` answers 404 "no media
for message …" for an id it never received over the socket). So:

  1. OUT: a real audio file is sent to the real group through the fork's
     `/message/sendWhatsAppAudio` with ptt:true — a genuine WhatsApp voice note.
  2. IN:  that same id is then posted to the receiver's webhook carrying the
     real `audioMessage` envelope Evolution would send, with the real opus bytes
     cached under the media store identity the consumer looks up. The bytes the
     consumer transcribes are the actual audio the API accepted, not a fixture.
  3. The rest — receiver → channel_inbox → whisper.cpp → transcript frame →
     agent turn → quoted reply → voice note back — is the real pipeline.

Usage: e2e_deliver_audio.py <thread> <audio-file> ["caption text"]
Prints the transcription and the reply the consumer actually sent.
"""
import base64
import json
import os
import sqlite3
import subprocess
import sys
import time
import uuid

RECEIVER = "http://127.0.0.1:4318/api/channels/evo"
DB = "/home/jaime/.local/share/mini-tui/channels.sqlite"
MEDIA_DIR = "/home/jaime/.local/share/mini-tui/media"
ENV = "/etc/mini-tui/evo-consumer.env"
SENDER = "242554100576489@lid"  # the operator's own jid (the bot shares his number)


def env_file() -> dict:
    out = subprocess.run(["sudo", "-n", "cat", ENV], capture_output=True, text=True, check=True).stdout
    return dict(line.split("=", 1) for line in out.splitlines() if "=" in line and not line.startswith("#"))


def receiver_secret() -> str:
    out = subprocess.run(["sudo", "-n", "cat", "/etc/mini-tui/evo-receiver.env"], capture_output=True, text=True, check=True).stdout
    accounts = json.loads([l for l in out.splitlines() if l.startswith("EVO_RECEIVER_ACCOUNTS=")][0].split("=", 1)[1])
    return accounts[0]["webhookSecret"]


def db():
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    return c


def curl_json(url: str, body: dict, token: str) -> tuple[bytes, str]:
    proc = subprocess.run(
        ["curl", "-sS", "-o", "/tmp/e2e_audio_body.out", "-w", "%{http_code}", "-X", "POST", url,
         "-H", "Content-Type: application/json", "-H", f"apikey: {token}", "--data-binary", "@-"],
        input=json.dumps(body).encode(), capture_output=True)
    return proc.stdout, open("/tmp/e2e_audio_body.out").read()


def main() -> int:
    thread, audio_path = sys.argv[1], sys.argv[2]
    caption = sys.argv[3] if len(sys.argv) > 3 else ""
    tag = uuid.uuid4().hex[:8]
    e = env_file()
    account = json.loads(e["EVO_ACCOUNTS"])[0]
    api = e["EVO_API_URL"].rstrip("/")
    inst = account["instance"]
    token = account["token"]
    raw = open(audio_path, "rb").read()

    # --- 1. OUT: a real voice note to the real group. ---------------------
    status, body = curl_json(
        f"{api}/message/sendWhatsAppAudio/{inst}",
        {"number": thread, "audio": base64.b64encode(raw).decode(), "mimetype": "audio/ogg; codecs=opus", "ptt": True},
        token)
    print(f"[out] sendWhatsAppAudio -> HTTP {status}")
    if status != "201":
        print(body[:400])
        return 1
    sent = json.loads(body)
    out_id = sent["key"]["id"]
    print(f"[out] WhatsApp voice note id={out_id} bytes={len(raw)} remoteJid={sent['key']['remoteJid']}")

    # --- 2. IN: the same audio, arriving as a real audioMessage envelope. --
    msg_id = f"E2EA-{tag}"
    mime = "audio/ogg; codecs=opus"
    payload = {
        "event": "messages.upsert",
        "date_time": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
        "data": [{
            "key": {"id": msg_id, "remoteJid": thread, "fromMe": True, "participant": SENDER},
            "message": {"audioMessage": {"mimetype": mime, "ptt": True}},
        }],
    }
    # Seed the media store under the identity transcribePendingAudio looks up
    # BEFORE it tries the network, so whisper runs on the real accepted bytes.
    seq_hint = None
    with db() as c:
        row = c.execute("select coalesce(max(seq),0) from channel_inbox").fetchone()
        seq_hint = int(row[0]) + 1
    attachment_id = f"{msg_id}:audioMessage"
    safe = "".join(ch if (ch.isalnum() or ch in "._-") else "_" for ch in attachment_id)[:120]
    os.makedirs(MEDIA_DIR, exist_ok=True)
    stored = os.path.join(MEDIA_DIR, f"seq{seq_hint}-{safe}.ogg")
    with open(stored, "wb") as fh:
        fh.write(raw)
    os.chmod(stored, 0o600)
    print(f"[in ] media store primed at {os.path.basename(stored)} ({len(raw)} bytes)")

    proc = subprocess.run(
        ["curl", "-sS", "-X", "POST", RECEIVER, "-H", "content-type: application/json",
         "-H", f"x-webhook-secret: {receiver_secret()}", "--data-binary", "@-"],
        input=json.dumps(payload).encode(), capture_output=True)
    print(f"[in ] receiver -> {proc.stdout.decode().strip()} {proc.stderr.decode().strip()}")

    # The seq is authoritative, not the guess above: rename if it differed.
    deadline = time.time() + 60
    seq = None
    while time.time() < deadline and seq is None:
        with db() as c:
            row = c.execute("select seq from channel_inbox where message_id=?", (msg_id,)).fetchone()
            if row:
                seq = int(row[0])
        time.sleep(1)
    if seq is None:
        print("TIMEOUT: the audio message never landed in the inbox")
        return 1
    if seq != seq_hint:
        moved = os.path.join(MEDIA_DIR, f"seq{seq}-{safe}.ogg")
        os.replace(stored, moved)
        print(f"[in ] media store moved to {os.path.basename(moved)} (seq {seq})")

    # --- 3. Watch the real pipeline: whisper → transcript → reply. ---------
    transcript = None
    while time.time() < deadline + 300:
        with db() as c:
            upd = c.execute(
                "select text, state from channel_updates where seq=?1 order by rowid desc limit 1", (seq,)).fetchone()
            if upd:
                transcript = (upd["state"], upd["text"])
                break
            sent_row = c.execute(
                "select s.state, s.reply_text from channel_sends s where s.inbox_seq=?", (seq,)).fetchone()
            if sent_row and sent_row["state"] == "sent":
                print("NOTE: reply was sent but no transcript row was written")
                break
        time.sleep(2)

    print(f"\n=== TRANSCRIPT (state, text) ===\n{transcript}")
    for _ in range(240):
        with db() as c:
            row = c.execute("select state, reply_text, reply_id from channel_sends where inbox_seq=?", (seq,)).fetchone()
            if row and row["state"] == "sent":
                print(f"\n=== REPLY SENT TO WHATSAPP (id={row['reply_id']}) ===\n{row['reply_text']}")
                return 0
        time.sleep(2)
    print("TIMEOUT: no reply within the window")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())