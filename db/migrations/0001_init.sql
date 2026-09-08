-- 0001_init — orgs, sources, facts, ingest health.
--
-- Design rules this schema is built to enforce, rather than leave to callers:
--
--   1. Every row belongs to an org. There is no path to a fact that does not
--      pass through source.org_id. Tenancy is never retrofitted.
--   2. Reporting lag is a property of the source, not a constant. Search
--      Console runs ~3 days behind; ad platforms run at zero. Storing it per
--      source is what lets one completeness rule serve both.
--   3. Brand terms are stored as literal strings, never as a regex. A previous
--      build stored a pattern as a string, so "\b" became a backspace
--      character and classified every query as non-branded. Literals cannot
--      fail that way; lib/brand.js escapes them when it compiles the matcher.
--   4. Facts are upserted on their natural key, so re-running any connector
--      over any window is idempotent by construction rather than by care.

create table org (
  id          bigserial primary key,
  slug        text        not null unique,
  name        text        not null,
  created_at  timestamptz not null default now()
);

create table member (
  org_id      bigint      not null references org(id) on delete cascade,
  email       text        not null,
  role        text        not null check (role in ('owner', 'admin', 'viewer')),
  created_at  timestamptz not null default now(),
  primary key (org_id, email)
);

-- A connected data origin: one Search Console property, one GA4 property, one
-- ad account. `config` carries whatever that connector needs (sheet gids while
-- a source is still fed by the legacy pipeline, currency, a property mapping)
-- so that adding a connector never requires a migration.
--
-- `transport` records HOW the facts arrive, which is deliberately separate
-- from WHAT they are: a Search Console source is `kind='gsc'` whether its rows
-- come from the API directly or from a spreadsheet an Apps Script fills.
create table source (
  id           bigserial   primary key,
  org_id       bigint      not null references org(id) on delete cascade,
  kind         text        not null check (kind in
                 ('gsc', 'ga4', 'google_ads', 'meta_ads', 'hubspot')),
  transport    text        not null default 'api' check (transport in ('api', 'sheet')),
  external_id  text        not null,
  label        text        not null,
  config       jsonb       not null default '{}'::jsonb,
  -- Days this source runs behind. Drives week completeness and the "held back"
  -- caveat. 0 for ad platforms, ~3 for Search Console.
  lag_days     int         not null default 0 check (lag_days >= 0),
  enabled      boolean     not null default true,
  created_at   timestamptz not null default now(),
  unique (org_id, kind, external_id)
);

-- One fact table. Metric columns are the union across sources and are nullable
-- — a Search Console row leaves the paid columns null and vice versa. Typed
-- columns rather than jsonb so that aggregation is plain SQL in the hot path.
--
-- `dim` names the breakdown; `a` and `b` hold its values. Two value columns
-- cover every pair the sources produce (query->page, campaign->adset,
-- landing->event) without a second table. `dim='total'` is the ungrouped daily
-- row and carries empty strings, never nulls, so the primary key stays usable.
--
-- position_sum is impression-weighted and must be divided by impressions to
-- read as an average. Storing the weighted sum is what makes the metric
-- correctly re-aggregable over any date range; storing an average would not be.
--
-- Money is integer cents and conversions are hundredths, because summing
-- floats across a quarter of daily rows accumulates visible error.
create table fact_daily (
  source_id               bigint not null references source(id) on delete cascade,
  day                     date   not null,
  dim                     text   not null,
  a                       text   not null default '',
  b                       text   not null default '',

  clicks                  bigint,
  impressions             bigint,
  position_sum            double precision,

  sessions                bigint,
  engaged_sessions        bigint,
  users                   bigint,
  events                  bigint,

  cost_cents              bigint,
  conversions_x100        bigint,
  conversion_value_cents  bigint,

  views                   bigint,
  submissions             bigint,
  contacts                bigint,

  primary key (source_id, day, dim, a, b)
);

-- The primary key leads with `day`, which suits point lookups but not the
-- access pattern every panel actually uses: one dimension over a date range.
create index fact_daily_scan on fact_daily (source_id, dim, day);

-- Ingest health as a table rather than a log line. The current system prints
-- its outcome to Vercel's runtime logs, where nothing can alert on it.
create table ingest_run (
  id            bigserial   primary key,
  source_id     bigint      not null references source(id) on delete cascade,
  connector     text        not null,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text        not null default 'running'
                  check (status in ('running', 'ok', 'partial', 'error')),
  window_start  date,
  window_end    date,
  rows_written  bigint      not null default 0,
  error         text,
  notes         jsonb       not null default '{}'::jsonb
);

create index ingest_run_recent on ingest_run (source_id, started_at desc);

-- Literal, case-insensitive substrings that mark a query as branded.
-- Deliberately not a regex. See rule 3 above.
create table brand_term (
  org_id      bigint      not null references org(id) on delete cascade,
  term        text        not null,
  created_at  timestamptz not null default now(),
  primary key (org_id, term)
);
