# covu-search-platform

A multi-tenant platform for search, answer-engine and paid-media performance.

**This is a separate, in-progress build. It does not touch `covu-seo-dashboard`
or its Vercel project, which keep running unchanged.**

## What makes it a product rather than a dashboard

Every BI tool draws charts. What none of them do is refuse to state what they
cannot source. This platform's differentiator is that its data model knows the
limits of its own data, and every API response carries them:

- Weeks know how many days they actually hold, so a partial week can never be
  charted as a decline.
- Query rows are measured against site totals, so the ~33% that Search Console
  withholds for privacy is stated rather than discovered.
- Page rows are measured the same way, and they *exceed* site totals, because
  one search showing two of your URLs counts once for the site and once per
  page. Both ratios are correct and they contradict each other; a product that
  shows one "total" and lets the user find the mismatch loses their trust.
- Reporting lag is a property of each source, so ad data having days that
  organic does not never reads as an organic collapse.
- A gap in the middle of the record is reported, never interpolated — a paused
  ad campaign and a failed ingest look identical in the data, so a human
  resolves it.

`lib/provenance.js` turns each of these into a structured caveat attached to
every response, instead of prose hand-written into individual panels and
forgotten the next time a panel is added.

## COVU is tenant #1, not the schema

Nothing about COVU is compiled in. The org, its sources, their sheet gids, its
brand terms and each source's reporting lag are all rows. A second customer is
`scripts/seed.js` with different values.

## Layout

| Path | What it does |
|---|---|
| `db/migrations/` | Plain SQL, applied in filename order. No ORM. |
| `lib/db.js` | One interface over two drivers — PGlite locally, Neon in production. |
| `lib/weeks.js` | Week bucketing and completeness. |
| `lib/brand.js` | Branded-query classification from literal terms. |
| `lib/metrics.js` | Read-side aggregation, all in SQL. |
| `lib/provenance.js` | The caveat engine. |
| `lib/ingest.js` | Transactional, idempotent fact writes plus run tracking. |
| `lib/health.js` | Per-source health, derived from the facts. |
| `connectors/sheet.js` | Reads a spreadsheet an external pipeline fills. |
| `scripts/` | migrate, seed, backfill, reconcile, refresh, health, query. |
| `api/health.js` | `GET /api/health` — 200 when current, 503 otherwise. |
| `api/cron/refresh.js` | Scheduled ingest for Vercel Cron. Fails closed without `CRON_SECRET`. |
| `ops/` | launchd agent + installer for a nightly local refresh. |

## Running it

No account, no server, no card. PGlite is Postgres compiled to WebAssembly and
runs from `node_modules` against `.data/`.

```bash
npm install
node scripts/seed.js        # migrate + register org "covu" and its sources
npm run refresh             # migrate, load every source, verify the result
```

`npm run refresh` is the only command needed from then on. It is idempotent, so
running it twice changes nothing.

| Command | What it does |
|---|---|
| `npm run refresh` | The whole cycle. Exits non-zero if anything is wrong. |
| `npm run health` | Per-source freshness. Exits non-zero unless all sources are ok. |
| `npm run reconcile` | Verification alone, against the live source. |
| `npm test` | 30 unit and database tests. |

Point it at a real database by setting `DATABASE_URL`; the same SQL runs
unchanged.

## Automation

`scripts/refresh.js` does three things in order — migrate, load, **verify** —
and exits non-zero if any of them fails. The verification step is what makes it
automation rather than a job that moves bytes: an unattended pipeline that loads
without checking will eventually load something wrong and serve it
confidently.

Exit codes: `0` fine · `1` verification failed · `2` a source failed to load ·
`3` threw.

**Locally, today** — a launchd user agent, no password, no deploy, free:

```bash
./ops/install-schedule.sh          # daily 06:30, logs to ops/refresh.log
./ops/install-schedule.sh --status
./ops/install-schedule.sh --remove
```

**Once deployed** — `vercel.json` declares a daily cron against
`/api/cron/refresh`, which requires `Authorization: Bearer $CRON_SECRET` and
refuses to run at all if that variable is unset. Note that a full four-source
refresh takes tens of seconds and a Hobby-plan function will time out partway;
pass `?source=<id>` to refresh one source per invocation, or run it somewhere
with a longer budget. Timing out is safe — each source is a single transaction —
but the run is left marked `running` rather than `ok`.

## Two bugs the design makes structurally impossible

**Brand terms are literals, never patterns.** A previous build classified
queries with `new RegExp("\bcovu\b")`. Built from a *string*, `\b` is a
backspace character, so the pattern matched nothing, every query was labelled
non-branded, and the dashboard reported non-branded as 100% of clicks against a
true 2%. Terms are stored as literal substrings and escaped before they reach a
regex or a `LIKE`, on both the JS and SQL paths — and `scripts/reconcile.js`
asserts the two agree.

**Average position is stored impression-weighted.** `position_sum` divided by
`impressions` re-aggregates correctly over any range. Storing an average and
averaging the averages is wrong in a direction nobody notices.

## The upstream sheet is a rolling window

`daily_totals` holds a fixed ~480 rows. It is not accumulating history — it
discards its oldest day as it gains a new one. As of 2026-09-08 it began at
2025-05-14, having already dropped 2025-05-01 to 05-13.

Postgres therefore holds search history that no longer exists anywhere else,
which is a better argument for this rewrite than any in the original handoff.
Two consequences the code depends on:

- Facts are **upserted and never deleted**, so aged-out days survive here.
- `scripts/reconcile.js` compares over the window the *source* still covers,
  not everything the database holds. Comparing whole spans would report the
  accumulation as a mismatch, when it is the entire point.

## Snapshot dimensions replace rather than accumulate

Four upstream tabs (`query_page`, `appearance`, `ga_landing`,
`ga_event_landing`) have **no date column**. They are rolling aggregates
re-stated in full on every run, so they are stamped with the day they were read
and given a `*_snapshot` dimension.

Such a dimension is cleared before each write. Upserting one appended a
near-identical copy daily — 17k rows a day for GA4 landing pages alone — and
produced a series that invites reading as a daily trend when each point
actually covers a trailing 90-day window.

## Status

Honest version, because the previous one overstated it.

**Done and tested.** Schema, ingestion, the domain core, health reporting, and
a reconciliation that loads COVU's history and checks it against the source.
Per-account credentials with authenticated encryption, and the constraints that
stop a source existing without one. 40 tests.

**Built but not wired.** Postgres ingestion runs from `scripts/` and the daily
cron, but **`/api/data` still reads the Google Sheet.** Both this branch and
the dashboard on `main` do. Nothing serves from the database yet, so the
database is currently a very well-tested write-only store.

**Not started.** Paid media in `lib/metrics.js` — every metric it exposes is
organic search, so ads can be ingested and then cannot be read back out. Live
API connectors. OAuth connect flows. The account switcher.

## Connecting someone else's accounts

The schema was always multi-tenant; what it lacked was anywhere to put a
credential, because the sheet transport never needed one. Migration 0002 adds
that, and with it the platform's real risk surface — the difference between
holding COVU's data and holding a stranger's.

**A credential is not an account.** One `connection` (a Google MCC, a Meta
business) commonly reaches several ad accounts, and each of those is its own
`source` row pointing back at it. That is why `connection.external_id` is the
login customer or business id, never the ad account id.

**Two tenants may hold the same account.** An agency and its client both
legitimately connect the same ad account. Uniqueness is therefore
`(org_id, provider, external_id)`, not `(provider, external_id)`. There is a
test for this, because it is the sort of constraint that gets tightened by
someone who has not thought about agencies.

**A connection carries its own health.** `status`, `last_error`, `last_ok_at`,
and a partial index over the unhealthy ones. This exists because of a specific
failure: in September 2026 COVU's Meta ad account was restricted for a failed
payment, delivery stopped dead, and it took eight days to notice, because a
pipeline that is broken and a pipeline with nothing to report look identical
from the outside. At one tenant that is embarrassing. At a hundred it is the
product failing silently for people who are paying for it.

**Secrets never touch the database as text.** `lib/crypto.js` seals them with
AES-256-GCM before they get near a column, and the format carries a version
byte so the cipher can change later without guessing from the length. See
`CREDENTIAL_KEY` in the README for key handling — in particular, that the key
and a database dump must not live in the same place, since together they are
the whole secret and separately neither is anything.


## Known characteristics

- A cold first load is ~4 minutes for 244k rows on PGlite, which is
  WebAssembly and fsync-bound. An incremental refresh is **~25 seconds**. A
  hosted Postgres is faster, and `COPY` would cut it further if it matters.
- Alerting has no destination yet. `npm run health` and `GET /api/health` both
  exit/respond non-zero when something is wrong, and `ops/refresh.log` records
  every scheduled run, but nothing yet emails or messages anyone.
