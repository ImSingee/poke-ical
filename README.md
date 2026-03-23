# poke-ical

An iCloud CalDAV MCP bridge for Poke, deployed as a Cloudflare Worker.

Exposes iCloud calendar data via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) over SSE, so Poke can read and manage your iCloud calendars.

## Endpoint

All MCP communication happens at:

```
/mcp
```

Accepts both `GET` (SSE stream) and `POST` (JSON-RPC 2.0) requests.

## Required secrets

Set these via `npx wrangler secret put` before deploying:

| Secret | Description |
|---|---|
| `CALDAV_USERNAME` | Your Apple ID email (e.g. `you@icloud.com`) |
| `CALDAV_PASSWORD` | An app-specific password from [appleid.apple.com](https://appleid.apple.com) |

## Deployment

```bash
npm install
npx wrangler secret put CALDAV_USERNAME
npx wrangler secret put CALDAV_PASSWORD
npx wrangler deploy
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
