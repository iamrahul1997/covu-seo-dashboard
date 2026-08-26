# Handoff — COVU search & paid performance system

Written 2026-08-26 for a fresh session or a new developer picking this up, and
specifically for the question *"what would it take to make this a product?"*

Read this first, then `README.md` for operational detail and `pipeline/README.md`
for the ads fetchers.

---

## 1. What exists today

A single-page dashboard at **https://covu-seo-dashboard.vercel.app**, behind
Google sign-in restricted to `@covu.com`. It answers: how is COVU found in
search, how is that changing, and what does it cost.

```
PRODUCERS                                    STORE            READER

Nightly Apps Script (pre-existing, ~01:13 UTC)
  ├─ GSC  sc-domain:covu.com       ─┐
  ├─ GSC  sc-domain:blog.covu.com  ─┤
  ├─ GA4  property 271671175       ─┤
  └─ meta (last_run, lag, props)   ─┤
                                    ├──►  "GSC Data"  ──CSV──►  /api/data
Google Ads Script "pipeline"       ─┤     Google Sheet          (Vercel, Node)
  └─ ads_google_daily/keyword      ─┤     21 tabs                    │
                                    │                                ▼
Meta Apps Script (written, not      ┘                          middleware.js
  installed) ads_meta_daily/ad                                  Google OAuth
                                                                     │
                                                                     ▼
                                                          6 tabs, client-rendered
```

**The rule the whole design follows:** credentials live with the *producer*,
never the reader. Google Ads auth stays in the Ads console; Meta's token stays in
Apps Script properties; GSC and GA4 stay in the nightly pipeline. The dashboard
holds only what it needs to authenticate *people* — plus HubSpot, the one live
call, and therefore the one exception.

### Key IDs

| Thing | Value |
|---|---|
| Sheet | `1IuI7NqgsrourIz1BeH44zx_Wp5_xSaGffkxYS1eYXXc` ("GSC Data") |
| Repo | `rahulpoudel-wq/covu-seo-dashboard` (private) |
| Vercel project | `covu-seo-dashboard`, personal **Covu** hobby scope `team_ETsiCzyeDBgfHPmzjLIVub0V` |
| GSC properties | `sc-domain:covu.com`, `sc-domain:blog.covu.com` |
| GA4 property | `271671175` |
| Google Ads | account `351-420-0735`, one campaign `Covu - Brand - Rah` |
| Meta Ads | `act_4460021897602415` (COVU Ads, COVU Inc. portfolio) |

**Never deploy anything into the Vercel `covu-team` scope** — that is production
www.covu.com and explicitly off limits. Also: Vercel's GitHub connection only
sees the **`rahulpoudel-wq`** account. A repo created under `iamrahul1997` returns
`repo_not_found` from the Vercel API; that cost an hour.

### Env vars (Vercel, Production only)

`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `HUBSPOT_TOKEN`.
Optional: `ALLOWED_DOMAIN` (default `covu.com`), `ALLOWED_EMAILS`,
`PUBLIC_ORIGIN`, `SHEET_ID`.

Auth is all-or-nothing by design: none of the three OAuth vars → public with a
warning chip; all three → protected; some → fails closed.

---

## 2. Domain knowledge worth more than the code

Any rebuild that ignores these will produce confidently wrong numbers. Every one
was found the hard way here.

**Search Console lags ~3 days.** The newest week is always partial. The original
build charted a 4-day week beside 7-day weeks and reported a decline that did not
exist — it inflated a real −20% into −24%. The API counts days per week and
publishes `meta.lastCompleteWeek`; ranges default to it, partial weeks draw
hollow, and extending into one raises a banner.

**Dimensions do not reconcile, in opposite directions.** Query-level rows sum to
*less* than site totals (~65%) because GSC withholds rare queries for privacy.
Page-level rows sum to *more* (245% of impressions) because one query showing two
of your URLs is one impression for the property but one for each page. Both are
correct. A dashboard that shows a single "total" and lets users find the mismatch
themselves loses their trust permanently.

**A domain property spans every subdomain.** `sc-domain:covu.com` includes
`news.`, `blog.`, `podcast.`, `go.`, `my.`, and — currently — `stg.ap.` and
`try.`. `news.covu.com` alone takes 13% of all impressions and returns 0.1% CTR.
Aggregate without splitting by host and that stays invisible.

**Brand classification is the highest-leverage line of code.** The original used
`new RegExp("\bcovu\b")` — built from a *string*, so `\b` became a backspace
character and matched nothing. Every query was labelled non-branded; the Overview
claimed non-branded was 100% of clicks when the truth was ~2%. Use a regex
literal. Current rule: `/covu|co\.vu|co vu/i`. Misspellings (`covou`, `covo`,
`covve`) are deliberately excluded — `covve` is a different company.

**Google Sheets `gviz` silently destroys mixed-type columns.** `/gviz/tq` coerces
each column to one type and blanks every cell that disagrees; on the `meta` tab it
returned nothing at all and merged the first two rows into a header. Always use
`/export?format=csv&gid=…`. Regenerate the gid map with:

```bash
curl -sL "https://docs.google.com/spreadsheets/d/<ID>/htmlview" \
  | grep -oE 'name: "[^"]+".{0,200}?gid: "[0-9]+"'
```

**Ads data has no reporting lag; organic does.** Ads rows exist for days the
organic window has not reached. Keep weeks organic-aligned so the two stay
comparable, and say the recent days are held back — otherwise it reads as a drop.

**GA4 has an "AI Assistant" channel.** That is the only first-party answer-engine
signal available anywhere in this stack. Everything else on the AEO tab is a
Search Console proxy. Do not let a rebuild imply otherwise.

**HubSpot's analytics API needs `traffic-analytics-api-access` or
`cms-analytics-api-access`.** Not `business-intelligence`, which is the obvious
guess and returns 403.

---

## 3. What is unfinished

| Item | State |
|---|---|
| Google Ads script schedule | Script saved and enabled; **Frequency not set** |
| HubSpot | Token set, returns 403 — needs the scope above |
| Meta Ads | Both scripts written, never run. No gids, so `TABS` has no entry |
| Preview environments | Env vars are Production-only, so previews show the half-configured page |
| Sheet access | Readable by **anyone with the link** — the dashboard is locked, the data is not |
| HubSpot token | Was pasted into a file and a chat transcript; should be rotated |
| `meta` tab counters | `queries_rows` reads `2217-09-09` — integers written into date-formatted cells. Upstream pipeline bug, cosmetic |

---

## 4. If you are building the product version

Be clear-eyed about what the current design is: **a very good single-tenant
reporting page.** It is deliberately simple — no database, no build step, no
framework, ~1,000 lines of readable JS. That simplicity is why it was rebuilt in
a day after the original was lost. It is not a product architecture.

### What breaks first, in order

1. **Google Sheets as the datastore.** Fine at 21 tabs and ~14MB. It has no
   incremental reads, no joins, no indexes, a 10M-cell ceiling, and its sharing
   model is a single link. The moment you have a second customer or two years of
   ad-level data, it is over.
2. **One payload holding everything.** `/api/data` ships ~1.3MB covering every
   tab, every week, every query. Elegant for one property — it makes tab switches
   and range changes instant with zero further requests. It scales linearly with
   properties × history and cannot be paginated.
3. **All computation client-side.** Aggregation runs in the browser on every
   render. Fine at 47k rows; it will not survive 10×.
4. **Auth has no model.** One domain, no orgs, no roles, no per-property access.
   Everyone who signs in sees everything.
5. **No test coverage of the rendering.** `scripts/check.js` validates the data
   pipeline and `scripts/auth-check.js` covers auth thoroughly, but every UI bug
   found here was found by a human looking at the screen.

### What I would build instead

- **Postgres** (Neon or Supabase on Vercel) with a proper schema:
  `property`, `date`, `dimension`, `dimension_value`, `metrics`. Upsert on
  `(property, date, dimension, value)` — the same idempotency the current scripts
  achieve by rewriting a trailing window.
- **Connectors, not scripts.** One interface per source (GSC, GA4, Google Ads,
  Meta, HubSpot) with `fetch(range)`, `backfill()`, retry, and a recorded run
  status. The health line currently logged to Vercel becomes a table you can
  alert on.
- **Scheduled ingestion** via Vercel Cron, not a mix of Ads Scripts and Apps
  Script triggers living in three separate consoles.
- **Query-per-view APIs.** `/api/overview?range=13w`, `/api/queries?filter=brand`
  — return what the view needs, aggregate in SQL.
- **Orgs and roles** on top of the existing Google OAuth. The session cookie and
  middleware pattern here is sound and worth keeping; it just needs a user table
  behind it.
- **Keep** the hand-rolled SVG charts, the no-build-step frontend, and the
  unminified source. None of those were the bottleneck, and the last rebuild
  happened *because* the previous version was minified with no source anywhere.

### What actually makes it a product

Not the charts. Every BI tool has charts. The differentiator is the part in
section 2: **a system that refuses to state what it cannot source.** Panels here
say "not enough history", "no prior window", "these will not reconcile and here
is why", and flag partial weeks rather than quietly averaging them in. Generic
tools point at a spreadsheet and let the user discover the traps.

Carry that principle into the product and it has a reason to exist. Drop it and
it is another dashboard.

### Two hard-won operational rules

- **Never minify the frontend without keeping source.** This entire project
  exists because the original was a minified Vercel deployment with no repo. Two
  real bugs sat live and unfixable.
- **Deploy from git, never by uploading files.** Hand-assembling file lists for
  `deploy_to_vercel` dropped files twice — once `public/app.js`, once all of
  `public/`. `git push` has been correct every time since.
