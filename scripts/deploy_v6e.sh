#!/usr/bin/env bash
# v6-E deploy: enable real transcription, typing presence, semantic reactions
# and outgoing voice notes on mini-channel-consumer.
#
# Idempotent: every write is an "append only if the key is absent" so a second
# run changes nothing. Never prints the token (it stays inside python).
set -euo pipefail
ENVF=/etc/mini-tui/evo-consumer.env
BIN=/home/jaime/tools/whisper.cpp/build/bin/whisper-cli
MODEL=/home/jaime/tools/whisper.cpp/models/ggml-base.bin

# 1. The model choice, with the reasoning in the comment: `base` multilingual
#    is indistinguishable from `small` on short Spanish notes at 3.3x less CPU
#    (measured: 1.98s wall / 6.8s CPU vs 6.63s / 24.3s on an 11.9s note).
#    `tiny.en` cannot understand Spanish at all; tiny multilingual mangles it.
[ -x "$BIN" ] || { echo "FATAL: $BIN missing or not executable"; exit 1; }
[ -s "$MODEL" ] || { echo "FATAL: $MODEL missing or empty"; exit 1; }

sudo -n python3 - "$ENVF" "$BIN" "$MODEL" <<'PY'
import os, sys, stat
envf, bin_path, model = sys.argv[1], sys.argv[2], sys.argv[3]
with open(envf) as fh:
    lines = fh.read().splitlines()
existing = {l.split("=", 1)[0] for l in lines if "=" in l and not l.startswith("#")}
want = {
    "EVO_TRANSCRIBE_BIN": bin_path,
    "EVO_TRANSCRIBE_MODEL": model,
    "EVO_TRANSCRIBE_LANG": "es",
    "EVO_TRANSCRIBE_CPU_QUOTA": "50%",
    "EVO_TRANSCRIBE_MEM_MAX": "2G",
    "EVO_TRANSCRIBE_MAX_AUDIO_S": "600",
    "EVO_TRANSCRIBE_TIMEOUT_S": "300",
    "EVO_MEDIA_DIR": "/home/jaime/.local/share/mini-tui/media",
    "EVO_LATE_SWEEP_MS": "300000",
    "EVO_TYPING": "1",
    "EVO_TYPING_DELAY_MS": "30000",
    "EVO_TYPING_REFRESH_MS": "15000",
    "EVO_TYPING_TIMEOUT_MS": "2500",
    "EVO_SEMANTIC_REACTIONS": "1",
    "EVO_VOICE_DIRS": "/home/jaime/.local/share/mini-tui/voice",
}
added = []
for k, v in want.items():
    if k in existing:
        continue
    lines.append(f"{k}={v}")
    added.append(k)
if added:
    tmp = envf + ".v6e.tmp"
    with open(tmp, "w") as fh:
        fh.write("\n".join(lines) + "\n")
    os.chmod(tmp, stat.S_IRUSR | stat.S_IWUSR)
    os.replace(tmp, envf)
print("added:", " ".join(added) if added else "(nothing, already set)")
print("kept 0600:", oct(stat.S_IMODE(os.stat(envf).st_mode)))
PY

# 2. The drop-in that makes `systemd-run --user` (whisper's cgroup lane)
#    reachable from a SYSTEM unit. Without XDG_RUNTIME_DIR every transcription
#    degrades to "temporarily unavailable" and nothing says why.
sudo -n mkdir -p /etc/systemd/system/mini-channel-consumer.service.d
sudo -n cp /home/jaime/mini-tui-wa/deploy/mini-channel-consumer-v6e.conf \
  /etc/systemd/system/mini-channel-consumer.service.d/v6e.conf
sudo -n chown root:root /etc/systemd/system/mini-channel-consumer.service.d/v6e.conf
sudo -n chmod 644 /etc/systemd/system/mini-channel-consumer.service.d/v6e.conf

# 3. The voice allowlist dir the [[mini-voice:]] directive validates against.
sudo -n install -d -m 700 -o jaime -g jaime /home/jaime/.local/share/mini-tui/voice
sudo -n install -d -m 700 -o jaime -g jaime /home/jaime/.local/share/mini-tui/media

sudo -n systemctl daemon-reload
sudo -n systemctl restart mini-channel-consumer
sleep 4
sudo -n systemctl is-active mini-channel-consumer
sudo -n systemctl show mini-channel-consumer -p Environment --value | tr ' ' '\n' | grep XDG_RUNTIME_DIR
echo "--- first 12 log lines ---"
sudo -n journalctl -u mini-channel-consumer --since '20 seconds ago' --no-pager | tail -12