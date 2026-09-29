// The one command that keeps the platform current.
//
//   node scripts/refresh.js            # migrate, load every source, verify
//   node scripts/refresh.js --quiet    # one summary line, for a scheduled run
//
// Three steps, in this order, because each depends on the last:
//
//   1. migrate   — the schema may have moved since the last run
//   2. backfill  — pull every enabled source through its connector
//   3. reconcile — prove the result matches the source
//
// Step 3 is the part that makes this automation rather than a cron job that
// moves bytes. An unattended pipeline that loads without verifying will
// eventually load something wrong and keep serving it confidently, which is
// precisely the failure this project is built against. A refresh that cannot
// verify itself exits non-zero and says why.
//
// Exit codes: 0 all good · 1 verification failed · 2 a source failed to load
// · 3 something threw. Anything non-zero is worth a human's attention.

import { close } from '../lib/db.js';
import { migrate } from './migrate.js';
import { backfill } from './backfill.js';
import { reconcile } from './reconcile.js';

const QUIET = process.argv.includes('--quiet');
const ORG = process.argv.find((a) => a.startsWith('--org='))?.slice(6) || 'covu';

export async function refresh({ orgSlug = 'covu', quiet = false } = {}) {
  const started = Date.now();
  const log = quiet ? () => {} : (...a) => console.log(...a);
  const stamp = new Date().toISOString();

  log(`\n=== refresh ${stamp} · org "${orgSlug}" ===\n`);

  log('1/3 migrate');
  const applied = await migrate({ quiet });

  log('2/3 load sources');
  const loads = await backfill({ orgSlug, quiet });
  const failedLoads = loads.filter((r) => r.status === 'error');
  const rows = loads.reduce((n, r) => n + (r.rows || 0), 0);

  log('3/3 verify');
  // Verification runs even when a source failed to load, so the report covers
  // everything that IS loaded rather than stopping at the first problem.
  const verdict = await reconcile(orgSlug, { quiet });

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const status = failedLoads.length ? 'sources-failed'
    : verdict.failed.length ? 'verification-failed' : 'ok';

  const summary = {
    at: stamp,
    org: orgSlug,
    status,
    seconds: Number(secs),
    migrationsApplied: applied.length,
    rowsWritten: rows,
    sourcesLoaded: loads.length - failedLoads.length,
    sourcesFailed: failedLoads.map((r) => ({ source: r.source, error: r.error })),
    checksPassed: verdict.passed,
    checksFailed: verdict.failed.map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ''}`),
    notes: verdict.notes.map((n) => n.name),
  };

  // One machine-readable line, always printed even in quiet mode. This is what
  // a scheduler's log, an alert, or a human skimming yesterday actually reads.
  console.log(`refresh ${status} · ${rows.toLocaleString()} rows · `
    + `${verdict.passed} checks passed, ${verdict.failed.length} failed · ${secs}s`);

  for (const f of summary.checksFailed) console.log(`  FAILED CHECK: ${f}`);
  for (const f of summary.sourcesFailed) console.log(`  SOURCE FAILED: #${f.source} ${f.error}`);

  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let code = 0;
  try {
    const s = await refresh({ orgSlug: ORG, quiet: QUIET });
    code = s.sourcesFailed.length ? 2 : s.checksFailed.length ? 1 : 0;
  } catch (err) {
    console.error(`refresh threw: ${err?.message || err}`);
    code = 3;
  }
  await close();
  process.exit(code);
}
