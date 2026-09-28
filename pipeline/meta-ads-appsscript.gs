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
 * SCOPE: ad account act_4460021897602415 only, June 2026 onward. Tracks leads
 * and the meeting_confirmed custom conversion.
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
/* Custom conversion to track alongside leads. Meta does NOT expose custom
 * events by name in the insights `actions` array — they arrive as
 * `offsite_conversion.custom.<id>` — so the id is resolved by name at run time
 * from /customconversions. Rename here if the conversion is renamed in Events
 * Manager. */
var META_MEETING_EVENT = 'meeting_confirmed';
var META_LOOKBACK_DAYS = 90;

/* Hard floor on history. Nothing before this date is ever requested, by either
 * the daily run or a backfill — Rahul only wants June 2026 onward, and an
 * absolute date cannot drift the way a day count does. */
var META_START_DATE = '2026-06-01';

var META_DAILY_TAB = 'ads_meta_daily';
var META_AD_TAB = 'ads_meta_ad';

var META_DAILY_HEADER = ['date', 'campaign', 'objective', 'adset', 'impressions', 'clicks', 'link_clicks', 'spend', 'leads', 'meetings'];
var META_AD_HEADER = ['date', 'ad', 'ad_id', 'adset', 'campaign', 'objective', 'impressions', 'clicks', 'link_clicks', 'spend', 'leads', 'meetings', 'thumbnail', 'image'];

function metaMain() { metaRun(META_LOOKBACK_DAYS); }
/* Everything from META_START_DATE to today; the clamp in metaDateRange does the
 * limiting, so the number here only has to be large enough. */
function metaBackfill() { metaRun(3650); }

function metaRun(days) {
  var token = PropertiesService.getScriptProperties().getProperty('META_TOKEN');
  if (!token) throw new Error('META_TOKEN script property is not set — see setup notes at the top.');

  var range = metaDateRange(days);
  Logger.log('Pulling ' + range.since + ' → ' + range.until);
  var meetingTypes = metaMeetingActionTypes(token);
  var thumbs = metaCreativeThumbnails(token);
  var objectives = metaCampaignObjectives(token);

  var daily = metaFetchInsights(token, range, 'adset', function (r) {
    return [
      r.date_start,
      r.campaign_name || '',
      objectives[String(r.campaign_name || '')] || '',
      r.adset_name || '',
      metaInt(r.impressions),
      metaInt(r.clicks),
      metaLinkClicks(r),
      metaMoney(r.spend),
      metaLeads(r),
      metaMeetings(r, meetingTypes),
    ];
  });
  metaWriteMerged(META_DAILY_TAB, META_DAILY_HEADER, daily, 3, range);

  var ads = metaFetchInsights(token, range, 'ad', function (r) {
    return [
      r.date_start,
      r.ad_name || '',
      String(r.ad_id || ''),
      r.adset_name || '',
      r.campaign_name || '',
      objectives[String(r.campaign_name || '')] || '',
      metaInt(r.impressions),
      metaInt(r.clicks),
      metaLinkClicks(r),
      metaMoney(r.spend),
      metaLeads(r),
      metaMeetings(r, meetingTypes),
      (thumbs[String(r.ad_id || '')] || {}).thumb || '',
      (thumbs[String(r.ad_id || '')] || {}).full || '',
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
  if (level === 'ad') { fields.push('ad_name'); fields.push('ad_id'); }

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
      /* Surface the whole error, not just the message.
       *
       * The failures on 26-27 Sep read only "API access blocked", which is not
       * enough to act on — Meta uses it for a restricted app, a restricted ad
       * account and a pending business verification alike. `code` and
       * `error_subcode` are what separate those, and error_user_title /
       * error_user_msg carry the human-readable remedy when Meta has one. */
      throw new Error('Meta API HTTP ' + code + ' at level=' + level + ': '
        + metaDescribeError(body));
    }

    var json = JSON.parse(body);
    (json.data || []).forEach(function (r) { rows.push(mapRow(r)); });
    next = json.paging && json.paging.next ? json.paging.next : null;
    pages++;
  }
  Logger.log('level=' + level + ': ' + rows.length + ' rows over ' + pages + ' page(s)');
  return rows;
}

/* Flatten a Graph API error into one readable line. */
function metaDescribeError(body) {
  try {
    var e = JSON.parse(body).error || {};
    var bits = [];
    if (e.message) bits.push(e.message);
    if (e.code !== undefined) bits.push('code ' + e.code
      + (e.error_subcode ? '/' + e.error_subcode : ''));
    if (e.type) bits.push(e.type);
    if (e.error_user_title) bits.push(e.error_user_title);
    if (e.error_user_msg) bits.push(e.error_user_msg);
    if (e.fbtrace_id) bits.push('trace ' + e.fbtrace_id);
    return bits.length ? bits.join(' · ') : body.slice(0, 300);
  } catch (err) {
    return String(body).slice(0, 300);
  }
}

/* What each campaign was actually bought to do.
 *
 * Without this every creative is graded on cost per lead, including campaigns
 * that never optimised for leads. TOF LINK CLICK IMPRESSION takes 242k
 * impressions and 1,291 clicks for zero leads — by design — and would read KILL
 * against a lead benchmark it was never competing in.
 *
 * Keyed by campaign NAME because that is what insights returns and what the
 * sheet keys on. Names are unique within an account.
 */
function metaCampaignObjectives(token) {
  var map = {};
  try {
    var url = 'https://graph.facebook.com/' + META_API_VERSION + '/' + META_AD_ACCOUNT
      + '/campaigns?fields=name,objective,optimization_goal&limit=200'
      + '&access_token=' + encodeURIComponent(token);
    var pages = 0;
    while (url && pages < 20) {
      var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) {
        Logger.log('campaign objectives unavailable (HTTP ' + res.getResponseCode()
          + ') — creatives will be graded on whichever metric their campaign produced');
        return map;
      }
      var json = JSON.parse(res.getContentText());
      (json.data || []).forEach(function (c) {
        if (c.name) map[String(c.name)] = String(c.objective || c.optimization_goal || '');
      });
      url = json.paging && json.paging.next ? json.paging.next : null;
      pages++;
    }
    Logger.log('campaign objectives: ' + Object.keys(map).length + ' campaigns');
  } catch (e) {
    Logger.log('campaign objective lookup failed: ' + e.message);
  }
  return map;
}

/* Creative thumbnails, joined to insights on ad_id.
 *
 * Done in TWO calls rather than one. The single-call version asked for
 * `creative{thumbnail_url,image_url}` — nested field expansion, with literal
 * braces in the URL — and came back with nothing on 2026-09-23: 0 thumbnails
 * across 1,362 ad rows while ad_id was populated on every one. Expansion is the
 * fragile part, so it is avoided: fetch each ad's creative id, then fetch the
 * creatives separately and join.
 *
 * Failures log the response body, not just the status code, because "HTTP 400"
 * on its own was not enough to tell what had gone wrong.
 */
function metaCreativeThumbnails(token) {
  var adToCreative = metaFetchPaged(token, '/ads', 'id,creative', function (acc, ad) {
    if (ad.creative && ad.creative.id) acc[String(ad.id)] = String(ad.creative.id);
    return acc;
  }, {});
  var creativeCount = Object.keys(adToCreative).length;
  if (!creativeCount) {
    Logger.log('creative lookup: no ads returned — the ad table will render without images');
    return {};
  }

  /* Both sizes: thumbnail_url is a small preview for the table row, image_url
   * the full creative behind a click. Same call, so the second size is free. */
  var creativeToArt = metaFetchPaged(token, '/adcreatives', 'id,thumbnail_url,image_url',
    function (acc, c) {
      if (c.thumbnail_url || c.image_url) {
        acc[String(c.id)] = {
          thumb: c.thumbnail_url || c.image_url || '',
          full: c.image_url || c.thumbnail_url || '',
        };
      }
      return acc;
    }, {});

  var out = {};
  Object.keys(adToCreative).forEach(function (adId) {
    var art = creativeToArt[adToCreative[adId]];
    if (art) out[adId] = art;
  });
  Logger.log('creative art: ' + Object.keys(out).length + ' of ' + creativeCount + ' ads');
  return out;
}

/* Paged GET against the ad account, folding each page into an accumulator.
 * Returns whatever it managed to collect — a thumbnail failure must never take
 * down spend and leads, which are the figures in daily use. */
function metaFetchPaged(token, edge, fields, fold, acc) {
  try {
    var url = 'https://graph.facebook.com/' + META_API_VERSION + '/' + META_AD_ACCOUNT + edge
      + '?fields=' + encodeURIComponent(fields)
      + '&limit=100&access_token=' + encodeURIComponent(token);
    var pages = 0;
    while (url && pages < 30) {
      var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      var body = res.getContentText();
      if (res.getResponseCode() !== 200) {
        Logger.log(edge + ' failed (HTTP ' + res.getResponseCode() + '): '
          + metaDescribeError(body));
        return acc;
      }
      var json = JSON.parse(body);
      (json.data || []).forEach(function (row) { acc = fold(acc, row); });
      url = json.paging && json.paging.next ? json.paging.next : null;
      pages++;
    }
  } catch (e) {
    Logger.log(edge + ' threw: ' + e.message);
  }
  return acc;
}

/* Resolve the custom conversion's action_type once per run.
 *
 * A custom event named "meeting_confirmed" never appears under that name in
 * insights — it arrives as `offsite_conversion.custom.<id>`. Map name -> id
 * here so the column keeps working if the conversion is rebuilt with a new id.
 * Returns an empty list rather than throwing: a missing custom conversion must
 * not take down the spend and lead figures, which are the ones in daily use. */
function metaMeetingActionTypes(token) {
  try {
    var url = 'https://graph.facebook.com/' + META_API_VERSION + '/' + META_AD_ACCOUNT
      + '/customconversions?fields=id,name&limit=200&access_token=' + encodeURIComponent(token);
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      Logger.log('custom conversions unavailable (HTTP ' + res.getResponseCode()
        + ') — meetings will read 0');
      return [];
    }
    var wanted = String(META_MEETING_EVENT).toLowerCase();
    var out = [];
    (JSON.parse(res.getContentText()).data || []).forEach(function (c) {
      if (String(c.name || '').toLowerCase().indexOf(wanted) >= 0) {
        out.push('offsite_conversion.custom.' + c.id);
      }
    });
    Logger.log('meeting conversions matched: ' + (out.length ? out.join(', ') : 'none named "'
      + META_MEETING_EVENT + '"'));
    return out;
  } catch (e) {
    Logger.log('custom conversion lookup failed: ' + e.message + ' — meetings will read 0');
    return [];
  }
}

function metaMeetings(r, actionTypes) {
  var total = 0;
  (r.actions || []).forEach(function (a) {
    var t = String(a.action_type || '');
    if (actionTypes.indexOf(t) >= 0) total += Number(a.value || 0);
    // Also count it if Meta ever surfaces the event under a readable name.
    else if (t.toLowerCase().indexOf(String(META_MEETING_EVENT).toLowerCase()) >= 0) {
      total += Number(a.value || 0);
    }
  });
  return total;
}

/* Leads — count the `lead` action type ONLY.
 *
 * Meta's actions array carries an aggregate alongside the specific types for
 * the same conversion: `lead` plus `onsite_conversion.lead_grouped` for Instant
 * Forms, or `offsite_conversion.fb_pixel_lead` for pixel leads. Summing them
 * double counts. Caught 2026-09-23 against a hand-reconciled week where every
 * campaign came out at exactly 2x: Prospecting 8 vs 4, GUIDE 6 vs 3,
 * Retargeting 2 vs 1.
 *
 * `lead` already includes both on-site and off-site leads, so it is the whole
 * figure and nothing should be added to it.
 */
function metaLeads(r) {
  var total = 0;
  (r.actions || []).forEach(function (a) {
    if (String(a.action_type || '') === 'lead') total += Number(a.value || 0);
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
      /* Drop anything before the floor. Without this, rows written by an
       * earlier run with a wider window survive forever — the refresh only
       * replaces what it re-fetched, so March–May data would outlive the
       * decision to keep only June onward. */
      if (d < META_START_DATE) continue;
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
  var sinceStr = Utilities.formatDate(since, tz, 'yyyy-MM-dd');
  if (sinceStr < META_START_DATE) sinceStr = META_START_DATE;
  return {
    since: sinceStr,
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
