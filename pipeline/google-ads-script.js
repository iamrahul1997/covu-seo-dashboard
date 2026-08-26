/**
 * Google Ads Script — writes campaign and keyword performance into the GSC Data
 * sheet so the dashboard can read it like every other tab.
 *
 * WHY THIS AND NOT THE GOOGLE ADS API: the API needs a developer token issued to
 * a manager account and Basic access is granted by application, which takes
 * days. Ads Scripts run inside the Ads UI with the account's own permissions —
 * no token, no OAuth, no approval — and can write straight to a spreadsheet.
 *
 * SETUP
 *   1. Google Ads → Tools → Bulk actions → Scripts → + New script
 *   2. Paste this file, press Authorise, then Preview to check the log
 *   3. Save, then Frequency → Daily (early morning, after the GSC pipeline)
 *
 * Idempotent: each run refreshes the trailing LOOKBACK_DAYS window and leaves
 * anything older untouched, so re-running never duplicates or loses history.
 */

var SPREADSHEET_ID = '1IuI7NqgsrourIz1BeH44zx_Wp5_xSaGffkxYS1eYXXc';
var LOOKBACK_DAYS = 90;

var DAILY_TAB = 'ads_google_daily';
var KEYWORD_TAB = 'ads_google_keyword';

var DAILY_HEADER = ['date', 'campaign', 'impressions', 'clicks', 'cost', 'conversions', 'conversion_value'];
var KEYWORD_HEADER = ['date', 'keyword', 'match_type', 'campaign', 'impressions', 'clicks', 'cost', 'conversions'];

function main() {
  var range = dateRange(LOOKBACK_DAYS);
  Logger.log('Pulling ' + range.from + ' → ' + range.to);

  var daily = fetchDaily(range);
  Logger.log(DAILY_TAB + ': ' + daily.length + ' rows');
  writeMerged(DAILY_TAB, DAILY_HEADER, daily, 2, range);

  var keywords = fetchKeywords(range);
  Logger.log(KEYWORD_TAB + ': ' + keywords.length + ' rows');
  writeMerged(KEYWORD_TAB, KEYWORD_HEADER, keywords, 3, range);

  stampMeta();
}

/* ---------- queries ---------- */

function fetchDaily(range) {
  var gaql = 'SELECT segments.date, campaign.name, metrics.impressions, metrics.clicks,'
    + ' metrics.cost_micros, metrics.conversions, metrics.conversions_value'
    + ' FROM campaign'
    + ' WHERE segments.date BETWEEN "' + range.from + '" AND "' + range.to + '"'
    + ' AND metrics.impressions > 0';

  var rows = [];
  var it = AdsApp.search(gaql);
  while (it.hasNext()) {
    var r = it.next();
    rows.push([
      r.segments.date,
      r.campaign.name,
      Number(r.metrics.impressions || 0),
      Number(r.metrics.clicks || 0),
      micros(r.metrics.costMicros),
      round2(r.metrics.conversions),
      round2(r.metrics.conversionsValue),
    ]);
  }
  return rows;
}

function fetchKeywords(range) {
  var gaql = 'SELECT segments.date, ad_group_criterion.keyword.text,'
    + ' ad_group_criterion.keyword.match_type, campaign.name, metrics.impressions,'
    + ' metrics.clicks, metrics.cost_micros, metrics.conversions'
    + ' FROM keyword_view'
    + ' WHERE segments.date BETWEEN "' + range.from + '" AND "' + range.to + '"'
    + ' AND metrics.impressions > 0';

  var rows = [];
  var it = AdsApp.search(gaql);
  while (it.hasNext()) {
    var r = it.next();
    var kw = (r.adGroupCriterion && r.adGroupCriterion.keyword) || {};
    rows.push([
      r.segments.date,
      kw.text || '(unknown)',
      kw.matchType || '',
      r.campaign.name,
      Number(r.metrics.impressions || 0),
      Number(r.metrics.clicks || 0),
      micros(r.metrics.costMicros),
      round2(r.metrics.conversions),
    ]);
  }
  return rows;
}

/* ---------- sheet writing ---------- */

/**
 * Replaces only the rows inside the refreshed window, keyed on the first
 * `keyCols` columns, and keeps everything outside it. This is what makes a
 * daily run safe: late-attributed conversions get corrected, older history
 * survives, and nothing is ever written twice.
 */
function writeMerged(tabName, header, freshRows, keyCols, range) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(tabName) || ss.insertSheet(tabName);

  var kept = [];
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    var existing = sheet.getRange(2, 1, lastRow - 1, header.length).getValues();
    for (var i = 0; i < existing.length; i++) {
      var d = asDate(existing[i][0]);
      if (!d) continue;
      if (d < range.from || d > range.to) {
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
  if (all.length) {
    sheet.getRange(2, 1, all.length, header.length).setValues(all);
  }
  // Dates as text, so the CSV export the dashboard reads stays ISO rather than
  // being reformatted into a locale-specific string.
  sheet.getRange(2, 1, Math.max(all.length, 1), 1).setNumberFormat('@');
  Logger.log(tabName + ': kept ' + kept.length + ' older rows, wrote ' + all.length + ' total');
}

function stampMeta() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName('meta');
  if (!sheet) return;
  var keys = sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues();
  var target = -1;
  for (var i = 0; i < keys.length; i++) {
    if (String(keys[i][0]) === 'ads_google_last_run') { target = i + 1; break; }
  }
  if (target < 0) target = sheet.getLastRow() + 1;
  sheet.getRange(target, 1, 1, 2).setValues([['ads_google_last_run', new Date().toISOString()]]);
}

/* ---------- helpers ---------- */

function dateRange(days) {
  var tz = AdsApp.currentAccount().getTimeZone();
  var to = new Date();
  var from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  return {
    from: Utilities.formatDate(from, tz, 'yyyy-MM-dd'),
    to: Utilities.formatDate(to, tz, 'yyyy-MM-dd'),
  };
}

function asDate(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'UTC', 'yyyy-MM-dd');
  var s = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
}

function micros(v) { return Math.round((Number(v || 0) / 1000000) * 100) / 100; }
function round2(v) { return Math.round(Number(v || 0) * 100) / 100; }
