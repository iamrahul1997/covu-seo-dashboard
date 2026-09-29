-- 0002_connections_and_paid — per-account credentials, and the paid-media
-- columns the fact table was missing.
--
-- 0001 made tenancy structural but assumed every source arrived through a
-- spreadsheet somebody else filled. That is why there is nowhere to put a
-- credential: the sheet connector never needed one. Serving any account but
-- our own means holding that account's tokens, which is the whole of this
-- migration's risk surface.
--
-- Design rules, in the same spirit as 0001:
--
--   1. A secret is never stored as text. `secret_enc` is AES-256-GCM
--      ciphertext produced by lib/crypto.js, and the column is bytea so no
--      accidental `select *` in a log renders a usable token. `key_version`
--      exists so a key can be rotated without a migration.
--   2. A connection carries its own health. Meta's ad account restriction in
--      September 2026 took eight days to notice because a broken pipeline and
--      an idle one looked identical from the outside. `status`, `last_error`
--      and `last_ok_at` make "this has been failing since Tuesday" a query
--      rather than an archaeology exercise.
--   3. An API source cannot exist without a credential. The check constraint
--      below makes the half-configured state — a source that will fail on
--      every run because nothing can authenticate it — unrepresentable.
--   4. Creative metadata is not a fact. Thumbnails do not aggregate over a
--      date range, and Meta signs its image URLs with an expiry, so they are
--      stored as current attributes with a fetch stamp and refreshed, never
--      accumulated per day.

create table connection (
  id           bigserial   primary key,
  org_id       bigint      not null references org(id) on delete cascade,
  provider     text        not null check (provider in ('google', 'meta')),

  -- Whose credential this is, in the provider's own terms: a Google login
  -- customer id (the MCC the token acts through) or a Meta business id. It is
  -- deliberately NOT the ad account id — one credential commonly reaches
  -- several ad accounts, and each of those becomes its own source row.
  external_id  text        not null,
  label        text        not null,

  secret_enc   bytea       not null,
  key_version  int         not null default 1,
  scopes       text[]      not null default '{}',

  -- Set when the provider tells us the grant ends. A refresh token that does
  -- not expire stays null rather than being given a fictional far-future date.
  expires_at   timestamptz,

  status       text        not null default 'ok'
                 check (status in ('ok', 'expired', 'revoked', 'error')),
  last_error   text,
  last_ok_at   timestamptz,

  created_at   timestamptz not null default now(),
  unique (org_id, provider, external_id)
);

alter table source
  add column connection_id bigint references connection(id) on delete restrict;

-- Rule 3. A sheet-fed source has no credential and must not be forced to
-- invent one; an API-fed source without a credential is a configuration bug
-- that would otherwise only surface as a 401 at 05:19 the next morning.
alter table source
  add constraint source_api_needs_connection
  check (transport <> 'api' or connection_id is not null);

-- Meta counts a link click and a click on the ad as different things, and
-- reports both. Folding them together overstates traffic and understates cost
-- per click; keeping them apart is what makes the two comparable to Google's.
alter table fact_daily add column link_clicks bigint;

create table asset (
  source_id    bigint      not null references source(id) on delete cascade,
  kind         text        not null check (kind in ('creative', 'campaign', 'adset')),
  external_id  text        not null,
  attrs        jsonb       not null default '{}'::jsonb,

  -- Meta's image_url and thumbnail_url carry a signature with an expiry, so a
  -- stored URL rots. This records when it was last known good; the connector
  -- re-fetches rather than serving a link that will 403 in a fortnight.
  fetched_at   timestamptz not null default now(),
  primary key (source_id, kind, external_id)
);

create index connection_unhealthy on connection (org_id, status)
  where status <> 'ok';

-- `transport` defaulted to 'api', which the constraint above turns into a trap:
-- the shortest possible insert now fails, and the fix is non-obvious. Rather
-- than weaken the constraint or default to the legacy path — wrong for a
-- product where most sources will be API-fed — require the decision. There is
-- no sensible default for "where does this data come from".
alter table source alter column transport drop default;
