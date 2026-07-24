import { afterEach, describe, expect, it, vi } from 'vitest';

import worker from './worker';

const APP_TOKEN = 'dXNlckBleGFtcGxlLmNvbTphcHAtcGFzc3dvcmQ=';

interface ToolCallResponse {
  result?: {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
    tools?: unknown[];
  };
  error?: { code: number; message: string };
}

function expectedCalendarUrlError(toolName: string): string {
  return (
    `Invalid arguments for ${toolName}: "calendar_url" is required and must be an ` +
    `absolute HTTPS URL. Call list_calendars first, choose the desired calendar, then retry ` +
    `${toolName} using that calendar's "url" value as "calendar_url". Subscribed calendars ` +
    `are read-only; to read one, use list_subscribed_events with "source_url".`
  );
}

async function postJsonRpc(body: unknown, accept = 'application/json'): Promise<Response> {
  return worker.fetch(
    new Request('https://poke-ical.example/mcp', {
      method: 'POST',
      headers: {
        Accept: accept,
        Authorization: `Bearer ${APP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  );
}

async function callTool(
  name: string,
  args?: Record<string, unknown>,
): Promise<{ response: Response; payload: ToolCallResponse }> {
  const params: { name: string; arguments?: Record<string, unknown> } = { name };
  if (args !== undefined) params.arguments = args;

  const response = await postJsonRpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params,
  });
  const payload = (await response.json()) as ToolCallResponse;
  return { response, payload };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('calendar_url validation', () => {
  it.each([
    ['missing arguments', undefined],
    ['null', { calendar_url: null }],
    ['number', { calendar_url: 42 }],
    ['blank', { calendar_url: '   ' }],
    ['relative URL', { calendar_url: '/calendars/work/' }],
    ['plain name', { calendar_url: 'Work' }],
    ['HTTP URL', { calendar_url: 'http://caldav.icloud.com/calendars/work/' }],
    ['webcal URL', { calendar_url: 'webcal://example.com/work.ics' }],
  ])('returns an actionable tool error for %s', async (_label, args) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { response, payload } = await callTool(
      'list_events',
      args as Record<string, unknown> | undefined,
    );

    expect(response.status).toBe(200);
    expect(payload.error).toBeUndefined();
    expect(payload.result).toEqual({
      content: [{ type: 'text', text: expectedCalendarUrlError('list_events') }],
      isError: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it.each([
    ['create_event', { summary: 'Planning', dtstart: '20260725T010000Z', dtend: '20260725T020000Z' }],
    ['search_events', { query: 'Planning' }],
    ['get_freebusy', { start: '20260725T000000Z', end: '20260726T000000Z' }],
    ['get_ical_feed', {}],
  ])('applies the same guard to %s', async (toolName, args) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { payload } = await callTool(toolName, args);

    expect(payload.result).toEqual({
      content: [{ type: 'text', text: expectedCalendarUrlError(toolName) }],
      isError: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('keeps the actionable error visible in SSE responses', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await postJsonRpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_events', arguments: {} },
      },
      'application/json, text/event-stream',
    );
    const body = await response.text();
    const data = /^data: (.+)$/m.exec(body)?.[1];

    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    expect(data).toBeDefined();
    expect(JSON.parse(data ?? '')).toMatchObject({
      result: {
        content: [{ type: 'text', text: expectedCalendarUrlError('list_events') }],
        isError: true,
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('continues with a valid HTTPS calendar URL', async () => {
    const calendarUrl = 'https://caldav.icloud.com/123/calendars/work/';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('<D:multistatus xmlns:D="DAV:" />', {
        status: 207,
        headers: { 'Content-Type': 'application/xml' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { payload } = await callTool('list_events', { calendar_url: calendarUrl });

    expect(payload.error).toBeUndefined();
    expect(payload.result?.isError).toBeUndefined();
    expect(JSON.parse(payload.result?.content[0]?.text ?? '')).toEqual({ events: [] });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      calendarUrl,
      expect.objectContaining({
        method: 'REPORT',
        body: expect.stringContaining('<C:calendar-query'),
      }),
    );
  });

  it('preserves the existing server-error path for network failures', async () => {
    const networkError = new Error('Network connection lost.');
    const fetchMock = vi.fn().mockRejectedValue(networkError);
    vi.stubGlobal('fetch', fetchMock);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { payload } = await callTool('list_events', {
      calendar_url: 'https://caldav.icloud.com/123/calendars/work/',
    });

    expect(payload.result).toBeUndefined();
    expect(payload.error).toEqual({ code: -32000, message: 'Network connection lost.' });
    expect(consoleError).toHaveBeenCalledTimes(2);
  });
});

describe('tool logging', () => {
  it('includes the tool name in the log message', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

    await callTool('list_events', {});

    expect(consoleLog).toHaveBeenCalledWith({
      message: '[poke-ical] MCP tool call: list_events',
      jsonRpcId: 1,
      tool: 'list_events',
      arguments: {},
    });
  });
});

describe('tool metadata', () => {
  it('tells agents how to obtain calendar_url', async () => {
    const response = await postJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    const payload = (await response.json()) as {
      result: {
        tools: Array<{
          name: string;
          inputSchema: {
            properties: Record<string, { description?: string; pattern?: string }>;
          };
        }>;
      };
    };
    const listEvents = payload.result.tools.find((tool) => tool.name === 'list_events');
    const calendarUrl = listEvents?.inputSchema.properties.calendar_url;

    expect(calendarUrl?.pattern).toBe('^https://');
    expect(calendarUrl?.description).toContain('Call list_calendars first');
    expect(calendarUrl?.description).toContain('"url" field');
  });
});
