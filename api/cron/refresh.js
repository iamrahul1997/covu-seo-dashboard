// GET /api/cron/refresh — the scheduled ingest, invoked by Vercel Cron.
//
// This is the destination for the automation. It replaces a nightly Apps
// Script trigger, a Google Ads Script schedule and a manual spreadsheet read
// spread across three separate consoles, none of which can be alerted on.
//
// AUTHORISATION. Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. The
// route refuses anything else, and refuses everything if CRON_SECRET is unset
// — an ingest endpoint left open lets anyone force repeated full reads of the
// upstream sources. It fails closed, matching how auth is configured elsewhere
// in this stack.
//
// TIMEOUT. A full refresh reads every source and takes tens of seconds. Vercel
// caps a function well below what a cold multi-source load needs, so pass
// ?source=<id> to refresh one source per invocation and schedule them
// separately, or run this where the limit is high enough. Attempting all four
// on a Hobby plan will time out mid-load — which is safe (each source is one
// transaction) but leaves the run marked 'running' rather than 'ok'.

import { refresh } from '../../scripts/refresh.js';
import { backfill } from '../../scripts/backfill.js';
import { migrate } from '../../scripts/migrate.js';

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

  if (!secret) {
    return res.status(503).json({ error: 'CRON_SECRET is not set; refusing to run' });
  }
  if (given !== secret) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const org = process.env.ORG_SLUG || 'covu';
  const only = req.query?.source ? [Number(req.query.source)] : [];

  try {
    if (only.length) {
      // Single-source mode: load and record, skipping verification so one
      // invocation stays inside the function's time budget.
      await migrate({ quiet: true });
      const loads = await backfill({ orgSlug: org, only, quiet: true });
      const failed = loads.filter((r) => r.status === 'error');
      return res.status(failed.length ? 500 : 200).json({ mode: 'source', loads });
    }
    const summary = await refresh({ orgSlug: org, quiet: true });
    const bad = summary.sourcesFailed.length || summary.checksFailed.length;
    return res.status(bad ? 500 : 200).json(summary);
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
}
