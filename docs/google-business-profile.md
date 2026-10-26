# Google Business Profile in mini-tui

Google publishes an MCP server for Search Console, but none for Business Profile. mini-tui serves
one itself: the web server answers `http://127.0.0.1:4317/api/gbp/mcp` (`MINITUI_WEB_PORT`) and
forwards each call to Google's Business Profile REST APIs. It uses **your** Google access token.
Install it like any other server (`/mcp` in the terminal, Settings → MCP in the web app,
**Google Business Profile**). The agent's tools are named `mcp__google-business__<tool>`.

| tool | what it does |
|---|---|
| `businesses_list` | saved businesses (alias, account, location) and the default |
| `accounts_list`, `locations_list` | what this Google login manages, to find the ids |
| `business_add`, `business_select`, `business_remove` | save several businesses, pick the default, forget one |
| `location_get` | profile: categories, NAP, hours, description, Maps/Place ids (`googleUpdated` = Google's pending edits) |
| `location_update` | **writes** fields named in `updateMask` (`validateOnly` first) |
| `reviews_list`, `review_reply` | reviews with rating and replies; **writes** a reply |
| `posts_list`, `post_create` | local posts; **writes** a post |
| `performance` | daily impressions (Maps/Search, mobile/desktop), calls, website clicks, directions, bookings |
| `search_keywords` | monthly search terms that showed the profile |

Every business tool takes an optional `business` (an alias from `businesses_list`). Without it the
call goes to the default business. The first business you save becomes the default. Saved
businesses live in `~/.config/mini-tui/google-business.json` (0600; `MINITUI_GBP_PATH` overrides
it). That file holds ids only, never a token.

## What you need from Google (once)

1. **A Google Cloud project.** You can reuse the Search Console one.
2. **Business Profile API access.** These APIs start with a quota of 0. Request access with
   Google's form (https://developers.google.com/my-business/content/prereqs). Use the email of an
   owner/manager of a profile that has been verified for 60+ days, and give the project number.
   Approval sets the quota to 300 QPM. Until then every call answers `403` / `429`, and mini-tui
   says so.
3. **Enable these APIs** in that project:
   - My Business Account Management API (`mybusinessaccountmanagement.googleapis.com`)
   - My Business Business Information API (`mybusinessbusinessinformation.googleapis.com`)
   - Google My Business API (`mybusiness.googleapis.com`, v4: reviews and posts)
   - Business Profile Performance API (`businessprofileperformance.googleapis.com`)
4. **OAuth consent screen.** Add the scope `https://www.googleapis.com/auth/business.manage`, and
   add the Google account that manages the profiles as a test user. In Testing, refresh tokens
   expire after 7 days. You can publish the app instead, but this scope is sensitive, so
   publishing needs Google's verification.
5. **OAuth client ID**, type **Web application**, with these redirect URIs:
   - `https://<your mini-tui web origin>/api/mcp/oauth/callback` (web app)
   - `http://localhost:33418/callback` (terminal)

   You can reuse the Search Console client: add the scope on the consent screen.
6. **In mini-tui:** install Google Business Profile, paste the client id and secret, and log in
   with the Google account that manages the profiles. Then ask the agent to use `accounts_list` →
   `locations_list` → `business_add` for each business (`accounts/<n>`, `locations/<n>`).

## How it works

- **Auth is Google's.** An anonymous request gets a 401 that points (RFC 9728) at
  `accounts.google.com` with the `business.manage` scope. mini-tui's usual flow then runs: your
  client, PKCE, `access_type=offline`, a refresh every 5 minutes, and a reload from `mcp.json` on a
  401 mid-run. The login leaves out RFC 8707 `resource` (`omitResource`), because Google does not
  know this local URL.
- **Token check.** The endpoint asks Google's `tokeninfo` whether the token is live and carries
  `business.manage`, and caches the answer for at most 10 minutes. It neither stores nor logs the
  token. If Google refuses the token during a call, the endpoint answers 401 so the agent reloads
  it.
- **Loopback only.** Requests through the public proxy, or from a non-loopback address, get 404.
- **The web server must be running.** The terminal installs the server too, but the endpoint lives
  in `mini-tui-web` (or the Docker container).
