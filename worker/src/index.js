const ROOMS = [
  { id: 'easley',   email: 'Moterom_Easley@soco.no'   },
  { id: 'hopper',   email: 'Moterom_Hopper@soco.no'   },
  { id: 'torvalds', email: 'Moterom_Torvalds@soco.no' },
  { id: 'turing',   email: 'Moterom_Turing@soco.no'   },
  { id: 'lovelace', email: 'Moterom_Lovelace@soco.no' },
];

const ALLOWED_ORIGIN = 'https://smidigbommen.github.io';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function getAccessToken(env) {
  const cacheKey = 'graph_token';

  const cached = await env.TOKEN_CACHE.get(cacheKey, { type: 'json' });
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }

  const tokenUrl = `https://login.microsoftonline.com/${env.AZURE_TENANT_ID}/oauth2/v2.0/token`;

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     env.AZURE_CLIENT_ID,
      client_secret: env.AZURE_CLIENT_SECRET,
      scope:         'https://graph.microsoft.com/.default',
    }).toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token fetch failed: ${res.status} — ${err}`);
  }

  const data = await res.json();
  const expiresAt = Date.now() + (data.expires_in - 120) * 1000;

  await env.TOKEN_CACHE.put(cacheKey, JSON.stringify({
    token: data.access_token,
    expiresAt,
  }), { expirationTtl: data.expires_in - 120 });

  return data.access_token;
}

async function fetchRoomEvents(token, room, startIso, endIso, dow) {
  const url = new URL(`https://graph.microsoft.com/v1.0/users/${room.email}/calendarView`);
  url.searchParams.set('startDateTime', startIso);
  url.searchParams.set('endDateTime',   endIso);
  url.searchParams.set('$select',       'subject,start,end');
  url.searchParams.set('$top',          '50');

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      Prefer: 'outlook.timezone="UTC"',
    },
  });

  if (!res.ok) {
    console.error(`Graph error for ${room.id}: HTTP ${res.status}`);
    return [];
  }

  const data = await res.json();

  return (data.value || []).map(ev => {
    const s = new Date(ev.start.dateTime + 'Z');
    const e = new Date(ev.end.dateTime   + 'Z');
    const hhmm = d => `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    return {
      room:  room.id,
      day:   dow,
      start: hhmm(s),
      end:   hhmm(e),
      title: ev.subject || '(No title)',
    };
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const dateParam = url.searchParams.get('date');

    let targetDate;
    if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      targetDate = new Date(dateParam + 'T00:00:00Z');
    } else {
      targetDate = new Date();
      targetDate.setUTCHours(0, 0, 0, 0);
    }

    const dow = targetDate.getUTCDay();
    const startIso = targetDate.toISOString().replace(/\.\d+Z$/, '');
    const endDate  = new Date(targetDate);
    endDate.setUTCHours(23, 59, 59, 0);
    const endIso = endDate.toISOString().replace(/\.\d+Z$/, '');

    try {
      const token = await getAccessToken(env);

      const allEvents = await Promise.all(
        ROOMS.map(room => fetchRoomEvents(token, room, startIso, endIso, dow))
      );

      return new Response(JSON.stringify({ ok: true, events: allEvents.flat() }), {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60',
        },
      });
    } catch (err) {
      console.error('Worker error:', err.message);
      return new Response(JSON.stringify({ ok: false, error: err.message }), {
        status: 500,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
  },
};
