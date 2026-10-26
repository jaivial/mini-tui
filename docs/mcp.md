# MCP in mini-tui and mini-agent-rs

## Installing servers (`/mcp`)

Remote MCP servers are installed from the terminal (`/mcp`) or the web app (Settings → MCP). Both
write `~/.config/mini-tui/mcp.json` (0600, `MINITUI_MCP_PATH` overrides it), and every agent run gets
the enabled servers with their current tokens through `MINI_AGENT_MCP_SERVERS`. Their tools are
named `mcp__<server>__<tool>`, as in Claude Code.

Presets: OpenPencil (self-hosted on this machine, see [openpencil.md](openpencil.md)), Google
Search Console (Google's own server, your OAuth client: [google-search-console.md](google-search-console.md)), Google
Business Profile (served by mini-tui's web server, several businesses: [google-business-profile.md](google-business-profile.md)), Figma,
Linear, Notion, Atlassian, Stripe, Vercel. Any other Streamable HTTP server can be
added by URL, with an optional static header (API-key servers) or an OAuth client.

### OAuth (Figma and others)

The flow is the MCP authorization spec, as Claude Code implements it:

1. the server answers `401` with `WWW-Authenticate: Bearer resource_metadata=…`;
2. protected-resource metadata (RFC 9728) → authorization-server metadata (RFC 8414);
3. dynamic client registration (RFC 7591) for the redirect URI, cached per redirect;
4. authorization code + PKCE S256 + `resource` (RFC 8707);
5. the token is proved against the MCP server (`initialize` + `tools/list`) before the login
   counts as done; refresh tokens are used before expiry (every 5 minutes, in every process that
   spawns runs: the terminal, the web server, the CLI and the channel consumers).

**Tokens during a run.** A run gets its servers' access tokens at spawn, and some last only an
hour (Google's), while runs, resumes and subagents last longer. The run is also given
`MINI_AGENT_MCP_FILE` (the path of `mcp.json`). When it starts, and whenever a server answers
401/403, the agent reads that server's current credentials from the file. On a 401/403 it opens a
new session and retries the call once. A refresh token the provider refuses (`invalid_grant`)
puts the server in the **expired** state, and the timer stops retrying it until the next login.
Only then is a new login actually needed.

**Figma** only accepts dynamic registration from approved client names (`mini-tui` gets
`403 Forbidden`), so its preset registers as `Claude Code`. A custom server can set its own client
name, or a client id/secret registered out of band.

**Terminal**: the login runs in the background. A listener on `http://localhost:33418/callback`
(`MINITUI_MCP_CALLBACK_PORT`; a free port if taken) waits for the browser, and the panel switches
to "connected" by itself. Keys: `c` copy the link (OSC 52 / tmux / native clipboard), `o` open it
in the browser, `p` paste the address the browser ended on (a browser on another machine, where
the localhost redirect cannot load), `Esc` cancel. The link expires after 10 minutes.

**Web**: the login opens in a popup; the provider redirects to `/api/mcp/oauth/callback` on the
same origin the app was loaded from, the server completes it and the panel notices (the popup's
message, with a poll as fallback). "Copy link" and "Paste redirect URL" cover a popup that is
blocked or a login done on another device.

## The agent side

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
