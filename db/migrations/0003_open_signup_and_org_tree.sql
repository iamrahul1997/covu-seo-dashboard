-- 0003_open_signup_and_org_tree — anyone may sign in; what they see is decided
-- by membership, not by the domain of their email address.
--
-- Until now the product had one tenant and authentication doubled as
-- authorisation: holding a @covu.com address was the same thing as being
-- allowed to see COVU's numbers. That conflation is safe with exactly one
-- customer and unsafe with two, so it is being separated here.
--
--   Authentication  — who you are.    Open to any verified Google account.
--   Authorisation   — what you see.   The `member` table, and nothing else.
--
-- A signed-in stranger is therefore a perfectly normal state: an account with
-- no memberships, which can see the product and none of anyone's data.
--
--   1. `org.parent_id` exists now rather than later. An agency holding client
--      orgs wants roll-up across them, and retrofitting hierarchy means
--      rewriting every org-scoped query from `org_id = $1` to "this org and
--      its descendants". Adding the column early costs nothing; adding it late
--      costs an audit of every read path.
--   2. A pending member is a real row. Inviting someone before their first
--      sign-in is normal, so membership is keyed on the email rather than on a
--      user id that does not exist yet.

alter table org add column parent_id bigint references org(id) on delete restrict;

-- An org cannot be its own parent. This does not prevent a longer cycle
-- (A -> B -> A), which needs a recursive check; it catches the overwhelmingly
-- common mistake cheaply, and the roll-up query will use a depth limit.
alter table org add constraint org_not_own_parent check (parent_id is null or parent_id <> id);

create index org_children on org (parent_id) where parent_id is not null;

-- Who bootstrapped this org, kept for support questions: "why can this person
-- see everything?" has an answer that is not folklore.
alter table org add column created_by text;

-- Sign-in is open, so most people arriving have no org at all. Record them, so
-- an invitation can be matched to a real account and so "who has signed in and
-- is stuck outside" is a query rather than a guess.
create table app_user (
  email        text        primary key,
  name         text        not null default '',
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now()
);
