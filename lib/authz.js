// Authorisation: what a signed-in person is allowed to see.
//
// Deliberately separate from lib/session.js, which answers only "is this
// cookie genuine". That split is not stylistic:
//
//   middleware.js runs at the edge, on every request, and must stay fast and
//   dependency-free. It verifies the signature and nothing more.
//
//   These functions hit Postgres and therefore run inside Node API routes,
//   once, on the handful of requests that actually read data.
//
// The rule the product depends on: **a valid session grants nothing**. It
// establishes an identity. Every read of anybody's data goes through a
// membership check here. Before open sign-up this distinction did not exist,
// because holding a @covu.com address was the same thing as being entitled to
// COVU's numbers. With open sign-up that conflation would hand the dashboard
// to any Google account on earth.

import { query, rows, one } from './db.js';

/** How deep an org tree may go. Guards against a cycle the CHECK cannot catch. */
const MAX_DEPTH = 10;

/**
 * Record that someone signed in.
 *
 * Most people arriving at an open product have no org. Writing them down means
 * an invitation can be matched to a real account, and that "who is stuck
 * outside" is answerable without reading logs.
 */
export async function recordSignIn(email, name = '') {
  await query(
    `insert into app_user (email, name)
     values ($1, $2)
     on conflict (email) do update
       set last_seen = now(),
           name = case when excluded.name <> '' then excluded.name else app_user.name end`,
    [String(email).toLowerCase(), String(name || '')],
  );
}

/** Every org this email belongs to directly, with its role. */
export async function membershipsFor(email) {
  return rows(
    `select o.id, o.slug, o.name, o.parent_id, m.role
       from member m
       join org o on o.id = m.org_id
      where m.email = $1
      order by o.name`,
    [String(email).toLowerCase()],
  );
}

/**
 * This org and every org beneath it.
 *
 * An agency that is a member of the parent should see its clients' data
 * without twenty separate membership rows. Depth-limited, because a cycle
 * introduced by a bad parent_id would otherwise spin forever — the CHECK
 * constraint only catches an org parenting itself directly.
 */
export async function orgAndDescendants(orgId) {
  return rows(
    `with recursive tree (id, depth) as (
       select id, 0 from org where id = $1
       union all
       select o.id, t.depth + 1
         from org o join tree t on o.parent_id = t.id
        where t.depth < $2
     )
     select id from tree`,
    [orgId, MAX_DEPTH],
  );
}

/**
 * The role this email holds over this org, directly or by inheritance from an
 * ancestor, or null if none.
 *
 * Returning the role rather than a boolean means the caller can distinguish
 * viewer from owner without a second round trip.
 */
export async function roleFor(email, orgId) {
  const direct = await one(
    `select role from member where email = $1 and org_id = $2`,
    [String(email).toLowerCase(), orgId],
  );
  if (direct) return direct.role;

  // Inherited: a member of any ancestor governs this org too.
  const up = await one(
    `with recursive up (id, parent_id, depth) as (
       select id, parent_id, 0 from org where id = $2
       union all
       select o.id, o.parent_id, u.depth + 1
         from org o join up u on o.id = u.parent_id
        where u.depth < $3
     )
     select m.role
       from up
       join member m on m.org_id = up.id
      where m.email = $1
      order by up.depth
      limit 1`,
    [String(email).toLowerCase(), orgId, MAX_DEPTH],
  );
  return up ? up.role : null;
}

/** True when this email may read this org at all. */
export async function canRead(email, orgId) {
  return (await roleFor(email, orgId)) !== null;
}

/** True when this email may change this org's configuration. */
export async function canAdmin(email, orgId) {
  const role = await roleFor(email, orgId);
  return role === 'owner' || role === 'admin';
}

/**
 * Resolve the org a request is for, and authorise it in one step.
 *
 * Returns { org, role } or throws a tagged error the route turns into a
 * status. Callers must not fall back to "first org in the table" when the
 * slug is absent — that is precisely how one tenant ends up looking at
 * another's numbers.
 */
export async function authorize(email, slug) {
  if (!email) {
    const err = new Error('Not signed in.');
    err.status = 401;
    throw err;
  }
  const org = slug
    ? await one(`select id, slug, name from org where slug = $1`, [slug])
    : null;

  if (!org) {
    const err = new Error(slug ? `No such workspace: ${slug}` : 'No workspace specified.');
    err.status = slug ? 404 : 400;
    throw err;
  }
  const role = await roleFor(email, org.id);
  if (!role) {
    // 404 rather than 403 on purpose: confirming that a workspace exists to
    // someone with no access to it leaks the customer list.
    const err = new Error(`No such workspace: ${slug}`);
    err.status = 404;
    throw err;
  }
  return { org, role };
}
