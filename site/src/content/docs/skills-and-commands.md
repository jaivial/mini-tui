---
title: Commands and skills
description: Slash commands and $skills in mini-tui: what each command does, how skills are matched, how they reach the agent, and where they live on disk.
section: Use it
order: 5
---

## Commands

Type `/` at the start of a message.

| Command | What it does |
| --- | --- |
| `/new` | Start a new chat. In the web app nothing is created until you send. |
| `/model [id]` | Open the model picker, or switch straight to an id. |
| `/compact` | Summarize the conversation now to free context. |
| `/subagents [name]` | List the subagents this session started, or open one (web app). In the terminal, `/resume` opens one. |
| `/connect` | Connect a provider with your own API key. |
| `/settings` | Open settings. |
| `/skills` | Browse the skills you can reference with `$name`. |
| `/help` | Commands and keys. |

Picking a command from the menu fills it in and never runs it, so a stray Enter cannot fire `/new`. A path
such as `/etc/hosts`, or a sentence that happens to start with a slash, goes to the agent unchanged.

## Skills

A skill is a folder with a `SKILL.md`. Type `$` anywhere in a message and mini-tui lists the skills, filtering
on any word of the name in any order: `$body` and `$body-pr` both find `pr-body`.

```text
follow $good-code, then use $better-ui and $pr-body
```

The agent receives each referenced skill's instructions ahead of your prompt, then your prompt as you typed
it. The transcript shows only what you typed. An unknown `$name` stays plain text.

## Where skills live

mini-tui keeps its own folder, `~/.config/mini-tui/skills/` (override with `MINITUI_SKILLS_DIR`). At install
and at every startup, each skill in `~/.claude/skills` that the folder does not have yet is copied in.
Copies are never overwritten, and a skill you delete is not re-imported. `bun run sync-skills` runs it by
hand.

## Bundled skills

mini-tui ships its own skills and installs them into that folder at install and at every startup. A newer
version replaces a copy you have not edited; one you edited or deleted is left as you made it.

- `$subagents`: how an agent splits work across subagents of its own session (Rust agent): spawn them,
  keep working while they run, steer them with messages, and collect and check their results.
- `$e2e`: how an agent writes and runs `mini-agent-rs e2e` browser tests.
