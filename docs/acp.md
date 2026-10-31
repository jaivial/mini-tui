# mini-tui as an ACP agent

`mini-agent-rs acp` serves the [Agent Client Protocol](https://agentclientprotocol.com) (ACP) on
stdin/stdout: JSON-RPC 2.0, one message per line. Any ACP client (Paseo, Zed, other editors) can
then run mini-tui sessions: the same agent, models, connected providers, MCP servers and
trajectories as the TUI and the web app.

```sh
mini-agent-rs acp            # speak ACP on stdio; nothing but JSON-RPC is written to stdout
```

## How a session runs

The server is a small session manager, not a second agent:

- `session/new` only allocates an id and answers with the model picker. Nothing is written to
  disk until the first prompt, so a client that opens a session to discover models leaves no
  trace.
- Each `session/prompt` runs this same binary as an ordinary mini-agent turn in the session's
  `cwd`: `mini-agent-rs -y --exit-immediately -o turn-N.traj.json --resume <previous turn> -m
  <model> -t @task.txt`, with the environment mini-tui gives its own runs (`MINITUI_AGENT_TOOLS`,
  the control file, the `cu` browser server, `MINITUI_SESSION_ID`, recovery trajectories, the
  connected providers' keys, the reasoning levels from `settings.json`).
- While the turn runs, its journal (`turn-N.traj.jsonl`) is read every 150 ms and forwarded as
  `session/update` notifications. The prompt is answered when the agent exits.
- Between turns the server runs nothing but a blocking stdin read: one thread, no CPU, about
  6.5 MB RSS.

Sessions live in `~/.config/mini-tui/acp-sessions/<sessionId>/` (`MINI_AGENT_ACP_HOME`
overrides): `meta.json` (`cwd`, `model`, `title`, timestamps and one entry per turn), the turns'
trajectories and logs, `control`, `task.txt` and `attachments/`. The trajectories are ordinary
mini-agent trajectories, so `mini-agent-rs --resume` and mini-tui's trajectory viewers read them
as they are. ACP sessions are not entered in mini-tui's `sessions.db`.

## Methods

| Method | Behaviour |
| --- | --- |
| `initialize` | Protocol version 1. Capabilities: `loadSession`, image prompts, embedded context, HTTP MCP servers, `session/list`, `session/close`. No auth methods. |
| `authenticate` | Accepted, does nothing: credentials come from mini-tui's providers and env. |
| `session/new` | `{cwd, mcpServers}` → `{sessionId, configOptions}` (the `model` select). |
| `session/load` | Replays the stored conversation as notifications, then answers `{configOptions}`. |
| `session/prompt` | Runs a turn; answers `{stopReason}`. A prompt sent while a turn runs is handed to the agent as a follow-up (it reads it before its next step) and answered with that turn. |
| `session/cancel` | SIGINT to the agent (it saves), SIGTERM after 2 s; the prompt answers `cancelled`. |
| `session/set_config_option` | `configId: "model"`; a running turn switches from its next step. Answers `{configOptions}`. |
| `session/set_model` | The same switch through the older method. |
| `session/list` | Stored sessions (optionally for one `cwd`), newest first, with titles. |
| `session/close` | Stops the session's agent and forgets the session in this process. |
| anything else | `-32601 Method not found`. Unknown notifications are ignored. |

There are no modes and no permission requests: mini-tui runs yolo, as it does everywhere.

## What the client sees

| Journal | `session/update` |
| --- | --- |
| `delta` text / thinking fragments | `agent_message_chunk` / `agent_thought_chunk` as they stream |
| assistant message | the text and reasoning not already streamed; one `tool_call` per action (`in_progress`) |
| `tool` message (or a text model's observation) | `tool_call_update`: `completed`, or `failed` on a non-zero return code or an exception; output capped at 40 000 characters |
| `info` | `usage_update` (`used` = the last call's prompt + output tokens, `size` = the model's window from `config/model-limits.json`, `cost` in USD), when the window is known |
| `exit` | the submission, if no assistant text carried it; the stop reason |
| first prompt | `session_info_update` with a fallback title, then the generated one (`mini-agent-rs title`; `MINI_AGENT_ACP_TITLES=0` turns it off) |

Tool calls carry `kind` (`execute` for bash/code, `read`, `edit` for write/edit, `fetch` for the
browser server, `other`), a title (the command, `Read <path>`, `Edit <path>`, `<server>: <tool>`
for MCP), `rawInput` and `locations`. Edits also carry `filePath`, `oldString` and `newString`,
which Paseo renders as a diff.

The agent journals a step when the step ends. A command therefore appears when it has finished
(or when the turn is cancelled), not when it starts.

Stop reasons: `end_turn` for a submitted answer or any other clean exit (with a note naming the
exit status when the agent stopped without answering), `max_turn_requests` for the step, cost and
time limits, `cancelled` after `session/cancel`. A turn whose agent fails (an exhausted model
retry, a bad key) answers with a JSON-RPC error carrying the agent's last log line.

## Models

The `model` select lists mini-tui's curated models, then every model of every connected provider
(`~/.config/mini-tui/providers.json`), deduplicated and capped at 200. A new session starts on
`MINITUI_MODEL` if set, else on the model mini-tui used last (`last-model.json`), else the first
entry. Any model id is accepted from the client, listed or not. Keys follow mini-tui's
`modelEnv`: the matching connection's variables, plus the other native connections' keys so a
mid-run switch still authenticates.

## MCP servers

The client's `mcpServers` (stdio `{command, args, env}` and HTTP `{url, headers}`) are passed to
the agent in `MINI_AGENT_MCP_SERVERS` along with the servers installed in mini-tui
(`~/.config/mini-tui/mcp.json`, enabled and logged in). A client server replaces an installed one
of the same name; a client server named `cu` is renamed `cu-client`. Tokens of installed servers
are not copied: the agent reads them from `mcp.json` (`MINI_AGENT_MCP_FILE`), which also refreshes
them mid-run. SSE-only servers are not supported (`mcpCapabilities.sse: false`).

## Prompts

Text blocks become the task. Images (and blobs) are saved to the session's `attachments/` and
listed in an `<attachments>` block, as the web app does; the agent's `read` tool opens them.
`resource_link` blocks are listed by path; embedded text resources are inlined in `<resource>`
tags.

## Paseo

Paseo ships a built-in `mini-tui` provider plugin that runs `mini-agent-rs acp`. Older Paseo
versions (0.13.0 from npm included) can add it as a generic ACP provider in
`~/.paseo/config.json`:

```json
{
  "agents": {
    "providers": {
      "mini-tui": {
        "extends": "acp",
        "label": "mini-tui",
        "description": "mini-tui's Rust agent over ACP",
        "command": ["/home/you/.local/lib/mini-tui/mini-agent-rs", "acp"]
      }
    }
  }
}
```

The binary must be a build with the `acp` subcommand. When it is not inside a mini-tui checkout,
add `"env": {"MINITUI_HOME": "/path/to/mini-tui"}` so the agent finds the shipped YAML configs and
model limits.

## Testing

```sh
cd agent-rs && cargo test --release acp::        # framing, event mapping, catalog, store, replay
python3 agent-rs/scripts/acp_e2e.py               # the server against a scripted OpenAI mock
```

The end-to-end script needs no network or keys: HOME, the session store and the configs are
temporary, the model is a local mock (`openai/gpt-mock`) on a free port. It covers initialize,
a bash tool call and a streamed answer, a client stdio MCP server reaching the model, history
across turns, cancel during `sleep 30`, resuming after the cancel, `session/load` replay in a new
process, list, model switch, close, stdin EOF and SIGTERM.

## Known gaps

- Commands show up when their step ends, not when they start (see above).
- No `thought_level` option: reasoning levels come from mini-tui's `settings.json`.
- Paseo's `_meta._paseo.systemPrompt` is not passed to the agent.
- ACP sessions are stored beside mini-tui's sessions, not in `sessions.db`, so the TUI's
  `/resume` and the web app do not list them.
- MCP preset hints that only mini-tui's TypeScript side knows are not applied to installed servers.
