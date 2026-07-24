# poke-ical

An iCloud CalDAV MCP bridge for Poke, deployed as a Cloudflare Worker.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ImSingee/poke-ical)

## Deployment guide

### 1. Deploy the Worker

Click the button above, or deploy manually:

```bash
npm install
npx wrangler deploy
```

### 2. Create an App Token

```bash
printf '%s' '<Apple Account>:<App-Specific Password>' | base64
```

The Base64 output is your App Token. To generate an app-specific password, sign in at [appleid.apple.com](https://appleid.apple.com), then go to **Sign-In and Security** → **App-Specific Passwords**.

### 3. Connect to Poke

Once deployed, add your Worker URL as an MCP integration in Poke:

```
https://<your-worker>.workers.dev/mcp
```

Set the App Token as the API Key in Poke. Poke sends it on both the SSE `GET /mcp` request and the JSON-RPC `POST /mcp` request as:

```http
Authorization: Bearer <App Token>
```

---

## MCP endpoint

All MCP communication happens at:

```
/mcp
```

Accepts both `GET` (SSE stream) and `POST` (JSON-RPC 2.0) requests, and requires:

```http
Authorization: Bearer <App Token>
```

## Available tools

- `list_calendars` — list all iCloud calendars on the account
- `list_events` — list events in a calendar, with optional date range filter
- `get_event` — fetch raw iCalendar data for a specific event
- `create_event` — create a new event
- `update_event` — update fields on an existing event
- `delete_event` — delete an event
- `search_events` — search events by keyword
- `get_freebusy` — return busy intervals within a date range
- `get_ical_feed` — return all events as a complete `.ics` feed
