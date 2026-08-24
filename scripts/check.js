// Builds the payload against the live sheet and asserts the invariants the
// dashboard depends on. Run with: npm run check
import { build } from '../api/data.js';

const fail = [];
const warn = [];
function ok(cond, msg) { if (!cond) fail.push(msg); }

const t0 = Date.now();
const d = await build();
const ms = Date.now() - t0;
const bytes = Buffer.byteLength(JSON.stringify(d));

console.log(`built in ${ms}ms · ${(bytes / 1024 / 1024).toFixed(2)}MB\n`);

// --- structure ---
ok(Array.isArray(d.weeks) && d.weeks.length > 50, 'weeks missing or too short');
ok(d.totals.length === d.weeks.length, 'totals/weeks length mismatch');
ok(d.weekDays.length === d.weeks.length, 'weekDays/weeks length mismatch');
ok(d.weeks.join() === [...d.weeks].sort().join(), 'weeks not sorted');
ok(new Set(d.weeks).size === d.weeks.length, 'duplicate weeks');

// --- index integrity: every row must point at a real week and a real string ---
for (const [name, rows, strs] of [
  ['qW', d.qW, d.qStr], ['pW', d.pW, d.pStr],
  ['blog.qW', d.blog.qW, d.blog.qStr], ['blog.pW', d.blog.pW, d.blog.pStr],
]) {
  const weeks = name.startsWith('blog') ? d.blog.weeks : d.weeks;
  const badW = rows.filter((r) => r[0] < 0 || r[0] >= weeks.length).length;
  const badS = rows.filter((r) => r[1] < 0 || r[1] >= strs.length).length;
  const badC = rows.filter((r) => r[2] > r[3]).length;
  ok(!badW, `${name}: ${badW} rows with out-of-range week index`);
  ok(!badS, `${name}: ${badS} rows with out-of-range string index`);
  ok(!badC, `${name}: ${badC} rows where clicks > impressions`);
  ok(rows.length > 0, `${name}: empty`);
  console.log(`${name.padEnd(9)} rows=${String(rows.length).padStart(6)}  strings=${strs.length}`);
}

// --- the partial-week fix ---
const last = d.weeks.length - 1;
console.log(`\nlastCompleteWeek = ${d.meta.lastCompleteWeek} (${d.weeks[d.meta.lastCompleteWeek]}) of ${last} (${d.weeks[last]})`);
console.log(`weekDays tail    = ${d.weekDays.slice(-4).join(', ')}`);
ok(d.weekDays[d.meta.lastCompleteWeek] === 7, 'lastCompleteWeek is not actually complete');
ok(d.meta.lastCompleteWeek <= last, 'lastCompleteWeek out of range');
if (d.meta.lastCompleteWeek === last && d.weekDays[last] < 7) fail.push('partial final week not detected');
console.log(`dataThrough=${d.meta.dataThrough}  queriesThrough=${d.meta.queriesThrough}  blogThrough=${d.meta.blogThrough}  lag=${d.meta.dataLagDays}d`);

// --- brand split sanity (the bug that started this) ---
const BRAND = /covu|co\.vu|co vu/i;
const wi = d.meta.lastCompleteWeek, wa = Math.max(0, wi - 12);
let bc = 0, nc = 0;
for (const r of d.qW) {
  if (r[0] < wa || r[0] > wi) continue;
  (BRAND.test(d.qStr[r[1]]) ? (bc += r[2]) : (nc += r[2]));
}
console.log(`\nbrand split over last 13 complete weeks: branded=${bc} non-branded=${nc} (${(bc / (bc + nc) * 100).toFixed(1)}% brand)`);
ok(bc > 0, 'brand matcher still matches nothing — the original bug');

// --- new data sources ---
console.log(`\nGA channels (${d.ga.channels.length}): ${d.ga.channels.slice(0, 6).join(', ')}…`);
console.log(`GA AI channel index = ${d.ga.aiChannel}  (${d.ga.aiChannel >= 0 ? d.ga.channels[d.ga.aiChannel] : 'NOT FOUND'})`);
ok(d.ga.aiChannel >= 0, 'AI Assistant channel not found in ga_daily');
const aiSessions = d.ga.rows.filter((r) => r[0] === d.ga.aiChannel).reduce((a, r) => a + r[2], 0);
console.log(`GA AI sessions   = ${aiSessions} across ${d.ga.rows.filter((r) => r[0] === d.ga.aiChannel).length} weeks`);
console.log(`GA events        = ${d.ga.events.join(', ')}`);
console.log(`GA landing rows  = ${d.ga.landing.length}  aiLanding=${d.ga.aiLanding.length}  evLanding=${d.ga.evLanding.length}`);
ok(d.ga.events.length > 0, 'no GA events');

console.log(`\nblog: weeks=${d.blog.weeks.length} queries=${d.blog.qStr.length} pages=${d.blog.pStr.length} queryPage=${d.blog.queryPage.length}`);
console.log(`blog device=${d.blog.device.keys.join('/')} country=${d.blog.country.keys.slice(0, 5).join('/')}`);
ok(d.blog.weeks.length > 10, 'blog weeks too short');
ok(d.blog.pStr.length > 0, 'no blog pages');

console.log(`\nqueryPage=${d.queryPage.length} appearance=${d.searchAppearance.length} device=${d.device.keys.join('/')} country=${d.country.keys.length}`);
console.log(`hubspot: connected=${d.hubspot.connected}${d.hubspot.connected ? ` rows=${d.hubspot.rows.length}` : ` (${d.hubspot.reason})`}`);
if (!d.hubspot.connected) warn.push(`HubSpot not wired: ${d.hubspot.reason}`);

// --- totals cross-check against the raw sheet ---
const totalClicks = d.totals.reduce((a, r) => a + r[0], 0);
const qClicks = d.qW.reduce((a, r) => a + r[2], 0);
console.log(`\nsite clicks (daily_totals) = ${totalClicks}  |  query-level clicks = ${qClicks}  (${(qClicks / totalClicks * 100).toFixed(1)}% — GSC anonymises the rest)`);
ok(qClicks <= totalClicks * 1.02, 'query clicks exceed site totals — bucketing is wrong');

console.log('');
for (const w of warn) console.log(`WARN  ${w}`);
if (fail.length) {
  for (const f of fail) console.log(`FAIL  ${f}`);
  process.exit(1);
}
console.log(`PASS — ${bytes < 4e6 ? 'payload within budget' : 'PAYLOAD LARGE'}`);
