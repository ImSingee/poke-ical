/**
 * poke-ical: iCloud Calendar MCP Server (Cloudflare Worker)
 *
 * Exposes 9 CalDAV tools via the Model Context Protocol over SSE.
 * Endpoint: /mcp
 *
 * Required env vars / secrets:
 *   CALDAV_USERNAME  — Apple ID email
 *   CALDAV_PASSWORD  — App-specific password from appleid.apple.com
 *   CALDAV_HOME_URL  — (optional) CalDAV principal URL; defaults to iCloud
 */

export interface Env {
  CALDAV_USERNAME: string;
  CALDAV_PASSWORD: string;
  CALDAV_HOME_URL?: string;
}

// ---------------------------------------------------------------------------
// MCP protocol types
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ---------------------------------------------------------------------------
// CalDAV helpers
// ---------------------------------------------------------------------------

const ICLOUD_CALDAV = 'https://caldav.icloud.com';

function basicAuth(env: Env): string {
  return 'Basic ' + btoa(`${env.CALDAV_USERNAME}:${env.CALDAV_PASSWORD}`);
}

function homeUrl(env: Env): string {
  return env.CALDAV_HOME_URL ?? `${ICLOUD_CALDAV}/`;
}

async function caldavRequest(
  env: Env,
  url: string,
  method: string,
  body?: string,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = {
    Authorization: basicAuth(env),
    'Content-Type': 'application/xml; charset=utf-8',
    ...extraHeaders,
  };
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  return { status: res.status, text };
}

// Minimal XML value extractor (no full parser needed for CalDAV)
function xmlValues(xml: string, tag: string): string[] {
  const results: string[] = [];
  const re = new RegExp(`<[^>]*:?${tag}[^>]*>([\\s\\S]*?)<\/[^>]*:?${tag}>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) results.push(m[1].trim());
  return results;
}

function xmlAttr(tag: string, xml: string, attr: string): string {
  const re = new RegExp(`<[^>]*:?${tag}[^>]*${attr}="([^"]*)"`,'i');
  const m = re.exec(xml);
  return m ? m[1] : '';
}

// ---------------------------------------------------------------------------
// Discover calendars via PROPFIND
// ---------------------------------------------------------------------------
async function discoverCalendars(
  env: Env,
): Promise<Array<{ url: string; displayName: string; ctag: string }>> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:displayname/>
    <D:resourcetype/>
    <CS:getctag xmlns:CS="http://calendarserver.org/ns/"/>
  </D:prop>
</D:propfind>`;

  const { text } = await caldavRequest(env, homeUrl(env), 'PROPFIND', body, { Depth: '1' });

  // Extract calendar entries from multistatus
  const responses = text.split(/<D:response|<response/i).slice(1);
  const calendars: Array<{ url: string; displayName: string; ctag: string }> = [];

  for (const resp of responses) {
    // Only include actual calendar collections
    if (!resp.includes('calendar') && !resp.includes('Calendar')) continue;
    const hrefMatch = /<D:href>([^<]+)<\/D:href>/i.exec(resp) ??
                      /<href>([^<]+)<\/href>/i.exec(resp);
    if (!hrefMatch) continue;
    const href = hrefMatch[1].trim();
    const nameMatch = /<D:displayname>([^<]*)<\/D:displayname>/i.exec(resp) ??
                      /<displayname>([^<]*)<\/displayname>/i.exec(resp);
    const displayName = nameMatch ? nameMatch[1].trim() : href;
    const ctagMatch = /<[^>]*:?getctag[^>]*>([^<]*)<\/[^>]*:?getctag>/i.exec(resp);
    const ctag = ctagMatch ? ctagMatch[1].trim() : '';
    const url = href.startsWith('http') ? href : `${ICLOUD_CALDAV}${href}`;
    calendars.push({ url, displayName, ctag });
  }
  return calendars;
}

// ---------------------------------------------------------------------------
// Fetch events from a calendar URL via REPORT
// ---------------------------------------------------------------------------
async function fetchEvents(
  env: Env,
  calendarUrl: string,
  start?: string,
  end?: string,
): Promise<Array<Record<string, string>>> {
  let timeFilter = '';
  if (start || end) {
    const s = start ?? '19700101T000000Z';
    const e = end ?? '20991231T235959Z';
    timeFilter = `
      <C:time-range start="${s}" end="${e}"/>`;
  }

  const body = `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">${timeFilter}
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;

  const { text } = await caldavRequest(env, calendarUrl, 'REPORT', body, {
    Depth: '1',
    'Content-Type': 'application/xml; charset=utf-8',
  });

  return parseEvents(text);
}

// ---------------------------------------------------------------------------
// Parse VCALENDAR response into event objects
// ---------------------------------------------------------------------------
function parseEvents(xml: string): Array<Record<string, string>> {
  const events: Array<Record<string, string>> = [];
  // Extract each calendar-data block
  const dataBlocks = xmlValues(xml, 'calendar-data');
  const etagBlocks = xmlValues(xml, 'getetag');
  const hrefBlocks = xmlValues(xml, 'href');

  for (let i = 0; i < dataBlocks.length; i++) {
    const ical = dataBlocks[i];
    const event: Record<string, string> = {};
    event.etag = etagBlocks[i] ?? '';
    event.href = hrefBlocks[i] ?? '';

    // Parse VEVENT properties
    const veventMatch = /BEGIN:VEVENT([\s\S]*?)END:VEVENT/i.exec(ical);
    if (!veventMatch) continue;
    const vevent = veventMatch[1];

    for (const line of vevent.split(/\r?\n/)) {
      const colonIdx = line.indexOf(':');
      if (colonIdx < 0) continue;
      const key = line.substring(0, colonIdx).split(';')[0].toUpperCase();
      const val = line.substring(colonIdx + 1);
      event[key] = val;
    }
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Create a VEVENT iCalendar string
// ---------------------------------------------------------------------------
function makeVEvent(params: {
  uid: string;
  summary: string;
  dtstart: string;
  dtend: string;
  description?: string;
  location?: string;
  allDay?: boolean;
}): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//poke-ical//EN',
    'BEGIN:VEVENT',
    `UID:${params.uid}`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:.]/g, '').substring(0, 15)}Z`,
    `SUMMARY:${params.summary}`,
    params.allDay
      ? `DTSTART;VALUE=DATE:${params.dtstart}`
      : `DTSTART:${params.dtstart}`,
    params.allDay
      ? `DTEND;VALUE=DATE:${params.dtend}`
      : `DTEND:${params.dtend}`,
  ];
  if (params.description) lines.push(`DESCRIPTION:${params.description}`);
  if (params.location) lines.push(`LOCATION:${params.location}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n');
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'list_calendars',
    description: 'List all iCloud calendars available on the account.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'list_events',
    description: 'List events in a calendar, optionally filtered by a date range.',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_url: { type: 'string', description: 'CalDAV URL of the calendar (from list_calendars).' },
        start: { type: 'string', description: 'Start datetime in iCalendar format (e.g. 20260101T000000Z).' },
        end: { type: 'string', description: 'End datetime in iCalendar format (e.g. 20261231T235959Z).' },
      },
      required: ['calendar_url'],
    },
  },
  {
    name: 'get_event',
    description: 'Fetch the raw iCalendar data for a specific event by its URL.',
    inputSchema: {
      type: 'object',
      properties: {
        event_url: { type: 'string', description: 'Full CalDAV URL of the event .ics resource.' },
      },
      required: ['event_url'],
    },
  },
  {
    name: 'create_event',
    description: 'Create a new event in a calendar.',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_url: { type: 'string', description: 'CalDAV URL of the target calendar.' },
        summary: { type: 'string', description: 'Event title.' },
        dtstart: { type: 'string', description: 'Start in iCalendar format (e.g. 20260315T140000Z).' },
        dtend: { type: 'string', description: 'End in iCalendar format (e.g. 20260315T150000Z).' },
        description: { type: 'string', description: 'Optional event description.' },
        location: { type: 'string', description: 'Optional location.' },
        all_day: { type: 'boolean', description: 'Set true for all-day events (use DATE format for dtstart/dtend).' },
      },
      required: ['calendar_url', 'summary', 'dtstart', 'dtend'],
    },
  },
  {
    name: 'update_event',
    description: 'Update an existing event. Fetches the event, applies changes, and saves it back.',
    inputSchema: {
      type: 'object',
      properties: {
        event_url: { type: 'string', description: 'Full CalDAV URL of the .ics event.' },
        etag: { type: 'string', description: 'Current ETag of the event (for conflict detection). Optional.' },
        summary: { type: 'string', description: 'New title (leave out to keep existing).' },
        dtstart: { type: 'string', description: 'New start datetime.' },
        dtend: { type: 'string', description: 'New end datetime.' },
        description: { type: 'string', description: 'New description.' },
        location: { type: 'string', description: 'New location.' },
      },
      required: ['event_url'],
    },
  },
  {
    name: 'delete_event',
    description: 'Delete an event from a calendar.',
    inputSchema: {
      type: 'object',
      properties: {
        event_url: { type: 'string', description: 'Full CalDAV URL of the .ics event to delete.' },
        etag: { type: 'string', description: 'ETag for safe deletion (optional).' },
      },
      required: ['event_url'],
    },
  },
  {
    name: 'search_events',
    description: 'Search for events by keyword in summary, description, or location across a calendar.',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_url: { type: 'string', description: 'CalDAV URL of the calendar to search.' },
        query: { type: 'string', description: 'Keyword to search for (case-insensitive).' },
        start: { type: 'string', description: 'Optional start bound (iCal format).' },
        end: { type: 'string', description: 'Optional end bound (iCal format).' },
      },
      required: ['calendar_url', 'query'],
    },
  },
  {
    name: 'get_freebusy',
    description: 'Return free/busy information (list of busy intervals) for a calendar within a date range.',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_url: { type: 'string', description: 'CalDAV URL of the calendar.' },
        start: { type: 'string', description: 'Range start in iCal format.' },
        end: { type: 'string', description: 'Range end in iCal format.' },
      },
      required: ['calendar_url', 'start', 'end'],
    },
  },
  {
    name: 'get_ical_feed',
    description: 'Return all events as a complete iCalendar (.ics) feed string for a given calendar.',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_url: { type: 'string', description: 'CalDAV URL of the calendar.' },
      },
      required: ['calendar_url'],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  env: Env,
): Promise<unknown> {
  switch (name) {
    // ---- list_calendars ---------------------------------------------------
    case 'list_calendars': {
      const cals = await discoverCalendars(env);
      return { calendars: cals };
    }

    // ---- list_events ------------------------------------------------------
    case 'list_events': {
      const url = args.calendar_url as string;
      const start = args.start as string | undefined;
      const end = args.end as string | undefined;
      const events = await fetchEvents(env, url, start, end);
      return { events };
    }

    // ---- get_event --------------------------------------------------------
    case 'get_event': {
      const url = args.event_url as string;
      const { status, text } = await caldavRequest(env, url, 'GET');
      if (status >= 400) throw new Error(`GET ${url} returned ${status}`);
      return { ical: text };
    }

    // ---- create_event -----------------------------------------------------
    case 'create_event': {
      const calUrl = args.calendar_url as string;
      const uid = crypto.randomUUID();
      const ical = makeVEvent({
        uid,
        summary: args.summary as string,
        dtstart: args.dtstart as string,
        dtend: args.dtend as string,
        description: args.description as string | undefined,
        location: args.location as string | undefined,
        allDay: args.all_day as boolean | undefined,
      });
      const eventUrl = calUrl.replace(/\/?$/, '/') + uid + '.ics';
      const { status } = await caldavRequest(env, eventUrl, 'PUT', ical, {
        'Content-Type': 'text/calendar; charset=utf-8',
        'If-None-Match': '*',
      });
      if (status >= 400) throw new Error(`PUT event returned ${status}`);
      return { uid, event_url: eventUrl, status };
    }

    // ---- update_event -----------------------------------------------------
    case 'update_event': {
      const eventUrl = args.event_url as string;
      // Fetch current event
      const { status: getStatus, text: existing } = await caldavRequest(env, eventUrl, 'GET');
      if (getStatus >= 400) throw new Error(`GET event returned ${getStatus}`);

      // Build updated ical by patching the existing one
      let updated = existing;
      if (args.summary) updated = updated.replace(/SUMMARY:.*/i, `SUMMARY:${args.summary}`);
      if (args.dtstart) updated = updated.replace(/DTSTART[^:]*:.*/i, `DTSTART:${args.dtstart}`);
      if (args.dtend) updated = updated.replace(/DTEND[^:]*:.*/i, `DTEND:${args.dtend}`);
      if (args.description) {
        if (/DESCRIPTION:/i.test(updated)) {
          updated = updated.replace(/DESCRIPTION:.*/i, `DESCRIPTION:${args.description}`);
        } else {
          updated = updated.replace(/END:VEVENT/i, `DESCRIPTION:${args.description}\r\nEND:VEVENT`);
        }
      }
      if (args.location) {
        if (/LOCATION:/i.test(updated)) {
          updated = updated.replace(/LOCATION:.*/i, `LOCATION:${args.location}`);
        } else {
          updated = updated.replace(/END:VEVENT/i, `LOCATION:${args.location}\r\nEND:VEVENT`);
        }
      }

      const ifMatchHeaders: Record<string, string> = {
        'Content-Type': 'text/calendar; charset=utf-8',
      };
      if (args.etag) ifMatchHeaders['If-Match'] = args.etag as string;

      const { status } = await caldavRequest(env, eventUrl, 'PUT', updated, ifMatchHeaders);
      if (status >= 400) throw new Error(`PUT update returned ${status}`);
      return { event_url: eventUrl, status };
    }

    // ---- delete_event -----------------------------------------------------
    case 'delete_event': {
      const eventUrl = args.event_url as string;
      const headers: Record<string, string> = {};
      if (args.etag) headers['If-Match'] = args.etag as string;
      const { status } = await caldavRequest(env, eventUrl, 'DELETE', undefined, headers);
      if (status >= 400 && status !== 404) throw new Error(`DELETE returned ${status}`);
      return { deleted: true, status };
    }

    // ---- search_events ----------------------------------------------------
    case 'search_events': {
      const calUrl = args.calendar_url as string;
      const query = (args.query as string).toLowerCase();
      const start = args.start as string | undefined;
      const end = args.end as string | undefined;
      const events = await fetchEvents(env, calUrl, start, end);
      const matched = events.filter(
        (e) =>
          (e['SUMMARY'] ?? '').toLowerCase().includes(query) ||
          (e['DESCRIPTION'] ?? '').toLowerCase().includes(query) ||
          (e['LOCATION'] ?? '').toLowerCase().includes(query),
      );
      return { events: matched };
    }

    // ---- get_freebusy -----------------------------------------------------
    case 'get_freebusy': {
      const calUrl = args.calendar_url as string;
      const start = args.start as string;
      const end = args.end as string;
      const events = await fetchEvents(env, calUrl, start, end);
      const busy = events.map((e) => ({ start: e['DTSTART'], end: e['DTEND'], summary: e['SUMMARY'] }));
      return { start, end, busy };
    }

    // ---- get_ical_feed ----------------------------------------------------
    case 'get_ical_feed': {
      const calUrl = args.calendar_url as string;
      const events = await fetchEvents(env, calUrl);
      const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//poke-ical//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
      ];
      for (const e of events) {
        lines.push('BEGIN:VEVENT');
        for (const [k, v] of Object.entries(e)) {
          if (!['etag', 'href'].includes(k)) lines.push(`${k}:${v}`);
        }
        lines.push('END:VEVENT');
      }
      lines.push('END:VCALENDAR');
      return { ical: lines.join('\r\n') };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC dispatcher
// ---------------------------------------------------------------------------

async function handleJsonRpc(
  req: JsonRpcRequest,
  env: Env,
): Promise<JsonRpcResponse> {
  const { method, params, id } = req;

  try {
    // MCP lifecycle
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'poke-ical', version: '1.0.0' },
          capabilities: { tools: {} },
        },
      };
    }

    if (method === 'notifications/initialized') {
      // notification — no response needed but we send empty
      return { jsonrpc: '2.0', id: null, result: null };
    }

    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    }

    if (method === 'tools/call') {
      const p = params as { name: string; arguments?: Record<string, unknown> };
      const toolResult = await executeTool(p.name, p.arguments ?? {}, env);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(toolResult, null, 2) }],
        },
      };
    }

    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message },
    };
  }
}

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

function sseEvent(eventType: string, data: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ---------------------------------------------------------------------------
// Cloudflare Worker entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ------------------------------------------------------------------
    // /mcp — MCP over SSE
    // GET  → opens the SSE stream and sends endpoint event
    // POST → accepts JSON-RPC messages, responds via SSE
    // ------------------------------------------------------------------
    if (url.pathname === '/mcp') {
      // ---- POST: JSON-RPC message ----
      if (request.method === 'POST') {
        let body: JsonRpcRequest;
        try {
          body = (await request.json()) as JsonRpcRequest;
        } catch {
          return new Response(
            JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
        }

        const response = await handleJsonRpc(body, env);

        // Return as JSON (for direct HTTP clients) with SSE content-type support
        const acceptHeader = request.headers.get('Accept') ?? '';
        if (acceptHeader.includes('text/event-stream')) {
          const sse = sseEvent('message', response);
          return new Response(sse, {
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Access-Control-Allow-Origin': '*',
            },
          });
        }

        return new Response(JSON.stringify(response), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }

      // ---- GET: open SSE stream ----
      if (request.method === 'GET') {
        // For SSE-based MCP clients that open a long-lived GET stream,
        // we send the endpoint event immediately and then accept POSTs.
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();

        // Send the endpoint event so the client knows where to POST
        const origin = url.origin;
        const endpointEvent = sseEvent('endpoint', { uri: `${origin}/mcp` });
        await writer.write(encoder.encode(endpointEvent));
        // Keep alive
        const keepAlive = setInterval(async () => {
          try {
            await writer.write(encoder.encode(': ping\n\n'));
          } catch {
            clearInterval(keepAlive);
          }
        }, 25000);

        return new Response(readable, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }

      // ---- OPTIONS: CORS preflight ----
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Accept',
          },
        });
      }
    }

    // ------------------------------------------------------------------
    // /health
    // ------------------------------------------------------------------
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not Found', { status: 404 });
  },
};
