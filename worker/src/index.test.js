/**
 * DST / Summer-time tests for the Cloudflare Worker.
 *
 * Oslo timezone:
 *   - Summer (CEST): UTC+2  (last Sun March → last Sun October)
 *   - Winter (CET):  UTC+1
 *
 * The worker requests calendar data from Microsoft Graph and must return times
 * in Oslo local time, not UTC. Without the fix, events are displayed 1–2 hours
 * too early on the calendar.
 *
 * Tests run with TZ=UTC (matching the Cloudflare Workers runtime) so that
 * Date#getHours() reproduces the exact behaviour of the deployed worker.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from './index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOKEN_RESPONSE = { access_token: 'test-token', expires_in: 3600 };

/** Minimal KV mock — always misses so the token endpoint is exercised. */
function makeEnv() {
  return {
    TOKEN_CACHE: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    },
    AZURE_TENANT_ID:     'test-tenant',
    AZURE_CLIENT_ID:     'test-client',
    AZURE_CLIENT_SECRET: 'test-secret',
  };
}

/**
 * Returns a fetch mock that handles:
 *   - Azure AD token endpoint  → TOKEN_RESPONSE
 *   - Graph calendarView for each room in `graphEvents`
 *
 * graphEvents: { [roomEmail]: Array<{ start: { dateTime }, end: { dateTime } }> }
 */
function makeFetch(graphEvents) {
  return vi.fn(async (url) => {
    const ok = { ok: true, status: 200, text: async () => '' };

    if (String(url).includes('login.microsoftonline.com')) {
      return { ...ok, json: async () => TOKEN_RESPONSE };
    }

    for (const [email, events] of Object.entries(graphEvents)) {
      if (String(url).includes(email)) {
        return { ...ok, json: async () => ({ value: events }) };
      }
    }

    // Any room not listed → no events
    return { ...ok, json: async () => ({ value: [] }) };
  });
}

function graphEvent(startUtc, endUtc) {
  return { start: { dateTime: startUtc }, end: { dateTime: endUtc } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Oslo DST — worker must return local Oslo times, not UTC', () => {
  let fetchBackup;

  beforeEach(() => {
    fetchBackup = global.fetch;
  });

  afterEach(() => {
    global.fetch = fetchBackup;
    vi.restoreAllMocks();
  });

  // ── Summer (CEST = UTC+2) ─────────────────────────────────────────────────

  it('SUMMER: meeting at 10:00–11:00 CEST → Graph UTC 08:00–09:00 → returns 10:00–11:00', async () => {
    global.fetch = makeFetch({
      'Moterom_Easley@soco.no': [
        graphEvent('2024-07-15T08:00:00', '2024-07-15T09:00:00'),
      ],
    });

    const res = await worker.fetch(
      new Request('https://worker.dev?date=2024-07-15'),
      makeEnv(),
    );
    const { ok, events } = await res.json();

    expect(ok).toBe(true);
    const ev = events.find(e => e.room === 'easley');
    expect(ev).toBeDefined();
    expect(ev.start).toBe('10:00'); // 08:00 UTC + 2 h (CEST) = 10:00 Oslo
    expect(ev.end).toBe('11:00');
  });

  it('SUMMER: early morning meeting 08:00–09:00 CEST → Graph UTC 06:00–07:00 → returns 08:00–09:00', async () => {
    global.fetch = makeFetch({
      'Moterom_Hopper@soco.no': [
        graphEvent('2024-07-15T06:00:00', '2024-07-15T07:00:00'),
      ],
    });

    const res = await worker.fetch(
      new Request('https://worker.dev?date=2024-07-15'),
      makeEnv(),
    );
    const { events } = await res.json();

    const ev = events.find(e => e.room === 'hopper');
    expect(ev.start).toBe('08:00');
    expect(ev.end).toBe('09:00');
  });

  // ── Winter (CET = UTC+1) ──────────────────────────────────────────────────

  it('WINTER: meeting at 10:00–11:00 CET → Graph UTC 09:00–10:00 → returns 10:00–11:00', async () => {
    global.fetch = makeFetch({
      'Moterom_Easley@soco.no': [
        graphEvent('2024-01-15T09:00:00', '2024-01-15T10:00:00'),
      ],
    });

    const res = await worker.fetch(
      new Request('https://worker.dev?date=2024-01-15'),
      makeEnv(),
    );
    const { events } = await res.json();

    const ev = events.find(e => e.room === 'easley');
    expect(ev.start).toBe('10:00'); // 09:00 UTC + 1 h (CET) = 10:00 Oslo
    expect(ev.end).toBe('11:00');
  });

  it('WINTER: end-of-day meeting 17:00–18:00 CET → Graph UTC 16:00–17:00 → returns 17:00–18:00', async () => {
    global.fetch = makeFetch({
      'Moterom_Torvalds@soco.no': [
        graphEvent('2024-01-15T16:00:00', '2024-01-15T17:00:00'),
      ],
    });

    const res = await worker.fetch(
      new Request('https://worker.dev?date=2024-01-15'),
      makeEnv(),
    );
    const { events } = await res.json();

    const ev = events.find(e => e.room === 'torvalds');
    expect(ev.start).toBe('17:00');
    expect(ev.end).toBe('18:00');
  });

  // ── DST transitions ───────────────────────────────────────────────────────

  it('DST spring-forward (30 Mar 2025): 09:00 Oslo meeting → UTC 07:00 (CEST starts) → returns 09:00', async () => {
    // Clocks jump 02:00 → 03:00 at 01:00 UTC on 30 March 2025.
    // After the jump Oslo is CEST (UTC+2), so 09:00 CEST = 07:00 UTC.
    global.fetch = makeFetch({
      'Moterom_Turing@soco.no': [
        graphEvent('2025-03-30T07:00:00', '2025-03-30T08:00:00'),
      ],
    });

    const res = await worker.fetch(
      new Request('https://worker.dev?date=2025-03-30'),
      makeEnv(),
    );
    const { events } = await res.json();

    const ev = events.find(e => e.room === 'turing');
    expect(ev.start).toBe('09:00');
    expect(ev.end).toBe('10:00');
  });

  it('DST fall-back (26 Oct 2025): 14:00 Oslo meeting after fallback → UTC 13:00 (CET) → returns 14:00', async () => {
    // Clocks fall 03:00 → 02:00 at 01:00 UTC on 26 October 2025.
    // After the fallback Oslo is CET (UTC+1), so 14:00 CET = 13:00 UTC.
    global.fetch = makeFetch({
      'Moterom_Lovelace@soco.no': [
        graphEvent('2025-10-26T13:00:00', '2025-10-26T14:00:00'),
      ],
    });

    const res = await worker.fetch(
      new Request('https://worker.dev?date=2025-10-26'),
      makeEnv(),
    );
    const { events } = await res.json();

    const ev = events.find(e => e.room === 'lovelace');
    expect(ev.start).toBe('14:00');
    expect(ev.end).toBe('15:00');
  });

  // ── All rooms, summer ─────────────────────────────────────────────────────

  it('SUMMER: all 5 rooms return correct Oslo times (not UTC)', async () => {
    // 08:00 UTC = 10:00 CEST
    const evt = graphEvent('2024-07-15T08:00:00', '2024-07-15T08:30:00');
    global.fetch = makeFetch({
      'Moterom_Easley@soco.no':   [evt],
      'Moterom_Hopper@soco.no':   [evt],
      'Moterom_Torvalds@soco.no': [evt],
      'Moterom_Turing@soco.no':   [evt],
      'Moterom_Lovelace@soco.no': [evt],
    });

    const res = await worker.fetch(
      new Request('https://worker.dev?date=2024-07-15'),
      makeEnv(),
    );
    const { ok, events } = await res.json();
    expect(ok).toBe(true);

    for (const roomId of ['easley', 'hopper', 'torvalds', 'turing', 'lovelace']) {
      const ev = events.find(e => e.room === roomId);
      expect(ev, `${roomId} should have an event`).toBeDefined();
      expect(ev.start, `${roomId} start`).toBe('10:00'); // Oslo CEST
      expect(ev.end,   `${roomId} end`).toBe('10:30');
    }
  });
});
