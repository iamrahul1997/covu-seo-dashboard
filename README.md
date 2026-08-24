# COVU SEO & AEO Dashboard

Live at **https://covu-seo-dashboard.vercel.app** (Vercel project `covu-seo-dashboard`,
personal "Covu" scope — *not* the `covu-team` scope).

Reads the **GSC Data** Google Sheet, which a nightly pipeline fills from Google
Search Console and GA4, and renders search, blog and answer-engine performance.

## Why this repo exists

The original dashboard existed only as a deployed Vercel build — no repository,
no local copy, and Vercel does not return function source. Two real bugs were
found in it that could not be fixed in place, so the whole thing was rebuilt on
2026-08-24 and committed here. The frontend was recovered verbatim from the
deployment; `api/data.js` was written from scratch against the sheet.

Do not minify `public/app.js`. Losing readable source is what caused the rebuild.

## Layout

| Path | What it does |
|---|---|
| `api/data.js` | Serverless function. Reads 18 sheet tabs, returns one JSON payload (~1.3MB). |
| `public/index.html` | Shell, styles, empty panels. |
| `public/app.js` | All rendering. Plain ES5-ish browser JS, no build step. |
| `scripts/check.js` | Builds the payload against the live sheet and asserts its invariants. |
| `scripts/serve.js` | Local dev server that mimics Vercel routing. |

## Running locally

```bash
node scripts/serve.js     # http://localhost:3210
npm run check             # validate the data pipeline
```

`npm run check` is the fast way to tell whether a problem is in the sheet or in
the dashboard. It reports payload size, index integrity, the partial-week
calculation, the brand split and which data sources are populated.

## The two bugs this replaced

**Brand classification matched nothing.** The old build used
`new RegExp("\bcovu\b")` — built from a *string*, so `\b` became a literal
backspace character rather than a word boundary. Every query fell through to
"non-branded" and the Overview claimed non-branded was 100% of clicks when the
true figure was about 2%. Fixed by using a regex literal (`BRAND` in
`public/app.js`).

**The newest week was shown as if complete.** Search Console lags ~3 days, so the
most recent week always holds 4–5 days. The old build charted it beside full
weeks and let ranges end on it, manufacturing a decline, while the header claimed
data through a date the sheet did not have. `api/data.js` now counts the days
present in every week and publishes `meta.lastCompleteWeek`; ranges default to
it, partial weeks render as hollow dots, and extending a range into one raises a
warning banner.

## Data sources

All from the sheet, fetched as CSV via `/export?format=csv&gid=…`.

- **Search Console (covu.com)** — `daily_totals`, `queries`, `pages`,
  `query_page`, `device`, `country`, `appearance`
- **Search Console (blog.covu.com)** — the `blog_*` tabs
- **GA4** — `ga_daily` (includes the **AI Assistant** channel, the only
  first-party answer-engine signal available), `ga_events`, `ga_landing`,
  `ga_event_landing`
- **`meta`** — pipeline run time, lag, property names

Tabs are fetched by **gid**, not name, because `/gviz/tq` coerces every column to
a single type and silently blanks disagreeing cells — which wiped out the whole
`meta` tab. The gid map is at the top of `api/data.js` with instructions for
regenerating it.

## HubSpot (optional)

The AEO tab has a conversions panel that stays dark until a token is present.
To enable it, create a HubSpot private app with the content-analytics read scope
and add its token as `HUBSPOT_TOKEN` in the Vercel project's environment
variables. No code change needed. Without it the dashboard renders normally and
the panel explains it is not connected.

Note that HubSpot supplies *engagement and conversion* data (views, form
submissions, contacts). It does **not** provide an AI-referral breakdown — that
comes from GA4's AI Assistant channel.

## Caching

`/api/data` holds the payload in module scope for 30 minutes and sets
`s-maxage=1800, stale-while-revalidate=86400`, so the CDN absorbs repeat views.
Append `?fresh=1` to bypass both. A cold build reads ~14MB of CSV and takes ~6s.

## A note on sheet access

The sheet is readable by anyone with the link — that is how this function reads
it without credentials. It also means anyone with the URL can pull COVU's full
Search Console history. If that is not intended, tightening it will require
giving the function a service account instead.
