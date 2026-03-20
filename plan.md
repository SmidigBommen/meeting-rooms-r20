# Migration Plan: Cloudflare Workers Backend

## Overview

Replace the manual Bearer token UI with a Cloudflare Worker that holds Azure AD secrets,
fetches tokens automatically, and exposes a clean `/api/events` endpoint the browser polls.

---

## Folder Structure

```
meeting-room-visualizer/
├── index.html                  ← MODIFY (remove token UI, poll Worker)
└── worker/
    ├── wrangler.toml           ← CREATE (Worker config + KV binding)
    ├── package.json            ← CREATE (Wrangler dev dependency)
    └── src/
        └── index.js            ← CREATE (all backend logic)
```

---

## Phase A — Azure AD (manual, one-time)

1. Azure Portal → Azure Active Directory → App registrations → New registration
2. Name it `meeting-room-visualizer-worker`, single-tenant, no redirect URI
3. Note down: **Application (client) ID** and **Directory (tenant) ID**
4. Certificates & secrets → New client secret → copy the value immediately (shown once)
5. API permissions → Add → Microsoft Graph → **Application permissions** → `Calendars.Read`
6. **"Grant admin consent"** — a Global Admin must click this, otherwise you'll get 403s

> Application permissions (not delegated) are required because the Worker runs with no user session.

---

## Phase B — Cloudflare Setup (manual, one-time)

```bash
npm install -g wrangler
npx wrangler login                                    # opens browser to authenticate
npx wrangler kv namespace create TOKEN_CACHE          # for caching Graph tokens
npx wrangler kv namespace create TOKEN_CACHE --preview
npx wrangler secret put AZURE_CLIENT_SECRET           # paste secret interactively — never stored in files
```

Fill the KV namespace IDs into `wrangler.toml` after the above commands output them.

---

## Phase C — Files to Create

### `worker/wrangler.toml`

```toml
name = "meeting-room-worker"
main = "src/index.js"
compatibility_date = "2024-01-01"

[vars]
AZURE_TENANT_ID = "your-tenant-id"
AZURE_CLIENT_ID = "your-client-id"

[[kv_namespaces]]
binding = "TOKEN_CACHE"
id = "FILL_AFTER_KV_CREATE"
preview_id = "FILL_AFTER_KV_CREATE"
```

### `worker/src/index.js`

Handles:
- CORS preflight
- Token acquisition via client credentials flow, cached in KV (tokens valid 1hr, refreshed automatically)
- Parallel `calendarView` fetch for all 5 rooms
- Accepts `?date=YYYY-MM-DD` query param, defaults to today
- Returns clean JSON: `{ ok: true, events: [...] }`

---

## Phase D — index.html Changes

1. **Remove** the entire `connect-bar` div and its CSS (the token paste UI)
2. **Add** `const WORKER_URL = 'https://meeting-room-worker.YOUR_SUBDOMAIN.workers.dev'`
3. **Replace** `fetchLiveData()` to poll `${WORKER_URL}?date=YYYY-MM-DD` instead of Graph directly
4. **Remove** `bearerToken`, `localStorage`, `connectWithToken()`, `disconnect()`, and their event listeners
5. **Fix** day navigation to re-poll Worker with correct `?date=` when user browses to a different day

---

## Phase E — Deployment

```bash
cd worker/
npm install
npx wrangler deploy
# → outputs: https://meeting-room-worker.YOUR_SUBDOMAIN.workers.dev
```

Update `WORKER_URL` in `index.html`, push to GitHub Pages.

For local dev: `npx wrangler dev` (runs on `localhost:8787`) with a `.dev.vars` file
holding `AZURE_CLIENT_SECRET=...`.

---

## Gotchas

| Issue | Resolution |
|---|---|
| **CORS** | Worker must return `Access-Control-Allow-Origin` on all responses including errors; lock down to your GitHub Pages origin in production |
| **Timezone** | Add `Prefer: outlook.timezone="UTC"` header to Graph calls so times are always UTC — avoids off-by-one-hour bugs |
| **Day navigation** | Currently only fetches today; needs to re-poll Worker when user navigates days |
| **KV eventual consistency** | Two Worker instances may briefly both refresh a token simultaneously — harmless, Azure accepts multiple valid tokens |
| **Secrets in repo** | `AZURE_CLIENT_SECRET` never touches any file — only injected via `wrangler secret put` |

---

## What You Do Manually vs What Code Handles

| You | Code |
|---|---|
| Azure app registration + admin consent | Fetch OAuth tokens (auto-refreshed via KV) |
| `wrangler login` + KV namespace creation | Call Graph API for all rooms in parallel |
| `wrangler secret put AZURE_CLIENT_SECRET` | Return clean JSON to browser |
| Fill IDs into `wrangler.toml` + `index.html` | Poll Worker every 60s |
| `wrangler deploy` | Render calendar |
| Enable GitHub Pages | — |
