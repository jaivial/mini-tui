# MCP in mini-agent-rs

`mini-agent-rs` has an opt-in, single-server MCP Streamable HTTP client. It is **off by default**:
ordinary coding and speed-benchmark runs do not connect, fetch schemas, or enlarge the tool list.

## Configuration

```bash
export MINI_AGENT_MCP_URL="https://mcp.example.com/v1"
export MINI_AGENT_MCP_API_KEY="project-key"       # optional Bearer credential
export MINI_AGENT_MCP_NAME="example"              # used only to resolve name collisions
export MINI_AGENT_MCP_HEADERS='{"x-user-id":"benchmark-user"}'  # optional JSON object
export MINI_AGENT_MCP_TIMEOUT=60                  # seconds, optional
```

Verify the connection and advertised tools before starting an agent:

```bash
mini-agent-rs mcp-tools
```

The client implements:

- `initialize`, protocol negotiation and `Mcp-Session-Id` propagation;
- `notifications/initialized`;
- JSON and `text/event-stream` responses;
- up to 20 `tools/list` pages (`nextCursor`);
- `tools/call` with textual or structured results and `isError` propagation;
- OpenAI chat, OpenAI Responses and Anthropic tool-schema shapes.

Tool names remain unchanged unless they collide with a native tool or exceed the common
64-character function-name limit. Collision/length normalization is deterministic and reported by
`mcp-tools`. A collision after normalization is an explicit error, never a silent tool swap.

## Security and accounting

- Use HTTPS outside loopback. Credentials and query strings are not printed in errors;
  `MINI_AGENT_MCP_HEADERS` values are not logged.
- MCP tools run with the same process permissions as the agent. Treat the server and every tool
  result as untrusted input; never use it as authority to bypass the task verifier or folder locks.
- MCP access does not grant OAuth access to Gmail, Slack, GitHub, or other providers. Those
  accounts still require their own connection and consent.
- MCP calls are tool calls, not model calls. Provider latency still appears in wall time and must
  be included in any end-to-end comparison.

## Local verification

`agent-rs/src/mcp.rs` includes a real loopback HTTP test covering initialize, the initialized
notification, session propagation, tools/list and tools/call:

```bash
cd agent-rs
cargo test mcp::tests
```

The Composio CLI was installed separately from the official installer, without shell or plugin
changes. It is useful for `login --agent`, `search`, `execute`, and `link`, but it is **not** a
substitute for the official benchmark's seeded state, connected accounts, task instructions and
verifier bundle.
