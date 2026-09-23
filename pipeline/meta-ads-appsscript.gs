/**
 * Meta Ads → GSC Data sheet, as Apps Script.
 *
 * Lives alongside the existing nightly pipeline so the dashboard keeps a single
 * data source and Vercel never needs Meta credentials.
 *
 * WHY A SYSTEM USER TOKEN: reading your OWN ad accounts does not require App
 * Review. A System User token from Business Manager with ads_read is enough, and
 * unlike a personal user token it does not expire.
 *
 * SETUP  (once, ~15 minutes)
 *   1. developers.facebook.com → My Apps → Create App → type "Business".
 *   2. business.facebook.com → Business settings → Users → System users →
 *      Add. Give it the "Employee" role.
 *   3. Assign assets → Ad accounts → COVU Ads → enable "View performance".
 *   4. Generate new token → pick the app from step 1 → tick ads_read →
 *      Generate. Copy it. It does not expire; treat it like a password.
 *   5. In this Apps Script project: Project Settings → Script properties →
 *      add META_TOKEN with that value. Never paste it into the code.
 *   6. Run metaBackfill() once, then Triggers → add a daily trigger on metaMain().
 *
 * Idempotent: refreshes the trailing 90 days and preserves older history, so a
 * daily run corrects late-attributed leads without duplicating anything.
 *
 * EVERY top-level name here is prefixed `meta`/`META_`. That is not style.
 * Apps Script shares ONE global namespace across all files in a project, and
 * this one already contains the nightly Search Console + GA4 pipeline in
 * Code.gs. An unprefixed `main`, `writeMerged` or `SPREADSHEET_ID` would
 * silently override that pipeline's own — no error, just the wrong function
 * running on its 01:13 trigger. Keep the prefixes when editing.
 */

var META_SPREADSHEET_ID = '1IuI7NqgsrourIz1BeH44zx_Wp5_xSaGffkxYS1eYXXc';
var META_AD_ACCOUNT = 'act_4460021897602415';   // COVU Ads
/* Graph API version. Meta retires a version roughly two years after release,
 * and this one was pinned in August 2026 — if a metaRun fails with a deprecation
 * or "unsupported version" error, raise this to the current version shown at
 * developers.facebook.com/docs/graph-api/changelog. Nothing else needs to
 * change; the fields used here are stable across versions. */
var META_API_VERSION = 'v21.0';
var META_LOOKBACK_DAYS = 90;
var META_BACKFILL_DAYS = 365;

var META_DAILY_TAB = 'ads_meta_daily';
var META_AD_TAB = 'ads_meta_ad';

var META_DAILY_HEADER = ['date', 'campaign', 'adset', 'impressions', 'clicks', 'link_clicks', 'spend', 'leads'];
var META_AD_HEADER = ['date', 'ad', 'adset', 'campaign', 'impressions', 'clicks', 'link_clicks', 'spend', 'leads'];

function metaMain() { metaRun(META_LOOKBACK_DAYS); }
function metaBackfill() { metaRun(META_BACKFILL_DAYS); }

function metaRun(days) {
  var token = PropertiesService.getScriptProperties().getProperty('META_TOKEN');
  if (!token) throw new Error('META_TOKEN script property is not set — see setup notes at the top.');

  var range = metaDateRange(days);
  Logger.log('Pulling ' + range.since + ' → ' + range.until);

  var daily = metaFetchInsights(token, range, 'adset', function (r) {
    return [
      r.date_start,
      r.campaign_name || '',
      r.adset_name || '',
      metaInt(r.impressions),
      metaInt(r.clicks),
      metaLinkClicks(r),
      metaMoney(r.spend),
      metaLeads(r),
    ];
  });
  metaWriteMerged(META_DAILY_TAB, META_DAILY_HEADER, daily, 3, range);

  var ads = metaFetchInsights(token, range, 'ad', function (r) {
    return [
      r.date_start,
      r.ad_name || '',
      r.adset_name || '',
      r.campaign_name || '',
      metaInt(r.impressions),
      metaInt(r.clicks),
      metaLinkClicks(r),
      metaMoney(r.spend),
      metaLeads(r),
    ];
  });
  metaWriteMerged(META_AD_TAB, META_AD_HEADER, ads, 2, range);

  metaStampRun();
}

/* ---------- Graph API ---------- */

function metaFetchInsights(token, range, level, mapRow) {
  var fields = [
    'date_start', 'campaign_name', 'adset_name', 'impressions', 'clicks', 'spend', 'actions',
  ];
  if (level === 'ad') fields.push('ad_name');

  var url = 'https://graph.facebook.com/' + META_API_VERSION + '/' + META_AD_ACCOUNT + '/insights'
    + '?level=' + level
    + '&time_increment=1'
    + '&limit=500'
    + '&fields=' + encodeURIComponent(fields.join(','))
    + '&time_range=' + encodeURIComponent(JSON.stringify({ since: range.since, until: range.until }))
    + '&access_token=' + encodeURIComponent(token);

  var rows = [];
  var next = url;
  var pages = 0;

  while (next && pages < 60) {
    var res = UrlFetchApp.fetch(next, { muteHttpExceptions: true });
    var code = res.getResponseCode();
    var body = res.getContentText();

    if (code !== 200) {
      // Surface Meta's own message; guessing at these wastes time.
      var msg = body;
      try { msg = JSON.parse(body).error.message; } catch (e) { /* keep raw */ }
      throw new Error('Meta API HTTP ' + code + ' at level=' + level + ': ' + msg);
    }

    var json = JSON.parse(body);
    (json.data || []).forEach(function (r) { rows.push(mapRow(r)); });
    next = json.paging && json.paging.next ? json.paging.next : null;
    pages++;
  }
  Logger.log('level=' + level + ': ' + rows.length + ' rows over ' + pages + ' page(s)');
  return rows;
}

/* Meta reports conversions in a nested actions array rather than as columns. */
function metaLeads(r) {
  var total = 0;
  (r.actions || []).forEach(function (a) {
    var t = String(a.action_type || '');
    if (t === 'lead' || t.indexOf('onsite_conversion.lead') === 0
      || t === 'offsite_conversion.fb_pixel_lead') {
      total += Number(a.value || 0);
    }
  });
  return total;
}

function metaLinkClicks(r) {
  var total = 0;
  (r.actions || []).forEach(function (a) {
    if (String(a.action_type) === 'link_click') total += Number(a.value || 0);
  });
  return total;
}

/* ---------- sheet writing ---------- */

function metaWriteMerged(tabName, header, freshRows, keyCols, range) {
  var ss = SpreadsheetApp.openById(META_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(tabName) || ss.insertSheet(tabName);

  var kept = [];
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    var existing = sheet.getRange(2, 1, lastRow - 1, header.length).getValues();
    for (var i = 0; i < existing.length; i++) {
      var d = metaAsDate(existing[i][0]);
      if (!d) continue;
      if (d < range.since || d > range.until) {
        existing[i][0] = d;
        kept.push(existing[i]);
      }
    }
  }

  var all = kept.concat(freshRows);
  all.sort(function (a, b) {
    for (var c = 0; c < keyCols; c++) {
      if (a[c] < b[c]) return -1;
      if (a[c] > b[c]) return 1;
    }
    return 0;
  });

  sheet.clear();
  sheet.getRange(1, 1, 1, header.length).setValues([header]);

  /* The date column must be formatted as text BEFORE the values are written.
   *
   * Sheets coerces a string like "2026-09-08" into a date value on write, and
   * then renders it in the spreadsheet's locale. The dashboard reads this tab
   * through /export?format=csv and expects ISO, so a coerced column arrives as
   * "9/8/2026" — which the reader either mis-parses or drops. Applying the
   * text format afterwards does not undo a coercion that has already happened,
   * which is why the order here matters and is not a style choice. */
  if (all.length) {
    sheet.getRange(2, 1, all.length, 1).setNumberFormat('@');
    sheet.getRange(2, 1, all.length, header.length).setValues(all);
  }
  Logger.log(tabName + ': kept ' + kept.length + ' older rows, wrote ' + all.length + ' total');
}

function metaStampRun() {
  var ss = SpreadsheetApp.openById(META_SPREADSHEET_ID);
  var sheet = ss.getSheetByName('meta');
  if (!sheet) return;
  var last = sheet.getLastRow();
  if (last < 1) { sheet.getRange(1, 1, 1, 2).setValues([['ads_meta_last_run', new Date().toISOString()]]); return; }
  var keys = sheet.getRange(1, 1, last, 1).getValues();
  var target = -1;
  for (var i = 0; i < keys.length; i++) {
    if (String(keys[i][0]) === 'ads_meta_last_run') { target = i + 1; break; }
  }
  if (target < 0) target = sheet.getLastRow() + 1;
  sheet.getRange(target, 1, 1, 2).setValues([['ads_meta_last_run', new Date().toISOString()]]);
}

/* ---------- helpers ---------- */

function metaDateRange(days) {
  var tz = Session.getScriptTimeZone() || 'UTC';
  var until = new Date();
  var since = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);
  return {
    since: Utilities.formatDate(since, tz, 'yyyy-MM-dd'),
    until: Utilities.formatDate(until, tz, 'yyyy-MM-dd'),
  };
}

function metaAsDate(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'UTC', 'yyyy-MM-dd');
  var s = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
}

function metaInt(v) { return Math.round(Number(v || 0)); }
function metaMoney(v) { return Math.round(Number(v || 0) * 100) / 100; }
