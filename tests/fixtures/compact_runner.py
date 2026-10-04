#!/usr/bin/python3
"""Stub console-script runner: logs its argv and writes a finished trajectory.

The trajectory carries a Compaction marker, so the caller's transcript ends up in the same
state a real `--compact-only` run leaves it in.
"""
import json
import os
import sys

args = sys.argv[1:]
traj = args[args.index("-o") + 1] if "-o" in args else ""
log = os.environ.get("STUB_LOG")
if log:
    with open(log, "a") as fh:
        fh.write(" ".join(args) + "\n")

SUMMARY = (
    "[Context compacted: the earlier part of this conversation was summarized to fit the context"
    " window. The most recent messages follow verbatim after this one.]"
    "\n\n<summary>the conversation so far, summarized</summary>"
    "\nThe messages after this one are the latest steps, verbatim; their commands already ran and"
    " their outputs are current. Continue from the last of them: do not redo completed steps and do"
    " not ask the user to repeat themselves."
)

body = {
    "info": {
        "model_stats": {"instance_cost": 0.02, "api_calls": 3},
        "exit_status": "Submitted",
    },
    "messages": [
        {"role": "system", "content": "system prompt"},
        {"role": "user", "content": "first turn"},
        {
            "role": "assistant",
            "content": "the first answer, long enough to be worth keeping in the transcript",
        },
        {
            "role": "user",
            "content": SUMMARY,
            "extra": {
                "interrupt_type": "Compaction",
                "compaction": {
                    "head": 1,
                    "tail_messages": 2,
                    "reason": "manual",
                    "tokens_before": 900,
                    "trigger_tokens": 800,
                    "context_window": 1000,
                    "summarized_messages": 1,
                    "summary_usage": {"prompt": 0, "cache_read": 0, "cache_write": 0},
                    "user_messages": ["first turn"],
                },
            },
        },
    ],
    "trajectory_format": "mini-swe-agent-1.1",
}

if traj:
    with open(traj, "w") as fh:
        fh.write(json.dumps(body))
