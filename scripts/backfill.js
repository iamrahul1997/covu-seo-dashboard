// Load every enabled source into Postgres through its connector.
//
//   node scripts/backfill.js            # all sources for org "covu"
//   node scripts/backfill.js 1 3        # only source ids 1 and 3
//
// Safe to re-run: facts upsert on their natural key, so a repeat pass
// overwrites rather than duplicates.

import { query, close } from '../lib/db.js';
import { ingest } from '../lib/ingest.js';
import { sheetConnector } from '../connectors/sheet.js';

const CONNECTORS = { sheet: sheetConnector };

export async function backfill({ orgSlug = 'covu', only = [], quiet = false } = {}) {
  const log = quiet ? () => {} : (...a) => console.log(...a);

  const sources = (await query(
    `select s.* from source s join org o on o.id = s.org_id
      where o.slug = $1 and s.enabled
      order by s.id`,
    [orgSlug],
  )).rows.filter((s) => !only.length || only.includes(Number(s.id)));

  if (!sources.length) throw new Error(`no enabled sources for org "${orgSlug}"`);

  const results = [];
  for (const source of sources) {
    const make = CONNECTORS[source.transport];
    if (!make) throw new Error(`source #${source.id}: no connector for transport "${source.transport}"`);

    const started = Date.now();
    const connector = make();
    try {
      const out = await ingest(source, connector);
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      log(`#${source.id} ${source.label}: ${out.rows.toLocaleString()} rows in ${secs}s`);
      const skipped = connector.notes().skipped;
      // A skipped tab is reported, never swallowed. A source that silently
      // loads 6 of 7 tabs is worse than one that fails, because it looks fine.
      for (const s of skipped) log(`   skipped ${s.tab}: ${s.reason}`);
      results.push({ source: source.id, ...out, skipped });
    } catch (err) {
      log(`#${source.id} ${source.label}: FAILED — ${err.message}`);
      results.push({ source: source.id, status: 'error', error: err.message });
    }
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const only = process.argv.slice(2).map(Number).filter(Boolean);
  await backfill({ only });
  await close();
}
