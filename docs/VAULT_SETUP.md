# Vault Setup

How to obtain credentials for each service.

## Setup Flow

1. Copy `.env.vault` to `.env.vault.local`
2. Fill in your tokens (see below for each service)
3. Run `jaunty vault setup`
4. Run `jaunty deploy` to attach the vault to sessions

Services are split into two groups:

- **Works now** — hosted MCP servers exist, just need credentials
- **Needs self-hosted MCP** — no hosted endpoint, requires deploying your own MCP server

---

# Works Now

These services have hosted MCP endpoints. Just add credentials.

---

## GitHub

**Endpoint:** `https://api.githubcopilot.com/mcp/`
**Auth:** Bearer token (fine-grained PAT)
**Free:** Yes

1. Go to https://github.com/settings/tokens?type=beta
2. Generate new token
3. Resource owner: select your org (e.g., `nanohype`)
4. Repository access: select specific repos (e.g., `nanohype/protohype`)
5. Repository permissions:
   - Contents: **Read and write**
   - Issues: **Read and write**
   - Pull requests: **Read and write**
   - Metadata: **Read**
   - Workflows: **Read and write**
6. Copy token → `GITHUB_TOKEN`

If the token is for an org, the org owner may need to approve it at:
https://github.com/organizations/YOUR-ORG/settings/personal-access-tokens/pending

---

## Linear

**Endpoint:** `https://mcp.linear.app/mcp`
**Auth:** Bearer token (API key) — also supports OAuth but bearer is simpler
**Free:** Yes

1. Go to https://linear.app/settings/api
2. Under "Personal API keys", create a new key
3. Copy → `LINEAR_API_KEY`

Linear's MCP server accepts the API key as a Bearer token in the Authorization header. The vault setup sends it as `static_bearer`.

---

## Notion (OAuth required)

**Endpoint:** `https://mcp.notion.com/mcp`
**Auth:** OAuth 2.0 — bearer tokens are NOT supported
**Free:** Yes

Notion's MCP server requires OAuth user authentication. You need to create a public integration and complete an OAuth flow.

### Step 1: Create a public integration

1. Go to https://www.notion.so/my-integrations
2. Click "New integration"
3. Name it (e.g., "jaunty")
4. Type: **Public** (not internal — MCP requires public for OAuth)
5. Under "OAuth Domain & URIs":
   - Redirect URI: `https://localhost:3000/callback` (you'll use this for the one-time auth flow)
6. Under "Capabilities", enable: Read content, Update content, Insert content
7. Save and note:
   - **OAuth client ID** → `NOTION_OAUTH_CLIENT_ID`
   - **OAuth client secret** → `NOTION_OAUTH_CLIENT_SECRET`

### Step 2: Get the OAuth tokens

Run this in your browser to start the auth flow:

```
https://api.notion.com/v1/oauth/authorize?client_id=YOUR_CLIENT_ID&response_type=code&owner=user&redirect_uri=https://localhost:3000/callback
```

1. Authorize the integration and select which pages/databases to share
2. You'll be redirected to `https://localhost:3000/callback?code=AUTHORIZATION_CODE`
3. The page won't load (localhost isn't running) — copy the `code` from the URL
4. Exchange the code for tokens:

```sh
curl -X POST https://api.notion.com/v1/oauth/token \
  -H "Content-Type: application/json" \
  -d '{
    "grant_type": "authorization_code",
    "code": "YOUR_CODE",
    "redirect_uri": "https://localhost:3000/callback"
  }' \
  -u "YOUR_CLIENT_ID:YOUR_CLIENT_SECRET"
```

5. From the response, copy:
   - `access_token` → `NOTION_OAUTH_ACCESS_TOKEN`
   - `refresh_token` (if present) → `NOTION_OAUTH_REFRESH_TOKEN`

### Vault credential type

The vault setup creates an `mcp_oauth` credential for Notion with:

- `mcp_server_url`: `https://mcp.notion.com/mcp`
- `access_token`: your OAuth token
- `refresh`: token endpoint + client credentials for auto-refresh

---

## Slack (OAuth required)

**Endpoint:** `https://mcp.slack.com/mcp`
**Auth:** OAuth user tokens (`xoxp-`) — bot tokens (`xoxb-`) are NOT supported
**Free:** Yes
**Requirement:** App must be directory-published or internal (unlisted apps are prohibited)

### Step 1: Create a Slack App

1. Go to https://api.slack.com/apps
2. Click "Create New App" → "From scratch"
3. Name it (e.g., "jaunty"), select your workspace

### Step 2: Configure OAuth

1. Go to "OAuth & Permissions"
2. Add **User Token Scopes** (NOT Bot Token Scopes). The Slack MCP server needs read access to every surface the bot might be invoked from (DMs, private channels, group DMs) plus identity to map users:
   - `identify` — basic identity confirmation
   - `users:read` — look up users by ID; required by MCP for identity resolution
   - `channels:read` + `channels:history` — public channels (read + read messages)
   - `groups:read` + `groups:history` — private channels (read + read messages)
   - `im:read` + `im:history` — direct messages (read + read messages)
   - `mpim:read` + `mpim:history` — group DMs (read + read messages)
   - `search:read` — search messages and files
   - `chat:write` — post messages back to the user
   - `files:read` + `files:write` — attachment handling

   Omitting any of these scopes produces a 400 at MCP `initialize` with a `missing_scope` body. The tighter subset that omits `users:read` (`search:read,channels:read,channels:history,chat:write,files:read`) fails the same way because `users:read` is required for identity lookup — include it even if you don't otherwise need user info.

3. Under "Redirect URLs", add: `https://localhost:3000/callback`

### Step 3: Publish the app

Slack's MCP server requires the app to be published or internal:

- For internal use: go to "Manage Distribution" → "Enable Internal Distribution"
- For public: submit to Slack App Directory (longer process)

### Step 4: Get the OAuth tokens

1. Go to "Basic Information" → note your:
   - **Client ID** → `SLACK_CLIENT_ID`
   - **Client Secret** → `SLACK_CLIENT_SECRET`

2. Open this URL in your browser to authorize:

```
https://slack.com/oauth/v2/authorize?client_id=YOUR_CLIENT_ID&user_scope=identify,users:read,channels:read,channels:history,groups:read,groups:history,im:read,im:history,mpim:read,mpim:history,search:read,chat:write,files:read,files:write&redirect_uri=https://localhost:3000/callback
```

3. Authorize → redirected to `https://localhost:3000/callback?code=CODE`
4. Copy the `code` from the URL
5. Exchange for tokens:

```sh
curl -X POST https://slack.com/api/oauth.v2.access \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_CLIENT_SECRET" \
  -d "code=YOUR_CODE" \
  -d "redirect_uri=https://localhost:3000/callback"
```

6. From the response, copy:
   - `authed_user.access_token` (`xoxp-...`) → `SLACK_ACCESS_TOKEN`
   - If token rotation is enabled, also save `refresh_token` → `SLACK_REFRESH_TOKEN`

### Step 5: Validate the token before vault setup

Three checks of increasing specificity. Run them in order — the first failure tells you what's wrong.

**1. Is the token valid with Slack at all?**

```sh
curl -s -X POST https://slack.com/api/auth.test \
  -H "Authorization: Bearer $SLACK_ACCESS_TOKEN" | jq
```

Expect `ok: true` plus `user`, `team`, `user_id`, `team_id`. If you see `bot_id` in the response, you have a bot token (`xoxb-`) — not what Slack MCP wants. Re-run the OAuth flow and copy `authed_user.access_token` (`xoxp-`), not `access_token`.

**2. What scopes does the token actually carry?**

Slack returns granted scopes as a response header on every API call:

```sh
curl -s -D - -o /dev/null -X POST https://slack.com/api/auth.test \
  -H "Authorization: Bearer $SLACK_ACCESS_TOKEN" | grep -i 'x-oauth-scopes'
```

Compare against the Step 2 list. Any missing scope means the OAuth authorization didn't include it — re-run the authorize URL with the full `user_scope` list above.

**3. Does the Slack MCP endpoint accept the token?**

```sh
curl -s -i -X POST https://mcp.slack.com/mcp \
  -H "Authorization: Bearer $SLACK_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0.1"}}}'
```

- HTTP 200 + JSON-RPC result → token works; proceed to vault setup.
- HTTP 400 + `missing_scope: <scope>` body → reauthorize with the missing scope added.
- HTTP 401/403 + `app_not_installed` or `not_in_workspace` → the Slack app isn't installed in the workspace this token authenticates to. Go back to Step 3 and verify Internal Distribution is enabled, then reinstall in your workspace.

### Vault credential type

The vault setup creates an `mcp_oauth` credential for Slack with auto-refresh if refresh token + client credentials are provided. If only the access token is set, it uses `static_bearer` (user tokens without rotation don't expire).

---

## Sentry

**Endpoint:** `https://mcp.sentry.io/mcp/`
**Auth:** Bearer token
**Free:** Yes (5k errors/month)

1. Go to https://sentry.io/settings/auth-tokens/
2. Create new token
3. Scopes: `project:read`, `event:read`, `issue:write`
4. Copy → `SENTRY_AUTH_TOKEN`

---

## Figma

**Endpoint:** `https://mcp.figma.com/mcp`
**Auth:** Bearer token (personal access token)
**Free:** Yes (Starter plan, 3 files)

1. Go to Figma → Settings → Account → Personal access tokens
2. Generate new token
3. Copy → `FIGMA_TOKEN`

API is mostly read (inspect files, components, styles). Write is limited to comments.

---

## Hunter.io

**Endpoint:** `https://mcp.hunter.io/sse`
**Auth:** Bearer token (API key)
**Free:** Yes (25 searches/month)

1. Sign up at https://hunter.io
2. Go to https://hunter.io/api-keys
3. Copy → `HUNTER_API_KEY`

---

# Needs Self-Hosted MCP Server

These services don't have hosted MCP endpoints. You need to deploy your own MCP server and set the `MCP_*_URL` env var to point at it.

See the `mcp-proxy` project in protohype (or scaffold one with `jaunty scaffold`).

---

## HubSpot

**Auth:** Private app token (bearer)
**Free:** Yes (free CRM)

1. HubSpot Settings → Integrations → Private Apps → Create
2. Scopes: `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.objects.deals.read`, `crm.objects.deals.write`
3. Copy token → `HUBSPOT_TOKEN`

Self-host: use `@modelcontextprotocol/server-hubspot` or equivalent.
Set `MCP_HUBSPOT_URL` to your deployed endpoint.

---

## Google (all services)

One Google Cloud project + one service account. See the consolidated Google setup below.

### Setup

1. Go to https://console.cloud.google.com → create project (e.g., "jaunty")
2. Create service account: APIs & Services → Credentials → Service Account
3. Create JSON key: click SA → Keys → Add Key → JSON
4. Base64-encode: `base64 -i sa-key.json | tr -d '\n' | pbcopy`
5. Paste → `GDRIVE_SERVICE_ACCOUNT_B64`

### Enable APIs and share resources

| Service   | API to enable             | Share with SA email                     |
| --------- | ------------------------- | --------------------------------------- |
| Drive     | Google Drive API          | Share a Drive folder (Editor)           |
| Calendar  | Google Calendar API       | Share calendar (Make changes to events) |
| Analytics | Google Analytics Data API | Add as Viewer in GA4 property           |

### Google Custom Search Engine (separate API key)

1. https://programmablesearchengine.google.com → create search engine
2. Copy Search Engine ID → `GOOGLE_CSE_ID`
3. Cloud Console → Credentials → Create API Key → `GOOGLE_CSE_API_KEY`
4. Enable "Custom Search API" in API Library

Free: 100 queries/day.

Self-host: wrap each Google API in an MCP server.
Set `MCP_GDRIVE_URL`, `MCP_GCALENDAR_URL`, `MCP_ANALYTICS_URL`, `MCP_GCSE_URL`.

---

## Stripe

**Auth:** API key (bearer)

1. https://dashboard.stripe.com/apikeys
2. Create restricted key with needed permissions
3. Copy → `STRIPE_API_KEY`

Self-host: use `@stripe/agent-toolkit` MCP mode.
Set `MCP_STRIPE_URL` to your deployed endpoint.

---

# Summary

| Service             | Status    | Auth type                 | Time to set up  |
| ------------------- | --------- | ------------------------- | --------------- |
| GitHub              | Live      | Bearer (PAT)              | 1 min           |
| Linear              | Live      | Bearer (API key)          | 30 sec          |
| Notion              | Live      | OAuth (required)          | 10 min          |
| Slack               | Live      | OAuth user token          | 15 min          |
| Sentry              | Live      | Bearer                    | 1 min           |
| Figma               | Live      | Bearer                    | 30 sec          |
| Hunter              | Live      | Bearer                    | 30 sec          |
| HubSpot             | Self-host | Bearer                    | 2 min + deploy  |
| Google (4 services) | Self-host | Service account / API key | 15 min + deploy |
| Stripe              | Self-host | Bearer                    | 1 min + deploy  |
