---
title: Providers and models
description: Bring your own model keys to mini-tui: supported providers, how a key is tested and stored, how a model is chosen, and which key each run receives.
section: Use it
order: 7
---

mini-tui talks to models directly, with no proxy layer in between. You bring the key.

## Supported providers

Xiaomi MiMo, DeepSeek, OpenCode Go, Z.AI, MiniMax (global and China), OpenAI, Anthropic, Moonshot, Zhipu,
Groq and OpenRouter. Any OpenAI-compatible endpoint also works through the generic `openai/` slot.

## How a key is handled

1. You paste the key in `/connect` or **Settings, Providers**.
2. mini-tui asks the provider for its model list, then sends **one real request** through the agent's own
   model layer. A passing test means a run will work with this key.
3. Only then is the key saved, to `~/.config/mini-tui/providers.json` with `0600` permissions. A typo never
   replaces a working connection.
4. The web API never returns a key. Reads carry a masked hint such as `sk-…a1b2`.

## Which key a run gets

A run receives the credentials of **its own model's provider only**. Choosing `deepseek/deepseek-chat` puts
the DeepSeek key in that run's environment and nothing else.

## Choosing a model

Use `/model`, or `-m <id>` on the command line. The last model you pick anywhere becomes the default for new
chats. In the web app the picker is searchable and grouped by provider, and a model that is not listed can
be typed.
