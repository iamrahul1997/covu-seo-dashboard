// Print platform health.  node scripts/health.js [orgSlug] [--json]
import { close } from '../lib/db.js';
import { health } from '../lib/health.js';

const args = process.argv.slice(2);
const org = args.find((a) => !a.startsWith('--')) || 'covu';
const h = await health(org);

if (args.includes('--json')) {
  console.log(JSON.stringify(h, null, 2));
} else {
  console.log(`\nplatform: ${h.status.toUpperCase()}  (org "${h.org}", ${h.checkedAt})\n`);
  for (const s of h.sources) {
    const lag = s.observedLagDays == null ? '—' : `${s.observedLagDays}d`;
    console.log(`  [${s.status.padEnd(7)}] #${s.id} ${s.label}`);
    console.log(`            through ${s.dataThrough ?? '—'} · observed lag ${lag} `
      + `· declared ${s.declaredLagDays}d · ${s.rows.toLocaleString()} rows`);
    console.log(`            last ingest ${s.lastIngestStatus ?? 'never'} `
      + `${s.lastIngestAt ? `at ${new Date(s.lastIngestAt).toISOString()}` : ''}`);
    if (s.reason) console.log(`            reason: ${s.reason}`);
  }
  console.log('');
}
await close();
process.exit(h.status === 'ok' ? 0 : 1);
