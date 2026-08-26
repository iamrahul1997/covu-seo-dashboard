// COVU SEO & AEO dashboard — data API
//
// Reads the "GSC Data" Google Sheet (19 tabs, refreshed nightly by the GSC/GA
// pipeline) and returns a compact JSON payload for public/app.js.
//
// Rebuilt 2026-08-24. The original implementation was lost — it existed only
// inside a Vercel deployment with no repo and no local copy.

const SHEET_ID = process.env.SHEET_ID || '1IuI7NqgsrourIz1BeH44zx_Wp5_xSaGffkxYS1eYXXc';
const TTL_MS = 30 * 60 * 1000;

// Tabs we read, mapped to their sheet gid. Anything not listed is unused.
//
// We fetch by gid through /export?format=csv rather than by name through
// /gviz/tq, because gviz coerces each column to a single type and silently
// blanks every cell that disagrees. On the mixed-type `meta` tab that wiped out
// every value; gviz also merges the first two rows into one header there.
// /export returns the raw cell values and ISO dates.
//
// To regenerate this map if tabs are added or recreated:
//   curl -sL "https://docs.google.com/spreadsheets/d/<ID>/htmlview" \
//     | grep -oE 'name: "[^"]+".{0,200}?gid: "[0-9]+"'
const TABS = {
  meta: '1607344098',
  daily_totals: '1112366620',
  queries: '452894128',
  pages: '95425449',
  query_page: '928135167',
  appearance: '1351785315',
  device: '347826056',
  country: '267562045',
  blog_daily_totals: '1828167911',
  blog_queries: '1880118326',
  blog_pages: '127603406',
  blog_query_page: '1975009971',
  blog_device: '945457552',
  blog_country: '1866580908',
  ga_daily: '1410443220',
  ga_events: '1863466715',
  ga_landing: '1106334035',
  ga_event_landing: '2051391862',
  ads_google_daily: '694389940',
  ads_google_keyword: '1327370572',
};

/* Tabs written by the ads pipeline rather than the original GSC job. They may
 * not exist yet, or may be recreated with new gids, and neither should take the
 * whole dashboard down — the organic data is the part people rely on. */
const OPTIONAL_TABS = new Set(['ads_google_daily', 'ads_google_keyword',
  'ads_meta_daily', 'ads_meta_ad']);

// ---------- CSV ----------

// Google's gviz CSV quotes every field and escapes quotes by doubling them.
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function objectify(rows) {
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim());
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].length === 1 && !rows[i][0]) continue;
    const o = {};
    for (let j = 0; j < head.length; j++) o[head[j]] = rows[i][j];
    out.push(o);
  }
  return out;
}

async function get(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'covu-seo-dashboard' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function fetchTab(name) {
  const gid = TABS[name];
  try {
    const csv = await get(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`);
    return objectify(parseCSV(csv));
  } catch (err) {
    try {
      // A renamed or recreated tab changes its gid; fall back to lookup by name.
      const csv = await get(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq`
        + `?tqx=out:csv&headers=1&sheet=${encodeURIComponent(name)}`);
      return objectify(parseCSV(csv));
    } catch (err2) {
      if (OPTIONAL_TABS.has(name)) return [];
      throw new Error(`${name}: ${err2.message}`);
    }
  }
}

// ---------- helpers ----------

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const int = (v) => Math.round(num(v));

// Normally "2025-03-18" or "2025-03-18 00:00:00". A date-formatted column can
// come back as "4/29/2025" instead, so handle that shape too rather than
// slicing it into nonsense.
function day(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  return s.slice(0, 10);
}

// Monday-start week key, matching how the original dashboard bucketed.
function weekOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Rolls [date, key, clicks, impressions, ctr, position] rows into per-week
// tuples against a shared week index, interning the key strings so the payload
// ships each query/page label exactly once.
function rollUp(rows, keyField, weekIndex) {
  const strIds = new Map(), strings = [];
  const buckets = new Map();
  for (const r of rows) {
    const d = day(r.date);
    if (!d) continue;
    const wi = weekIndex.get(weekOf(d));
    if (wi === undefined) continue;
    const key = String(r[keyField] || '').trim();
    if (!key) continue;
    let si = strIds.get(key);
    if (si === undefined) { si = strings.length; strIds.set(key, si); strings.push(key); }
    const id = wi + ' ' + si;
    let b = buckets.get(id);
    if (!b) { b = [wi, si, 0, 0, 0]; buckets.set(id, b); }
    const impr = int(r.impressions);
    b[2] += int(r.clicks);
    b[3] += impr;
    b[4] += num(r.position) * impr; // impression-weighted, divided out below
  }
  const out = [];
  for (const b of buckets.values()) {
    b[4] = b[3] ? Math.round((b[4] / b[3]) * 100) : 0; // position * 100
    out.push(b);
  }
  out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return { strings, rows: out };
}

// Daily totals -> weeks[], totals[], and the day-count that tells us whether a
// week is complete. This is the fix for the partial-week bug: the old build
// showed a 4-day week next to 7-day weeks and called it a decline.
function buildWeeks(daily) {
  const map = new Map();
  for (const r of daily) {
    const d = day(r.date);
    if (!d) continue;
    const w = weekOf(d);
    let b = map.get(w);
    if (!b) { b = { c: 0, i: 0, p: 0, days: new Set() }; map.set(w, b); }
    const impr = int(r.impressions);
    b.c += int(r.clicks);
    b.i += impr;
    b.p += num(r.position) * impr;
    b.days.add(d);
  }
  const weeks = [...map.keys()].sort();
  const totals = [], weekDays = [];
  for (const w of weeks) {
    const b = map.get(w);
    totals.push([b.c, b.i, b.i ? Math.round((b.p / b.i) * 100) : 0]);
    weekDays.push(b.days.size);
  }
  return { weeks, totals, weekDays };
}

function weekIndexOf(weeks) {
  const m = new Map();
  weeks.forEach((w, i) => m.set(w, i));
  return m;
}

// Flat [key, clicks, impressions, ctr, position] snapshot tables.
function snapshot(rows, keyField, limit) {
  const out = rows.map((r) => ({
    k: String(r[keyField] || '').trim(),
    c: int(r.clicks), i: int(r.impressions),
    ct: num(r.ctr) * 100, po: num(r.position),
  })).filter((r) => r.k);
  out.sort((a, b) => b.c - a.c || b.i - a.i);
  return limit ? out.slice(0, limit) : out;
}

// query -> page pairs, used by the blog tab to show which post answers which query.
function pairSnapshot(rows, limit) {
  const out = rows.map((r) => ({
    q: String(r.query || '').trim(),
    p: String(r.page || '').trim(),
    c: int(r.clicks), i: int(r.impressions),
    ct: num(r.ctr) * 100, po: num(r.position),
  })).filter((r) => r.q && r.p);
  out.sort((a, b) => b.c - a.c || b.i - a.i);
  return limit ? out.slice(0, limit) : out;
}

// date/dimension tables (device, country) -> weekly series per dimension value.
function dimWeekly(rows, dimField, weekIndex, topN) {
  const totalsByDim = new Map();
  const cells = new Map();
  for (const r of rows) {
    const d = day(r.date);
    if (!d) continue;
    const wi = weekIndex.get(weekOf(d));
    if (wi === undefined) continue;
    const k = String(r[dimField] || '').trim();
    if (!k) continue;
    const c = int(r.clicks), i = int(r.impressions);
    totalsByDim.set(k, (totalsByDim.get(k) || 0) + c);
    const id = k + ' ' + wi;
    let b = cells.get(id);
    if (!b) { b = { k, wi, c: 0, i: 0, p: 0 }; cells.set(id, b); }
    b.c += c; b.i += i; b.p += num(r.position) * i;
  }
  let keys = [...totalsByDim.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
  if (topN) keys = keys.slice(0, topN);
  const keep = new Set(keys);
  const kIdx = new Map(keys.map((k, i) => [k, i]));
  const out = [];
  for (const b of cells.values()) {
    if (!keep.has(b.k)) continue;
    out.push([kIdx.get(b.k), b.wi, b.c, b.i, b.i ? Math.round((b.p / b.i) * 100) : 0]);
  }
  out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return { keys, rows: out };
}

// ---------- GA ----------

// GA4 exposes an "AI Assistant" default channel group — ChatGPT, Perplexity,
// Copilot and friends. That channel is the only first-party AEO signal we have,
// so it gets promoted out of the generic channel list in the payload.
const AI_CHANNEL = 'AI Assistant';

function buildGA(gaDaily, gaEvents, gaLanding, gaEventLanding, weekIndex) {
  const chTotals = new Map(), cells = new Map();
  for (const r of gaDaily) {
    const d = day(r.date);
    if (!d) continue;
    const wi = weekIndex.get(weekOf(d));
    if (wi === undefined) continue;
    const ch = String(r.channel || '').trim();
    if (!ch) continue;
    const s = int(r.sessions);
    chTotals.set(ch, (chTotals.get(ch) || 0) + s);
    const id = ch + ' ' + wi;
    let b = cells.get(id);
    if (!b) { b = { ch, wi, s: 0, e: 0, u: 0 }; cells.set(id, b); }
    b.s += s; b.e += int(r.engagedSessions); b.u += int(r.totalUsers);
  }
  const channels = [...chTotals.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
  const cIdx = new Map(channels.map((c, i) => [c, i]));
  const rows = [];
  for (const b of cells.values()) rows.push([cIdx.get(b.ch), b.wi, b.s, b.e, b.u]);
  rows.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const evTotals = new Map(), evCells = new Map();
  for (const r of gaEvents) {
    const d = day(r.date);
    if (!d) continue;
    const wi = weekIndex.get(weekOf(d));
    if (wi === undefined) continue;
    const ev = String(r.event || '').trim();
    if (!ev) continue;
    const n = int(r.count);
    evTotals.set(ev, (evTotals.get(ev) || 0) + n);
    const id = ev + ' ' + wi;
    evCells.set(id, (evCells.get(id) || 0) + n);
  }
  const events = [...evTotals.keys()].sort((a, b) => evTotals.get(b) - evTotals.get(a));
  const eIdx = new Map(events.map((e, i) => [e, i]));
  const evRows = [];
  for (const [id, n] of evCells) {
    const sp = id.lastIndexOf(' ');
    evRows.push([eIdx.get(id.slice(0, sp)), +id.slice(sp + 1), n]);
  }
  evRows.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  // Landing pages have no date column — they are a rolling snapshot.
  const landing = gaLanding.map((r) => ({
    l: String(r.landing || '').trim(),
    ch: String(r.channel || '').trim(),
    s: int(r.sessions), e: int(r.engagedSessions), u: int(r.totalUsers),
  })).filter((r) => r.l);
  landing.sort((a, b) => b.s - a.s);

  // Which pages the AI assistants actually land people on.
  const aiLanding = landing.filter((r) => r.ch === AI_CHANNEL);

  const evLanding = gaEventLanding.map((r) => ({
    l: String(r.landing || '').trim(),
    ev: String(r.event || '').trim(),
    n: int(r.count),
  })).filter((r) => r.l && r.ev);
  evLanding.sort((a, b) => b.n - a.n);

  return {
    channels, rows,
    events, evRows,
    aiChannel: channels.indexOf(AI_CHANNEL),
    landing: landing.slice(0, 60),
    aiLanding: aiLanding.slice(0, 40),
    evLanding: evLanding.slice(0, 60),
  };
}

// ---------- paid media ----------

/* Ads spend rolled into the same weekly index as organic, so one set of range
 * buttons drives both. Money is carried as integer cents and conversions as
 * hundredths — decimals accumulate float error across a quarter of daily rows.
 */
function rollUpAds(rows, weekIndex, keyField) {
  const names = [], idx = new Map(), cells = new Map();
  for (const r of rows) {
    const d = day(r.date);
    if (!d) continue;
    const wi = weekIndex.get(weekOf(d));
    if (wi === undefined) continue;
    const name = String(r[keyField] || '').trim() || '(unattributed)';
    let ci = idx.get(name);
    if (ci === undefined) { ci = names.length; idx.set(name, ci); names.push(name); }
    const id = wi + ' ' + ci;
    let b = cells.get(id);
    if (!b) { b = [wi, ci, 0, 0, 0, 0]; cells.set(id, b); }
    b[2] += int(r.impressions);
    b[3] += int(r.clicks);
    b[4] += Math.round(num(r.cost !== undefined ? r.cost : r.spend) * 100);
    b[5] += Math.round(num(r.conversions !== undefined ? r.conversions : r.leads) * 100);
  }
  return {
    keys: names,
    rows: [...cells.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]),
  };
}

/* Keywords have no useful week-by-week shape at this spend level, so they ship
 * as one snapshot over whatever window the pipeline last wrote. */
function keywordSnapshot(rows, limit) {
  const agg = new Map();
  for (const r of rows) {
    const k = String(r.keyword || '').trim();
    if (!k) continue;
    const match = String(r.match_type || '').trim();
    const id = k + '|' + match;
    let e = agg.get(id);
    if (!e) { e = { k, m: match, camp: String(r.campaign || '').trim(), c: 0, i: 0, cost: 0, conv: 0 }; agg.set(id, e); }
    e.i += int(r.impressions);
    e.c += int(r.clicks);
    e.cost += num(r.cost);
    e.conv += num(r.conversions);
  }
  const out = [...agg.values()].map((e) => ({
    k: e.k, m: e.m, camp: e.camp, c: e.c, i: e.i,
    cost: Math.round(e.cost * 100) / 100,
    conv: Math.round(e.conv * 100) / 100,
  }));
  out.sort((a, b) => b.cost - a.cost || b.c - a.c);
  return limit ? out.slice(0, limit) : out;
}

// ---------- HubSpot ----------

// Optional. Set HUBSPOT_TOKEN (a private-app token with content analytics read)
// in Vercel project settings to light up the conversion panel. Without it the
// dashboard renders normally and the panel explains that it is not connected.
async function fetchHubSpot(startDate, endDate) {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) return { connected: false, reason: 'HUBSPOT_TOKEN not set' };

  const compact = (d) => d.replace(/-/g, '');
  const url = 'https://api.hubapi.com/analytics/v2/reports/pages/total'
    + `?start=${compact(startDate)}&end=${compact(endDate)}&limit=100`;

  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });

    if (!res.ok) {
      // Surface HubSpot's own message. 403 almost always means the private app
      // is missing the business-intelligence scope; 401 means a bad or rotated
      // token. Without this the panel just says "HTTP 403" and stalls.
      let detail = '';
      try {
        const body = await res.text();
        const parsed = JSON.parse(body);
        detail = parsed.message || parsed.error || body.slice(0, 200);
      } catch { detail = ''; }
      // 403 here is always a scope problem. HubSpot names the scopes it wants
      // in the message body, so pass that through rather than paraphrasing —
      // an earlier guess of "business-intelligence" was simply wrong.
      const hint = res.status === 403
        ? ' — the private app needs the traffic-analytics-api-access or'
          + ' cms-analytics-api-access scope'
        : res.status === 401 ? ' — token rejected; it may have been rotated' : '';
      return {
        connected: false,
        reason: `HubSpot HTTP ${res.status}${hint}${detail ? ': ' + detail : ''}`,
      };
    }

    const json = await res.json();

    /* HubSpot's analytics responses have appeared in three shapes over the
     * years: {breakdowns:{key:metrics}}, a flat {key:metrics} map, and
     * {results:[{...}]}. Accept all three rather than silently rendering
     * nothing when the shape is not the one guessed. */
    let entries = [];
    if (Array.isArray(json)) {
      entries = json.map((v) => [v.path || v.url || v.name || v.id || '(unknown)', v]);
    } else if (Array.isArray(json.results)) {
      entries = json.results.map((v) => [v.path || v.url || v.name || v.id || '(unknown)', v]);
    } else {
      entries = Object.entries(json.breakdowns || json);
    }

    const rows = [];
    for (const [key, v] of entries) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      const views = int(v.rawViews ?? v.pageviews ?? v.visits ?? v.sessions);
      const subs = int(v.submissions ?? v.formSubmissions);
      const contacts = int(v.contacts ?? v.newContacts);
      if (!views && !subs && !contacts) continue;
      rows.push({
        k: String(key),
        views,
        subs,
        contacts,
        bounce: num(v.bounceRate) * 100,
        time: num(v.timePerPageview ?? v.timePerSession),
      });
    }
    rows.sort((a, b) => b.views - a.views);

    if (!rows.length) {
      // Better than an empty table: name the keys we got so the shape can be fixed.
      return {
        connected: false,
        reason: 'HubSpot responded but no rows matched the expected fields. Top-level keys: '
          + Object.keys(json).slice(0, 8).join(', '),
      };
    }
    return { connected: true, rows: rows.slice(0, 40), start: startDate, end: endDate };
  } catch (err) {
    return { connected: false, reason: String((err && err.message) || err) };
  }
}

// ---------- payload ----------

let cache = null;

async function build() {
  const t = {};
  await Promise.all(Object.keys(TABS).map(async (name) => { t[name] = await fetchTab(name); }));

  const metaKV = {};
  for (const r of t.meta) if (r.key) metaKV[r.key] = r.value;

  const { weeks, totals, weekDays } = buildWeeks(t.daily_totals);
  if (!weeks.length) throw new Error('daily_totals is empty — pipeline may not have run');
  const wIdx = weekIndexOf(weeks);

  // Last week with all 7 days present. Everything downstream defaults to this
  // so the newest, still-filling week can never masquerade as a decline.
  let lastComplete = weeks.length - 1;
  while (lastComplete > 0 && weekDays[lastComplete] < 7) lastComplete--;

  const q = rollUp(t.queries, 'query', wIdx);
  const p = rollUp(t.pages, 'page', wIdx);

  // The blog is a separate Search Console property with its own shorter history.
  const blogW = buildWeeks(t.blog_daily_totals);
  const blogIdx = weekIndexOf(blogW.weeks);
  let blogLastComplete = blogW.weeks.length - 1;
  while (blogLastComplete > 0 && blogW.weekDays[blogLastComplete] < 7) blogLastComplete--;
  const bq = rollUp(t.blog_queries, 'query', blogIdx);
  const bp = rollUp(t.blog_pages, 'page', blogIdx);

  const maxDay = (rows) => rows.reduce((m, r) => { const d = day(r.date); return d > m ? d : m; }, '');
  const dataThrough = maxDay(t.daily_totals);
  const queriesThrough = maxDay(t.queries);

  const hubspot = await fetchHubSpot(addDays(dataThrough, -89), dataThrough);
  /* One line of ops logging so the integration's health is visible in Vercel's
   * runtime logs without needing a signed-in session to inspect the payload.
   * Deliberately records only the outcome — never the token, never any row. */
  console.log('hubspot:', hubspot.connected
    ? 'connected, ' + hubspot.rows.length + ' rows'
    : 'not connected — ' + hubspot.reason);

  return {
    meta: {
      property: (metaKV.property_root || 'sc-domain:covu.com').replace('sc-domain:', ''),
      blogProperty: (metaKV.property_blog_ || 'sc-domain:blog.covu.com').replace('sc-domain:', ''),
      searchType: 'Web',
      lastRun: metaKV.last_run || null,
      dataLagDays: metaKV.data_lag_days ? Math.round(num(metaKV.data_lag_days)) : null,
      minWeek: weeks[0],
      maxWeek: weeks[weeks.length - 1],
      lastCompleteWeek: lastComplete,
      dataThrough,            // last day of site totals we actually hold
      queriesThrough,         // query-level data lags totals by a day or so
      blogThrough: maxDay(t.blog_daily_totals),
      queryPageWindow: metaKV.query_page_window_days ? Math.round(num(metaKV.query_page_window_days)) : 90,
      refreshed: new Date().toISOString(),
    },
    weeks, totals, weekDays,
    qStr: q.strings, qW: q.rows,
    pStr: p.strings, pW: p.rows,
    queryPage: pairSnapshot(t.query_page, 300),
    searchAppearance: snapshot(t.appearance, 'searchAppearance'),
    device: dimWeekly(t.device, 'device', wIdx),
    country: dimWeekly(t.country, 'country', wIdx, 20),
    blog: {
      weeks: blogW.weeks, totals: blogW.totals, weekDays: blogW.weekDays,
      lastCompleteWeek: blogLastComplete,
      qStr: bq.strings, qW: bq.rows,
      pStr: bp.strings, pW: bp.rows,
      queryPage: pairSnapshot(t.blog_query_page, 300),
      device: dimWeekly(t.blog_device, 'device', blogIdx),
      country: dimWeekly(t.blog_country, 'country', blogIdx, 15),
    },
    ga: buildGA(t.ga_daily, t.ga_events, t.ga_landing, t.ga_event_landing, wIdx),
    ads: {
      google: {
        campaigns: rollUpAds(t.ads_google_daily, wIdx, 'campaign'),
        keywords: keywordSnapshot(t.ads_google_keyword, 100),
        lastRun: metaKV.ads_google_last_run || null,
        through: maxDay(t.ads_google_daily) || null,
      },
      /* Meta's tabs do not exist yet. They are read through the same shape, so
       * adding their gids to TABS is the only change needed once the Apps
       * Script has run — deliberately not added with a blank gid, because
       * /export with an empty gid silently returns the FIRST sheet. */
      meta: {
        campaigns: rollUpAds(t.ads_meta_daily || [], wIdx, 'campaign'),
        adsets: rollUpAds(t.ads_meta_daily || [], wIdx, 'adset'),
        creatives: rollUpAds(t.ads_meta_ad || [], wIdx, 'ad'),
        lastRun: metaKV.ads_meta_last_run || null,
        through: maxDay(t.ads_meta_daily || []) || null,
      },
    },
    hubspot,
  };
}

export default async function handler(req, res) {
  try {
    const fresh = req.query && (req.query.fresh === '1' || req.query.nocache === '1');
    if (!cache || fresh || Date.now() - cache.at > TTL_MS) {
      cache = { at: Date.now(), payload: await build() };
    }
    res.setHeader('content-type', 'application/json; charset=utf-8');
    // CDN-cached so visitors are not each paying for a 14MB sheet read.
    res.setHeader('cache-control', 'public, max-age=0, s-maxage=1800, stale-while-revalidate=86400');
    res.status(200).send(JSON.stringify(cache.payload));
  } catch (err) {
    res.setHeader('cache-control', 'no-store');
    res.status(500).json({ error: String((err && err.message) || err) });
  }
}

export { build, parseCSV, objectify, weekOf, rollUp, buildWeeks };
