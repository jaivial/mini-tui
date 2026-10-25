# Google Search Console in mini-tui

Google runs an official MCP server for Search Console at `https://searchconsole.googleapis.com/mcp`.
mini-tui connects to it with the same OAuth flow as the other servers (`/mcp` in the terminal,
Settings → MCP in the web app), and the agent gets:

| tool | what it does |
|---|---|
| `mcp__google-search-console__sites_list` | the properties the account can read (`sc-domain:example.com`, `https://www.example.com/`) |
| `mcp__google-search-console__query` | Search Analytics: clicks, impressions, CTR and position by date, query, page, country, device, search appearance |

Read-only (`webmasters.readonly`). Not covered by Google's server: URL inspection, sitemaps, the
Indexing API.

## Your OAuth client (once)

Google has no dynamic client registration, so the login needs a client of your own:

1. Google Cloud console → a project → enable **Google Search Console API**.
2. OAuth consent screen: add the Google account that owns the properties as a test user.
3. Credentials → OAuth client ID → **Web application**, with the redirect URIs
   - `https://<your mini-tui web origin>/api/mcp/oauth/callback` (web app)
   - `http://localhost:33418/callback` (terminal)
4. Install **Google Search Console** in mini-tui and paste the client id and secret. They are kept
   in `~/.config/mini-tui/mcp.json` (0600) and never returned by the API.

While the consent screen is in **Testing**, Google expires refresh tokens after 7 days: log in again
weekly, or publish the app.

## What mini-tui does differently for it

- **Discovery.** Google's server answers `initialize` and `tools/list` without a token and refuses
  only calls (401). mini-tui reads the protected-resource metadata
  (`/.well-known/oauth-protected-resource/mcp` → `accounts.google.com`) even when `initialize`
  succeeds, and an anonymous tool listing does not count as a working connection.
- **Refresh tokens.** Google issues one only with `access_type=offline&prompt=consent`; mini-tui adds
  both for `accounts.google.com`. Access tokens last an hour and are refreshed in the background.
- **Fixed loopback port.** A hand-registered client accepts one redirect URI, so the terminal login
  fails with a clear message when port 33418 is busy instead of falling back to a random port.
