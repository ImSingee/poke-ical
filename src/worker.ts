export interface Env {
  POKEAPIKEY: string;
  POKECALENDARID: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== '/calendar.ics') {
      return new Response('Not Found', { status: 404 });
    }

    try {
      const events = await fetchPokeEvents(env);
      const ical = buildICal(events);
      return new Response(ical, {
        headers: {
          'Content-Type': 'text/calendar; charset=utf-8',
          'Cache-Control': 'no-cache',
        },
      });
    } catch (err) {
      return new Response('Internal Server Error', { status: 500 });
    }
  },
};

async function fetchPokeEvents(env: Env): Promise<any[]> {
  const res = await fetch(`https://api.poke.com/v1/calendar/${env.POKECALENDARID}/events`, {
    headers: {
      Authorization: `Bearer ${env.POKEAPIKEY}`,
    },
  });
  if (!res.ok) throw new Error(`Poke API error: ${res.status}`);
  const data = await res.json() as { events: any[] };
  return data.events;
}

function buildICal(events: any[]): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ical-poke-bridge//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];

  for (const event of events) {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${event.id}@poke-bridge`);
    lines.push(`SUMMARY:${event.title ?? 'Untitled'}`);
    lines.push(`DTSTART:${toICalDate(event.start)}`);
    lines.push(`DTEND:${toICalDate(event.end)}`);
    if (event.description) lines.push(`DESCRIPTION:${event.description}`);
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

function toICalDate(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
