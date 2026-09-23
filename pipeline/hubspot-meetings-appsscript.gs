/**
 * HubSpot meetings → GSC Data sheet, as Apps Script.
 *
 * WHY THIS EXISTS: Meta reports 0 meetings for this account and always will.
 * `meeting_confirmed` needs a thank-you page, and covu.com's forms hand off to a
 * HubSpot meetings link instead — so the booking never fires an event Meta can
 * see. The real bookings only exist in HubSpot.
 *
 * WHAT IT DOES NOT DO: produce a single authoritative number. Attribution here
 * needs judgement that a script cannot make, so this writes the *evidence* —
 * one row per booking with the fields the call rests on — plus a suggested
 * attribution and a flag when the row needs a human. Read it, do not just sum
 * it.
 *
 * SETUP (once)
 *   1. HubSpot → Settings → Integrations → Private Apps. Either reuse the app
 *      already issuing HUBSPOT_TOKEN, or make a second one.
 *   2. Scopes: crm.objects.contacts.read  (analytics scopes are not enough —
 *      that is a different API).
 *   3. Apps Script → Project Settings → Script properties →
 *      HUBSPOT_TOKEN = <token>.  Never paste it into the code.
 *   4. Run hubspotBackfill() once, then add a daily trigger on hubspotMain().
 *
 * Every top-level name is prefixed `hubspot`/`HUBSPOT_` because Apps Script
 * shares ONE global namespace across files, and this project already holds the
 * nightly GSC pipeline and the Meta fetcher.
 */

var HUBSPOT_SPREADSHEET_ID = '1IuI7NqgsrourIz1BeH44zx_Wp5_xSaGffkxYS1eYXXc';
var HUBSPOT_TAB = 'hubspot_meetings';
var HUBSPOT_START_DATE = '2026-06-01';   // same floor as the Meta fetcher
var HUBSPOT_LOOKBACK_DAYS = 90;

/* The booking signal. NOT engagements_last_meeting_booked — that field is
 * last-meeting-only and empties when a meeting is cancelled, which undercounted
 * by 8 over one 7-week window (32 booking events vs 24 by the date field).
 * Bookings are counted including cancellations, per the agreed rule. */
var HUBSPOT_BOOKING_MARKER = 'meetings link';

/* Landing pages that only ever receive paid traffic. Consent gating strips UTMs
 * before HubSpot sees them, so a booking whose latest source is DIRECT_TRAFFIC
 * on one of these is Meta — that inference was validated against Meta's own
 * conversion counts (31 submissions vs 26 website-lead conversions, the gap
 * being the identifiable organic ones). */
var HUBSPOT_PAID_DESTINATIONS = [
  '/book-a-consultation-with-covu',
  '/os-lite/start',
  '/os-lite',
  '/solutions/capacity',
  '/bex-report',
  '/product/service',
  '/product/vero',
  '/product/os',
  '/licensed-agents',
];

var HUBSPOT_HEADER = [
  'booking_date', 'contact_id', 'email', 'conversion_event', 'latest_source',
  'source_detail_1', 'campaign', 'utm_source', 'utm_campaign', 'last_url',
  'meeting_booked', 'attribution', 'needs_review', 'review_reason',
];

/* Column positions, by name. Adding a column shifted these once and the run
 * log started grouping by URL instead of attribution — cheap to prevent. */
var HUBSPOT_COL = { attribution: 11, needsReview: 12 };

var HUBSPOT_PROPERTIES = [
  'email', 'createdate',
  'recent_conversion_date', 'recent_conversion_event_name',
  'first_conversion_date', 'first_conversion_event_name',
  'hs_latest_source', 'hs_latest_source_data_1', 'hs_latest_source_data_2',
  'hs_analytics_last_url', 'hs_analytics_first_url',
  'engagements_last_meeting_booked',
  /* Carried for context and campaign naming, NOT for attribution — see
   * hubspotAttribute. Verified 2026-09-23 against live records. */
  'utm_source', 'utm_medium', 'utm_campaign',
];

function hubspotMain() { hubspotRun(HUBSPOT_LOOKBACK_DAYS); }
function hubspotBackfill() { hubspotRun(3650); }

function hubspotRun(days) {
  var token = PropertiesService.getScriptProperties().getProperty('HUBSPOT_TOKEN');
  if (!token) throw new Error('HUBSPOT_TOKEN script property is not set — see setup notes at the top.');

  var since = hubspotSince(days);
  Logger.log('Pulling conversions since ' + since);

  var contacts = hubspotSearchContacts(token, since);
  Logger.log('contacts with a conversion in window: ' + contacts.length);

  var rows = [];
  contacts.forEach(function (c) {
    var p = c.properties || {};
    var event = String(p.recent_conversion_event_name || '');
    /* Filtered here rather than in the query: HubSpot's CONTAINS_TOKEN is
     * tokenised and misses "Meetings Link" reliably enough to be dangerous. The
     * volume is small, so filter locally where the rule is visible. */
    if (event.toLowerCase().indexOf(HUBSPOT_BOOKING_MARKER) < 0) return;

    var bookingDate = hubspotDay(p.recent_conversion_date);
    if (!bookingDate || bookingDate < HUBSPOT_START_DATE) return;

    /* Internal test records exist in this portal (test@covu.com, rahul@covu.com
     * and a disposable rahul+utmtest@covu.com) and would otherwise be counted
     * as bookings. */
    if (/@covu\.com$/i.test(String(p.email || ''))) return;

    var verdict = hubspotAttribute(p);
    var review = hubspotReview(p, bookingDate);

    rows.push([
      bookingDate,
      c.id,
      p.email || '',
      event,
      p.hs_latest_source || '',
      p.hs_latest_source_data_1 || '',
      /* data_2 is the campaign name and is populated for BOTH website leads and
       * GUIDE Instant Forms, unlike utm_campaign which is blank for Instant
       * Forms entirely. */
      p.hs_latest_source_data_2 || '',
      p.utm_source || '',
      p.utm_campaign || '',
      p.hs_analytics_last_url || '',
      hubspotDay(p.engagements_last_meeting_booked) || '',
      verdict,
      review ? 'YES' : '',
      review || '',
    ]);
  });

  rows.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
  hubspotWrite(rows);

  var tally = {};
  rows.forEach(function (r) {
    var k = r[HUBSPOT_COL.attribution];
    tally[k] = (tally[k] || 0) + 1;
  });
  Logger.log('bookings: ' + rows.length + ' — ' + JSON.stringify(tally));
  Logger.log('needing review: '
    + rows.filter(function (r) { return r[HUBSPOT_COL.needsReview]; }).length);
  hubspotStampRun();
}

/* ---------- attribution ---------- */

/* The rule, as agreed:
 *   - latest PAID_SOCIAL                              -> Meta
 *   - latest DIRECT_TRAFFIC on a paid landing page    -> Meta (UTMs were
 *     stripped by consent gating, not absent)
 *   - latest EMAIL_MARKETING / ORGANIC_* / Google PAID_SEARCH -> not Meta
 *
 * Judged on LATEST activity, never first touch, and never on
 * hs_analytics_source — that field flips to OFFLINE the moment Salesforce
 * touches a record, and two contacts have had it hand-edited. */
function hubspotAttribute(p) {
  var source = String(p.hs_latest_source || '').toUpperCase();
  var d1 = String(p.hs_latest_source_data_1 || '').toLowerCase();
  var url = String(p.hs_analytics_last_url || '').toLowerCase();

  if (source === 'PAID_SOCIAL') return 'Meta';
  if (source === 'PAID_SEARCH') return d1.indexOf('facebook') >= 0 ? 'Meta' : 'Google paid';
  if (source === 'EMAIL_MARKETING') return 'Email';
  if (source.indexOf('ORGANIC') === 0) return 'Organic';
  if (source === 'SOCIAL_MEDIA') return 'Organic social';
  if (source === 'REFERRALS') return 'Referral';

  if (source === 'DIRECT_TRAFFIC' || source === 'OFFLINE' || !source) {
    for (var i = 0; i < HUBSPOT_PAID_DESTINATIONS.length; i++) {
      if (url.indexOf(HUBSPOT_PAID_DESTINATIONS[i]) >= 0) return 'Meta (inferred)';
    }
    return 'Unattributed';
  }
  return source;
}

/* Rows a human has to look at. Silence here would be worse than a flag. */
function hubspotReview(p, bookingDate) {
  var meeting = hubspotDay(p.engagements_last_meeting_booked);

  /* Trap 4: a Meetings Link timestamp LATER than the meeting itself is a return
   * visit, not a new booking. Dating by it once pushed a week to a 125%
   * booking rate. */
  if (meeting && meeting < bookingDate) {
    return 'conversion dated ' + bookingDate + ' but meeting was ' + meeting
      + ' — likely a return visit; re-date to the original submit';
  }
  /* UTM properties persist from an earlier touch and are NOT refreshed by a
   * later conversion. One live record carries utm_source=google /
   * utm_campaign=KB_Brand while its latest conversion is a Facebook GUIDE lead
   * ad — attributing on the UTM would file it under Google. Latest source wins;
   * the disagreement is surfaced rather than silently resolved. */
  var utmSource = String(p.utm_source || '').toLowerCase();
  var latest = String(p.hs_latest_source || '').toUpperCase();
  var utmSaysMeta = utmSource.indexOf('facebook') >= 0 || utmSource.indexOf('meta') >= 0
    || utmSource.indexOf('instagram') >= 0;
  if (utmSource && latest === 'PAID_SOCIAL' && !utmSaysMeta) {
    return 'utm_source=' + utmSource + ' contradicts latest source PAID_SOCIAL — '
      + 'stale UTMs from an earlier touch; attributed on latest activity';
  }
  if (utmSource && utmSaysMeta && latest && latest !== 'PAID_SOCIAL' && latest !== 'DIRECT_TRAFFIC') {
    return 'utm_source=' + utmSource + ' says Meta but latest source is ' + latest
      + ' — check which touch actually drove the booking';
  }

  if (latest === 'OFFLINE') {
    return 'latest source is OFFLINE (Salesforce touched the record) — judge on last_url';
  }
  if (!p.hs_latest_source && !p.hs_analytics_last_url) {
    return 'no source and no last URL — nothing to attribute on';
  }
  return '';
}

/* ---------- HubSpot API ---------- */

function hubspotSearchContacts(token, since) {
  var url = 'https://api.hubapi.com/crm/v3/objects/contacts/search';
  var out = [];
  var after = null;
  var pages = 0;

  while (pages < 50) {
    var body = {
      /* Filter on the CONVERSION date, never createdate — a contact created in
       * 2025 who converts during a campaign would otherwise vanish from the
       * count. That single mistake undercounted by 6. */
      filterGroups: [{
        filters: [{
          propertyName: 'recent_conversion_date',
          operator: 'GTE',
          value: String(new Date(since + 'T00:00:00Z').getTime()),
        }],
      }],
      properties: HUBSPOT_PROPERTIES,
      limit: 100,
    };
    if (after) body.after = after;

    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { authorization: 'Bearer ' + token },
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
    });

    if (res.getResponseCode() !== 200) {
      var msg = res.getContentText();
      try { msg = JSON.parse(msg).message; } catch (e) { /* keep raw */ }
      throw new Error('HubSpot HTTP ' + res.getResponseCode() + ': ' + msg
        + (res.getResponseCode() === 403
          ? ' — the private app needs the crm.objects.contacts.read scope' : ''));
    }

    var json = JSON.parse(res.getContentText());
    (json.results || []).forEach(function (r) { out.push(r); });
    after = json.paging && json.paging.next ? json.paging.next.after : null;
    pages++;
    if (!after) break;
    Utilities.sleep(150);   // stay well inside the rate limit
  }
  return out;
}

/* ---------- sheet writing ---------- */

function hubspotWrite(rows) {
  var ss = SpreadsheetApp.openById(HUBSPOT_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(HUBSPOT_TAB) || ss.insertSheet(HUBSPOT_TAB);
  sheet.clear();
  sheet.getRange(1, 1, 1, HUBSPOT_HEADER.length).setValues([HUBSPOT_HEADER]);
  if (rows.length) {
    // Text format BEFORE the write, or Sheets coerces the ISO date into the
    // spreadsheet locale and the dashboard's reader drops the row.
    sheet.getRange(2, 1, rows.length, 1).setNumberFormat('@');
    sheet.getRange(2, 1, rows.length, HUBSPOT_HEADER.length).setValues(rows);
  }
  Logger.log(HUBSPOT_TAB + ': wrote ' + rows.length + ' rows');
}

function hubspotStampRun() {
  var ss = SpreadsheetApp.openById(HUBSPOT_SPREADSHEET_ID);
  var sheet = ss.getSheetByName('meta');
  if (!sheet) return;
  var last = sheet.getLastRow();
  if (last < 1) {
    sheet.getRange(1, 1, 1, 2).setValues([['hubspot_meetings_last_run', new Date().toISOString()]]);
    return;
  }
  var keys = sheet.getRange(1, 1, last, 1).getValues();
  var target = -1;
  for (var i = 0; i < keys.length; i++) {
    if (String(keys[i][0]) === 'hubspot_meetings_last_run') { target = i + 1; break; }
  }
  if (target < 0) target = last + 1;
  sheet.getRange(target, 1, 1, 2).setValues([['hubspot_meetings_last_run', new Date().toISOString()]]);
}

/* ---------- helpers ---------- */

function hubspotSince(days) {
  var tz = Session.getScriptTimeZone() || 'UTC';
  var d = new Date(new Date().getTime() - days * 24 * 60 * 60 * 1000);
  var s = Utilities.formatDate(d, tz, 'yyyy-MM-dd');
  return s < HUBSPOT_START_DATE ? HUBSPOT_START_DATE : s;
}

/* HubSpot returns datetimes as epoch milliseconds or ISO, depending on the
 * property and the API version. Handle both rather than trusting one. */
function hubspotDay(v) {
  if (v === null || v === undefined || v === '') return '';
  var s = String(v).trim();
  if (/^\d{10,}$/.test(s)) {
    return Utilities.formatDate(new Date(Number(s)), 'UTC', 'yyyy-MM-dd');
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  var parsed = new Date(s);
  return isNaN(parsed.getTime()) ? '' : Utilities.formatDate(parsed, 'UTC', 'yyyy-MM-dd');
}
