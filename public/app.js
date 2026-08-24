/* COVU SEO & AEO dashboard.
 *
 * Rebuilt 2026-08-24. Deliberately un-minified: the previous build shipped only
 * as minified output with no source anywhere, which is why it could not be
 * fixed in place.
 */

var D = null;                 // payload from /api/data
var RANGE = '13';             // weeks in the window, or null when custom
var CUSTOM = null;            // {a, b} week indices when the date pickers drive
var COMPARE = 'prev';
var TAB = 'overview';
var QFILTER = 'all';          // all | brand | nonbrand | questions
var BFILTER = 'all';

var TABS = [
  ['overview', 'Overview'],
  ['queries', 'Queries'],
  ['pages', 'Pages'],
  ['blog', 'Blog'],
  ['aeo', 'AEO Lens'],
];

var RANGES = [['4', '28 days'], ['13', '3 months'], ['26', '6 months'], ['52', '12 months']];

/* Brand matching.
 *
 * The previous build did this with new RegExp("\bcovu\b") — built from a
 * string, so \b became a literal backspace character and the pattern matched
 * nothing at all. Every query was classified non-branded and the Overview
 * reported "Non-branded is 100% of clicks" when the real figure was ~2%.
 *
 * A regex literal keeps \b meaning word boundary. We match "covu" anywhere, plus
 * the two spacing variants people actually type. Misspellings (covou, covo,
 * covve) stay non-branded on purpose — covve is a different company.
 */
var BRAND = /covu|co\.vu|co vu/i;

/* Question-shaped queries, the ones answer engines tend to absorb. */
var QUESTION_MARKERS = [' how ', ' how to', ' what', ' why', ' when', ' where', ' who',
  ' which', ' can ', ' do i', ' does', ' is ', ' are ', ' should', ' cost', ' vs ',
  ' difference', ' guide', ' best '];

function isQuestion(text) {
  var t = ' ' + String(text).toLowerCase().trim() + ' ';
  for (var i = 0; i < QUESTION_MARKERS.length; i++) {
    if (t.indexOf(QUESTION_MARKERS[i]) >= 0) return true;
  }
  return false;
}

/* ---------- small helpers ---------- */

function E(id) { return document.getElementById(id); }

function F(n) {
  n = Math.round(n || 0);
  return n >= 1000 ? n.toLocaleString('en-US') : String(n);
}

function F1(n) { return (Math.round((n || 0) * 10) / 10).toLocaleString('en-US'); }

function esc(s) {
  return String(s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

function pctChip(now, before) {
  if (!before) return '<span class="chip fl">new</span>';
  var pct = (now - before) / before * 100;
  var up = pct >= 0;
  return '<span class="chip ' + (up ? 'up' : 'dn') + '">' + (up ? '▲ +' : '▼ ') + F1(Math.abs(pct)) + '%</span>';
}

function ptChip(now, before) {
  var diff = now - before;
  if (Math.abs(diff) < 0.05) return '<span class="chip fl">± 0.0 pts</span>';
  var up = diff >= 0;
  return '<span class="chip ' + (up ? 'up' : 'dn') + '">' + (up ? '▲ +' : '▼ ') + F1(Math.abs(diff)) + ' pts</span>';
}

/* Lower average position is better, so the arrow is inverted here. */
function posChip(now, before) {
  var diff = before - now;
  var up = diff >= 0;
  return '<span class="chip ' + (up ? 'up' : 'dn') + '">' + (up ? '▲ ' : '▼ ') + F1(Math.abs(diff)) + '</span>';
}

function fmtDate(iso) {
  return new Date(iso + 'T00:00:00Z')
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function weekEnd(iso) {
  var d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}

function kpi(title, value, chip, from) {
  return '<div class="kpi g"><div class="t">' + title + '</div><div class="v">' + value + '</div>'
    + '<div>' + chip + '<span class="frm">from ' + from + '</span></div></div>';
}

/* ---------- range maths ---------- */

/* The window never runs past the last COMPLETE week unless the user drags the
 * date pickers there themselves. Search Console lags ~3 days, so the newest
 * week is always still filling; including it made every range end on a fake
 * decline. meta.lastCompleteWeek is computed server-side from day counts. */
function lastUsableWeek(data) {
  return data.meta && typeof data.meta.lastCompleteWeek === 'number'
    ? data.meta.lastCompleteWeek
    : data.weeks.length - 1;
}

function windowRange() {
  var total = D.weeks.length;
  var a, b;
  if (CUSTOM) {
    a = CUSTOM.a;
    b = CUSTOM.b;
  } else {
    b = lastUsableWeek(D);
    a = b - (Math.min(+RANGE, b + 1) - 1);
  }
  a = Math.max(0, Math.min(a, total - 1));
  b = Math.max(a, Math.min(b, total - 1));

  var span = b - a + 1;
  var pa, pb, valid = true;
  if (COMPARE === 'none') {
    valid = false;
  } else if (COMPARE === 'year') {
    pa = a - 52; pb = b - 52; valid = pa >= 0;
  } else {
    pa = a - span; pb = a - 1; valid = pa >= 0;
  }
  return { a: a, b: b, pa: Math.max(0, pa), pb: pb, valid: valid, span: span };
}

/* Any partial weeks inside the current window, so we can say so out loud. */
function partialWeeksIn(a, b, weeks, weekDays) {
  var out = [];
  for (var i = a; i <= b; i++) {
    if (weekDays && weekDays[i] < 7) out.push({ week: weeks[i], days: weekDays[i] });
  }
  return out;
}

function sumTotals(totals, a, b) {
  var c = 0, imp = 0, posWeighted = 0;
  for (var i = a; i <= b; i++) {
    var row = totals[i];
    if (!row) continue;
    c += row[0];
    imp += row[1];
    posWeighted += row[2] / 100 * row[1];
  }
  return { c: c, i: imp, ct: imp ? c / imp * 100 : 0, po: imp ? posWeighted / imp : 0 };
}

/* Rolls the weekly [week, stringId, clicks, impressions, position*100] rows up
 * into one entry per query/page across the selected window. */
function aggregate(strings, rows, a, b, classify) {
  var byKey = {};
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r[0] < a || r[0] > b) continue;
    var key = strings[r[1]];
    var e = byKey[key];
    if (!e) { e = { k: key, c: 0, i: 0, w: 0 }; byKey[key] = e; }
    e.c += r[2];
    e.i += r[3];
    e.w += r[4] / 100 * r[3];
  }
  var out = [];
  for (var k in byKey) {
    var e = byKey[k];
    e.ct = e.i ? e.c / e.i * 100 : 0;
    e.po = e.i ? e.w / e.i : 0;
    if (classify) {
      e.brand = BRAND.test(e.k);
      e.question = isQuestion(e.k);
    }
    out.push(e);
  }
  return out;
}

/* Weekly series out of a dimension table ({keys, rows:[keyIdx, week, ...]}). */
function dimSeries(dim, keyIndex, a, b, valueIdx) {
  var series = [];
  for (var i = a; i <= b; i++) series.push(0);
  for (var j = 0; j < dim.rows.length; j++) {
    var r = dim.rows[j];
    if (r[0] !== keyIndex || r[1] < a || r[1] > b) continue;
    series[r[1] - a] += r[valueIdx];
  }
  return series;
}

function dimTotals(dim, a, b) {
  var out = dim.keys.map(function (k) { return { k: k, c: 0, i: 0, w: 0 }; });
  for (var j = 0; j < dim.rows.length; j++) {
    var r = dim.rows[j];
    if (r[1] < a || r[1] > b) continue;
    var e = out[r[0]];
    if (!e) continue;
    e.c += r[2]; e.i += r[3]; e.w += r[4] / 100 * r[3];
  }
  out.forEach(function (e) {
    e.ct = e.i ? e.c / e.i * 100 : 0;
    e.po = e.i ? e.w / e.i : 0;
  });
  return out.filter(function (e) { return e.i > 0; }).sort(function (x, y) { return y.c - x.c; });
}

/* ---------- chart ---------- */

/* Area chart. Weeks flagged partial are drawn hollow so an unfinished week can
 * never be read as a real dip. */
function chart(values, labels, partialFlags, color) {
  if (!values.length) return '<div class="note">No data in range</div>';
  var max = Math.max.apply(null, values) || 1;
  var n = values.length;
  var stroke = color || '#1C2945';
  var x = function (i) { return 6 + 888 * (n === 1 ? 0.5 : i / (n - 1)); };
  var y = function (v) { return 144 - v / max * 130; };

  var line = '', area = 'M' + x(0) + ' ' + y(values[0]);
  for (var i = 0; i < n; i++) {
    line += (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(values[i]).toFixed(1) + ' ';
    area += ' L' + x(i).toFixed(1) + ' ' + y(values[i]).toFixed(1);
  }
  area += ' L' + x(n - 1) + ' 144 L' + x(0) + ' 144 Z';

  var dots = '';
  for (var j = 0; j < n; j++) {
    var isPartial = partialFlags && partialFlags[j];
    if (j === n - 1 || isPartial) {
      dots += '<circle cx="' + x(j).toFixed(1) + '" cy="' + y(values[j]).toFixed(1) + '" r="4" '
        + 'fill="' + (isPartial ? '#fff' : '#FFB703') + '" stroke="' + stroke + '" stroke-width="1.5"><title>'
        + esc(labels[j] || '') + ': ' + F(values[j]) + (isPartial ? ' (partial week)' : '') + '</title></circle>';
    }
  }

  return '<svg viewBox="0 0 900 150" width="100%" height="150" preserveAspectRatio="none" style="overflow:visible">'
    + '<defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0" stop-color="' + stroke + '" stop-opacity=".22"/>'
    + '<stop offset="1" stop-color="' + stroke + '" stop-opacity="0"/></linearGradient></defs>'
    + '<path d="' + area + '" fill="url(#ag)"/>'
    + '<path d="' + line + '" fill="none" stroke="' + stroke + '" stroke-width="2.5" stroke-linejoin="round"/>'
    + dots + '</svg>';
}

/* ---------- tables ---------- */

function brandChip(isBrand) {
  return '<span class="chip ' + (isBrand ? 'br' : 'nb') + '" style="font-size:10px;padding:2px 7px">'
    + (isBrand ? 'brand' : 'non-brand') + '</span>';
}

function metricTable(rows, kind, limit) {
  if (!rows.length) return '<div class="note">No data in range</div>';
  var showBrand = kind === 'query';
  var head = '<div class="tw"><table><thead><tr><th>' + (showBrand ? 'Query' : 'Page') + '</th>'
    + (showBrand ? '<th>Type</th>' : '')
    + '<th>Clicks</th><th>Impr.</th><th>CTR</th><th>Pos.</th></tr></thead><tbody>';
  var body = rows.slice(0, limit || 25).map(function (r) {
    var label = showBrand ? r.k : (r.k.replace(/^https?:\/\/[^/]+/, '') || '/');
    return '<tr><td class="q" title="' + esc(r.k) + '">' + esc(label) + '</td>'
      + (showBrand ? '<td style="text-align:left">' + brandChip(r.brand) + '</td>' : '')
      + '<td>' + F(r.c) + '</td><td>' + F(r.i) + '</td>'
      + '<td>' + F1(r.ct) + '%</td><td class="p">' + F1(r.po) + '</td></tr>';
  }).join('');
  return head + body + '</tbody></table></div>';
}

function pairTable(rows, limit) {
  if (!rows.length) return '<div class="note">No query/page pairs in this window</div>';
  return '<div class="tw"><table><thead><tr><th>Query</th><th>Lands on</th><th>Clicks</th><th>Impr.</th>'
    + '<th>CTR</th><th>Pos.</th></tr></thead><tbody>'
    + rows.slice(0, limit || 20).map(function (r) {
      var page = r.p.replace(/^https?:\/\/[^/]+/, '') || '/';
      return '<tr><td class="q" title="' + esc(r.q) + '">' + esc(r.q) + '</td>'
        + '<td class="q2" title="' + esc(r.p) + '">' + esc(page) + '</td>'
        + '<td>' + F(r.c) + '</td><td>' + F(r.i) + '</td>'
        + '<td>' + F1(r.ct) + '%</td><td class="p">' + F1(r.po) + '</td></tr>';
    }).join('') + '</tbody></table></div>';
}

function dimTable(rows, label) {
  if (!rows.length) return '<div class="note">No data in range</div>';
  return '<div class="tw"><table><thead><tr><th>' + label + '</th><th>Clicks</th><th>Impr.</th>'
    + '<th>CTR</th><th>Pos.</th></tr></thead><tbody>'
    + rows.map(function (r) {
      return '<tr><td style="font-weight:700">' + esc(r.k) + '</td><td>' + F(r.c) + '</td>'
        + '<td>' + F(r.i) + '</td><td>' + F1(r.ct) + '%</td><td class="p">' + F1(r.po) + '</td></tr>';
    }).join('') + '</tbody></table></div>';
}

/* ---------- panels ---------- */

function renderPartialNotice(w) {
  var partials = partialWeeksIn(w.a, w.b, D.weeks, D.weekDays);
  if (!partials.length) { E('partial').innerHTML = ''; return; }
  var p = partials[partials.length - 1];
  E('partial').innerHTML = '<div class="warn"><span class="ic">⚠</span><span>'
    + 'This range includes the week of <b>' + fmtDate(p.week) + '</b>, which currently holds only '
    + '<b>' + p.days + ' of 7 days</b> of data — Search Console lags about '
    + (D.meta.dataLagDays || 3) + ' days. Its totals are not comparable to the full weeks around it. '
    + 'Clear the custom dates to snap back to the last complete week.</span></div>';
}

function renderOverview(w, now, before, queries) {
  var impr = [], clicks = [], labels = [], partialFlags = [];
  for (var i = w.a; i <= w.b; i++) {
    impr.push(D.totals[i] ? D.totals[i][1] : 0);
    clicks.push(D.totals[i] ? D.totals[i][0] : 0);
    labels.push('Week of ' + fmtDate(D.weeks[i]));
    partialFlags.push(D.weekDays[i] < 7);
  }

  var brandClicks = 0, nonBrandClicks = 0, brandImpr = 0, nonBrandImpr = 0;
  queries.forEach(function (q) {
    if (q.brand) { brandClicks += q.c; brandImpr += q.i; }
    else { nonBrandClicks += q.c; nonBrandImpr += q.i; }
  });
  var totalClicks = brandClicks + nonBrandClicks || 1;
  var totalImpr = brandImpr + nonBrandImpr || 1;
  var nonBrandPct = nonBrandClicks / totalClicks * 100;
  var nonBrandImprPct = nonBrandImpr / totalImpr * 100;

  var channels = renderChannelMix(w);

  E('p-overview').innerHTML =
    '<div class="card g"><h2>Weekly impressions</h2>'
    + '<div class="sub">Selected range · ' + impr.length + ' weeks'
    + (partialFlags.some(Boolean) ? ' · hollow dot = partial week' : '') + '</div>'
    + chart(impr, labels, partialFlags) + '</div>'

    + '<div class="card g"><h2>Weekly clicks</h2>'
    + '<div class="sub">Same range, click volume</div>'
    + chart(clicks, labels, partialFlags, '#219EBC') + '</div>'

    + '<div class="g2">'
    + '<div class="card g"><h2>Branded vs non-branded</h2>'
    + '<div class="sub">Share of clicks from query-level data</div>'
    + '<div class="brow"><span>Branded</span><div class="bar by"><span style="width:'
    + (brandClicks / totalClicks * 100).toFixed(1) + '%"></span></div><span>' + F(brandClicks) + '</span></div>'
    + '<div class="brow"><span>Non-branded</span><div class="bar bn"><span style="width:'
    + nonBrandPct.toFixed(1) + '%"></span></div><span>' + F(nonBrandClicks) + '</span></div>'
    + '<div class="note">Non-branded is <b>' + F1(nonBrandPct) + '%</b> of clicks but <b>'
    + F1(nonBrandImprPct) + '%</b> of impressions — people who do not already know COVU see the site '
    + 'and mostly do not click. That gap is the answer-engine surface.</div></div>'

    + '<div class="card g"><h2>Read on the range</h2><div class="sub">&nbsp;</div>'
    + '<div style="font:600 14px/1.6 Nunito Sans">' + narrative(w, now, before) + '</div></div>'
    + '</div>'

    + channels;
}

function narrative(w, now, before) {
  if (!w.valid) {
    return 'Showing <b>' + fmtDate(D.weeks[w.a]) + '</b> to <b>' + fmtDate(weekEnd(D.weeks[w.b]))
      + '</b> with no comparison window selected. Clicks <b>' + F(now.c) + '</b>, impressions <b>'
      + F(now.i) + '</b>, average position <b>' + F1(now.po) + '</b>.';
  }
  var clickPct = before.c ? (now.c - before.c) / before.c * 100 : 0;
  var imprPct = before.i ? (now.i - before.i) / before.i * 100 : 0;
  var posWord = before.po && now.po < before.po ? 'improved' : (now.po > before.po ? 'slipped' : 'held');
  var text = 'Average position ' + posWord + ' from <b>' + F1(before.po) + '</b> to <b>' + F1(now.po)
    + '</b>. Clicks ' + (clickPct >= 0 ? 'rose ' : 'fell ') + '<b>' + F1(Math.abs(clickPct))
    + '%</b> and impressions ' + (imprPct >= 0 ? 'rose ' : 'fell ') + '<b>' + F1(Math.abs(imprPct))
    + '%</b> against the comparison window.';
  if (imprPct > 0 && clickPct <= 0) {
    text += ' Impressions up while clicks are not is the zero-click signature — the result is being '
      + 'shown and read without the visit.';
  }
  return text;
}

function renderChannelMix(w) {
  if (!D.ga || !D.ga.channels.length) return '';
  var totals = {};
  D.ga.rows.forEach(function (r) {
    if (r[1] < w.a || r[1] > w.b) return;
    totals[r[0]] = (totals[r[0]] || 0) + r[2];
  });
  var rows = Object.keys(totals).map(function (idx) {
    return { k: D.ga.channels[idx], s: totals[idx], ai: +idx === D.ga.aiChannel };
  }).sort(function (a, b) { return b.s - a.s; });
  if (!rows.length) return '';
  var max = rows[0].s || 1;
  var sum = rows.reduce(function (a, r) { return a + r.s; }, 0);

  return '<div class="card g"><h2>Traffic mix (GA4)</h2>'
    + '<div class="sub">Sessions by channel across the same weeks · ' + F(sum) + ' sessions</div>'
    + rows.map(function (r) {
      return '<div class="brow"><span>' + esc(r.k) + '</span>'
        + '<div class="bar ' + (r.ai ? 'bt' : 'bn') + '"><span style="width:'
        + (r.s / max * 100).toFixed(1) + '%"></span></div><span>' + F(r.s) + '</span></div>';
    }).join('')
    + '<div class="note">GA4 reports assistant referrals (ChatGPT, Perplexity, Copilot and similar) '
    + 'under the <b>AI Assistant</b> channel, highlighted above. It is the only first-party measure of '
    + 'answer-engine traffic available — see the AEO Lens tab.</div></div>';
}

function renderQueries(queries) {
  var rows = queries.slice();
  if (QFILTER === 'brand') rows = rows.filter(function (r) { return r.brand; });
  else if (QFILTER === 'nonbrand') rows = rows.filter(function (r) { return !r.brand; });
  else if (QFILTER === 'questions') rows = rows.filter(function (r) { return r.question; });
  rows.sort(function (a, b) { return b.c - a.c || b.i - a.i; });

  var buttons = [['all', 'All'], ['brand', 'Branded'], ['nonbrand', 'Non-branded'], ['questions', 'Questions']];
  E('p-queries').innerHTML = '<div class="card g"><h2>Top queries</h2>'
    + '<div class="sub">Ranked by clicks · ' + F(rows.length) + ' queries match this filter</div>'
    + '<div class="filters" id="qfilters">'
    + buttons.map(function (b) {
      return '<button data-f="' + b[0] + '"' + (QFILTER === b[0] ? ' class="on"' : '') + '>' + b[1] + '</button>';
    }).join('') + '</div>'
    + metricTable(rows, 'query', 40)
    + '<div class="note">Branded = the query contains <b>covu</b>, <b>co.vu</b> or <b>co vu</b>. '
    + 'Query-level rows cover roughly two thirds of clicks; Search Console withholds the rest to protect '
    + 'rare queries, so these will not sum to the totals above.</div></div>';

  E('qfilters').onclick = function (ev) {
    var btn = ev.target.closest('button');
    if (!btn) return;
    QFILTER = btn.dataset.f;
    render();
  };
}

function renderPages(w) {
  var pages = aggregate(D.pStr, D.pW, w.a, w.b, false)
    .sort(function (a, b) { return b.c - a.c; });
  var pairs = (D.queryPage || []).slice(0, 25);
  E('p-pages').innerHTML = '<div class="card g"><h2>Top pages</h2>'
    + '<div class="sub">Ranked by clicks in the selected range</div>'
    + metricTable(pages, 'page', 40) + '</div>'
    + '<div class="g2">'
    + '<div class="card g"><h2>Device</h2><div class="sub">Clicks by device in range</div>'
    + dimTable(dimTotals(D.device, w.a, w.b), 'Device') + '</div>'
    + '<div class="card g"><h2>Country</h2><div class="sub">Top markets in range</div>'
    + dimTable(dimTotals(D.country, w.a, w.b).slice(0, 10), 'Country') + '</div>'
    + '</div>'
    + '<div class="card g"><h2>Which query lands on which page</h2>'
    + '<div class="sub">Rolling ' + (D.meta.queryPageWindow || 90) + '-day window · not filtered by the range above</div>'
    + pairTable(pairs, 25) + '</div>';
}

/* The blog tab. The old build showed four KPIs and a list of 15 queries with a
 * "full range-control coming next" note. blog.covu.com is its own Search Console
 * property, so it gets its own week index and its own complete-week logic. */
function renderBlog() {
  var b = D.blog;
  if (!b || !b.weeks.length) {
    E('p-blog').innerHTML = '<div class="card g"><h2>Blog</h2>'
      + '<div class="note">' + esc(D.meta.blogProperty || 'blog.covu.com') + ' has no data yet.</div></div>';
    return;
  }

  /* The blog property only started collecting in March, so a fixed 13-week
   * window leaves no room for a comparison period. Halve the available history
   * instead, so the window and its comparison both fit. */
  var last = b.lastCompleteWeek;
  var span = Math.min(13, Math.max(4, Math.floor((last + 1) / 2)));
  var a = Math.max(0, last - span + 1);
  var pa = Math.max(0, a - span), pb = a - 1;
  var hasCompare = a - span >= 0;

  var now = sumTotals(b.totals, a, last);
  var before = hasCompare ? sumTotals(b.totals, pa, pb) : { c: 0, i: 0, ct: 0, po: 0 };

  var impr = [], labels = [], flags = [];
  for (var i = a; i <= last; i++) {
    impr.push(b.totals[i] ? b.totals[i][1] : 0);
    labels.push('Week of ' + fmtDate(b.weeks[i]));
    flags.push(b.weekDays[i] < 7);
  }

  var posts = aggregate(b.pStr, b.pW, a, last, false).sort(function (x, y) { return y.c - x.c; });
  var queries = aggregate(b.qStr, b.qW, a, last, true).sort(function (x, y) { return y.c - x.c; });
  var filtered = queries.slice();
  if (BFILTER === 'brand') filtered = filtered.filter(function (r) { return r.brand; });
  else if (BFILTER === 'nonbrand') filtered = filtered.filter(function (r) { return !r.brand; });
  else if (BFILTER === 'questions') filtered = filtered.filter(function (r) { return r.question; });

  var brandClicks = 0, nonBrandClicks = 0;
  queries.forEach(function (q) { q.brand ? brandClicks += q.c : nonBrandClicks += q.c; });
  var blogTotal = brandClicks + nonBrandClicks || 1;

  /* Posts that are seen a lot and clicked rarely — the rewrite shortlist. */
  var underperformers = posts.filter(function (p) { return p.i >= 100 && p.ct < 1.5; })
    .sort(function (x, y) { return y.i - x.i; }).slice(0, 12);

  var filterButtons = [['all', 'All'], ['brand', 'Branded'], ['nonbrand', 'Non-branded'], ['questions', 'Questions']];

  var noCmp = '<span class="chip fl">—</span>';
  E('p-blog').innerHTML =
    '<div class="k4">'
    + kpi('Blog clicks', F(now.c), hasCompare ? pctChip(now.c, before.c) : noCmp, hasCompare ? F(before.c) : 'no prior window')
    + kpi('Blog impressions', F(now.i), hasCompare ? pctChip(now.i, before.i) : noCmp, hasCompare ? F(before.i) : 'no prior window')
    + kpi('Blog CTR', F1(now.ct) + '%', hasCompare ? ptChip(now.ct, before.ct) : noCmp, hasCompare ? F1(before.ct) + '%' : 'no prior window')
    + kpi('Blog position', F1(now.po), hasCompare ? posChip(now.po, before.po) : noCmp, hasCompare ? F1(before.po) : 'no prior window')
    + '</div>'

    + '<div class="card g"><h2>Blog impressions by week</h2>'
    + '<div class="sub">' + esc(D.meta.blogProperty || 'blog.covu.com') + ' · '
    + fmtDate(b.weeks[a]) + ' → ' + fmtDate(weekEnd(b.weeks[last]))
    + (flags.some(Boolean) ? ' · hollow dot = partial week' : '') + '</div>'
    + chart(impr, labels, flags, '#11426B') + '</div>'

    + '<div class="card g"><h2>Top posts</h2>'
    + '<div class="sub">Every blog URL with search traffic in this window · ' + posts.length + ' posts</div>'
    + metricTable(posts, 'page', 30) + '</div>'

    + '<div class="g2">'
    + '<div class="card g"><h2>Branded vs non-branded</h2>'
    + '<div class="sub">Blog search demand by intent</div>'
    + '<div class="brow"><span>Branded</span><div class="bar by"><span style="width:'
    + (brandClicks / blogTotal * 100).toFixed(1) + '%"></span></div><span>' + F(brandClicks) + '</span></div>'
    + '<div class="brow"><span>Non-branded</span><div class="bar bn"><span style="width:'
    + (nonBrandClicks / blogTotal * 100).toFixed(1) + '%"></span></div><span>' + F(nonBrandClicks) + '</span></div>'
    + '<div class="note">The blog is the part of the estate that can win non-branded demand, so this '
    + 'split is the one to watch — unlike the main site, where brand dominates by design.</div></div>'

    + '<div class="card g"><h2>Reach without clicks</h2>'
    + '<div class="sub">100+ impressions, under 1.5% CTR — title and snippet candidates</div>'
    + (underperformers.length ? metricTable(underperformers, 'page', 12)
      : '<div class="note">No posts match — every post with real reach is converting acceptably.</div>')
    + '</div></div>'

    + '<div class="card g"><h2>Blog queries</h2>'
    + '<div class="sub">What people searched before landing on the blog · ' + filtered.length + ' match this filter</div>'
    + '<div class="filters" id="bfilters">'
    + filterButtons.map(function (f) {
      return '<button data-f="' + f[0] + '"' + (BFILTER === f[0] ? ' class="on"' : '') + '>' + f[1] + '</button>';
    }).join('') + '</div>'
    + metricTable(filtered, 'query', 30) + '</div>'

    + '<div class="card g"><h2>Query → post</h2>'
    + '<div class="sub">Which post actually answers each query · rolling '
    + (D.meta.queryPageWindow || 90) + '-day window</div>'
    + pairTable(b.queryPage, 25) + '</div>'

    + '<div class="g2">'
    + '<div class="card g"><h2>Blog device</h2><div class="sub">Clicks by device</div>'
    + dimTable(dimTotals(b.device, a, last), 'Device') + '</div>'
    + '<div class="card g"><h2>Blog markets</h2><div class="sub">Top countries</div>'
    + dimTable(dimTotals(b.country, a, last).slice(0, 10), 'Country') + '</div>'
    + '</div>';

  E('bfilters').onclick = function (ev) {
    var btn = ev.target.closest('button');
    if (!btn) return;
    BFILTER = btn.dataset.f;
    render();
  };
}

function renderAEO(w, queries) {
  var ga = D.ga || { channels: [], rows: [], aiChannel: -1, aiLanding: [] };

  /* AI-assistant sessions week by week. */
  var aiBlock = '';
  if (ga.aiChannel >= 0) {
    var series = dimSeries({ keys: ga.channels, rows: ga.rows }, ga.aiChannel, w.a, w.b, 2);
    var labels = [], flags = [];
    for (var i = w.a; i <= w.b; i++) {
      labels.push('Week of ' + fmtDate(D.weeks[i]));
      flags.push(D.weekDays[i] < 7);
    }
    var total = series.reduce(function (a, b) { return a + b; }, 0);
    var allSessions = 0;
    ga.rows.forEach(function (r) { if (r[1] >= w.a && r[1] <= w.b) allSessions += r[2]; });
    aiBlock = '<div class="card g"><h2>AI assistant sessions</h2>'
      + '<div class="sub">GA4 “AI Assistant” channel — ChatGPT, Perplexity, Copilot and similar · '
      + F(total) + ' sessions in range ('
      + (allSessions ? F1(total / allSessions * 100) : '0') + '% of all traffic)</div>'
      + chart(series, labels, flags, '#219EBC')
      + (ga.aiLanding && ga.aiLanding.length
        ? '<div class="tw" style="margin-top:14px"><table><thead><tr><th>Assistants land people on</th>'
          + '<th>Sessions</th><th>Engaged</th><th>Users</th></tr></thead><tbody>'
          + ga.aiLanding.slice(0, 15).map(function (r) {
            return '<tr><td class="q" title="' + esc(r.l) + '">' + esc(r.l) + '</td><td>' + F(r.s)
              + '</td><td>' + F(r.e) + '</td><td>' + F(r.u) + '</td></tr>';
          }).join('') + '</tbody></table></div>'
        : '')
      + '<div class="note">Volume here is small but it is the real thing: sessions where an AI assistant '
      + 'sent the visitor. Everything else on this tab is a proxy inferred from Search Console.</div></div>';
  }

  /* Question queries that get impressions and almost no clicks. */
  var gap = queries.filter(function (q) { return q.question && q.i >= 30 && q.ct < 1; })
    .sort(function (a, b) { return b.i - a.i; }).slice(0, 20);

  var appearance = D.searchAppearance || [];

  /* Conversion layer, when HubSpot is wired up. */
  var hs = D.hubspot || { connected: false, reason: 'not configured' };
  var hsBlock = '<div class="card g"><h2>Conversions (HubSpot)</h2>'
    + '<div class="sub">What the traffic actually did once it arrived</div>';
  if (hs.connected && hs.rows && hs.rows.length) {
    hsBlock += '<div class="tw"><table><thead><tr><th>Page</th><th>Views</th><th>Submissions</th>'
      + '<th>Contacts</th><th>Bounce</th></tr></thead><tbody>'
      + hs.rows.slice(0, 20).map(function (r) {
        return '<tr><td class="q" title="' + esc(r.k) + '">' + esc(r.k) + '</td><td>' + F(r.views)
          + '</td><td>' + F(r.subs) + '</td><td>' + F(r.contacts) + '</td><td class="p">'
          + F1(r.bounce) + '%</td></tr>';
      }).join('') + '</tbody></table></div>';
  } else {
    hsBlock += '<div class="note">Not connected — ' + esc(hs.reason || 'no token') + '. To switch this on, '
      + 'create a HubSpot private app with the content-analytics read scope and add its token as '
      + '<b>HUBSPOT_TOKEN</b> in the Vercel project settings. Nothing else needs to change.</div>';
  }
  hsBlock += '</div>';

  /* GA form events give a conversion signal without HubSpot. */
  var evBlock = '';
  if (ga.events && ga.events.length) {
    var evTotals = {};
    ga.evRows.forEach(function (r) {
      if (r[1] < w.a || r[1] > w.b) return;
      evTotals[r[0]] = (evTotals[r[0]] || 0) + r[2];
    });
    var evRows = Object.keys(evTotals).map(function (k) {
      return { k: ga.events[k], n: evTotals[k] };
    }).sort(function (a, b) { return b.n - a.n; });
    if (evRows.length) {
      evBlock = '<div class="card g"><h2>Form activity (GA4)</h2>'
        + '<div class="sub">Events recorded in the selected weeks</div>'
        + '<div class="tw"><table><thead><tr><th>Event</th><th>Count</th></tr></thead><tbody>'
        + evRows.map(function (r) {
          return '<tr><td style="font-weight:700">' + esc(r.k) + '</td><td>' + F(r.n) + '</td></tr>';
        }).join('') + '</tbody></table></div></div>';
    }
  }

  E('p-aeo').innerHTML = aiBlock
    + '<div class="card g"><h2>Answer-engine gap</h2>'
    + '<div class="sub">Question queries with real impressions and almost no clicks — read in the '
    + 'results page, not on the site</div>'
    + (gap.length ? metricTable(gap.map(function (g) {
      return { k: g.k, c: g.c, i: g.i, ct: g.ct, po: g.po, brand: g.brand };
    }), 'query', 20) : '<div class="note">No qualifying question queries in range</div>')
    + '</div>'
    + (appearance.length
      ? '<div class="card g"><h2>Rich-result appearances</h2>'
        + '<div class="sub">How the site shows up in search features · all-time snapshot</div>'
        + dimTable(appearance, 'Appearance') + '</div>'
      : '')
    + evBlock
    + hsBlock;
}

/* ---------- shell ---------- */

function render() {
  var w = windowRange();
  var now = sumTotals(D.totals, w.a, w.b);
  var before = w.valid ? sumTotals(D.totals, w.pa, w.pb) : { c: 0, i: 0, ct: 0, po: 0 };
  var queries = aggregate(D.qStr, D.qW, w.a, w.b, true).sort(function (a, b) { return b.c - a.c; });

  E('prop').textContent = D.meta.property;
  /* Say both dates. The old build showed only the end of the newest week —
   * "data through Aug 23" when the sheet actually stopped on Aug 20. */
  var lastFull = weekEnd(D.weeks[lastUsableWeek(D)]);
  E('mt').innerHTML = 'Property <b>' + esc(D.meta.property) + '</b> · Web search · data through <b>'
    + fmtDate(D.meta.dataThrough) + '</b> · last complete week ends <b>' + fmtDate(lastFull) + '</b>';
  /* Never advertise an end date past the data we actually hold. */
  var rangeEnd = weekEnd(D.weeks[w.b]);
  if (D.meta.dataThrough && rangeEnd > D.meta.dataThrough) rangeEnd = D.meta.dataThrough;
  E('res').textContent = fmtDate(D.weeks[w.a]) + ' → ' + fmtDate(rangeEnd)
    + (w.valid ? ' · ' + (COMPARE === 'year' ? 'vs last year' : 'vs previous period') : ' · no comparison');

  E('k4').innerHTML =
    kpi('Total clicks', F(now.c), w.valid ? pctChip(now.c, before.c) : '<span class="chip fl">—</span>', F(before.c))
    + kpi('Impressions', F(now.i), w.valid ? pctChip(now.i, before.i) : '<span class="chip fl">—</span>', F(before.i))
    + kpi('Avg. CTR', F1(now.ct) + '%', w.valid ? ptChip(now.ct, before.ct) : '<span class="chip fl">—</span>', F1(before.ct) + '%')
    + kpi('Avg. position', F1(now.po), w.valid ? posChip(now.po, before.po) : '<span class="chip fl">—</span>', F1(before.po));

  renderPartialNotice(w);
  renderOverview(w, now, before, queries);
  renderQueries(queries);
  renderPages(w);
  renderBlog();
  renderAEO(w, queries);

  E('foot').innerHTML = 'Source: Google Search Console + GA4 via the nightly pipeline into Google Sheets · '
    + esc(D.meta.property) + ' · ' + D.weeks.length + ' weeks held'
    + (D.meta.lastRun ? ' · pipeline last ran ' + esc(String(D.meta.lastRun).slice(0, 10)) : '')
    + ' · dashboard refreshed ' + esc(String(D.meta.refreshed || '').slice(0, 10)) + '.';
}

function setDateInputs() {
  var w = windowRange();
  E('d0').value = D.weeks[w.a];
  E('d1').value = weekEnd(D.weeks[w.b]);
}

/* Nearest week index at or before a given date. */
function weekIndexFor(dateStr) {
  var idx = 0;
  for (var i = 0; i < D.weeks.length; i++) if (D.weeks[i] <= dateStr) idx = i;
  return idx;
}

function buildUI() {
  E('tabs').innerHTML = TABS.map(function (t) {
    return '<button class="tab' + (t[0] === TAB ? ' on' : '') + '" data-t="' + t[0] + '">' + t[1] + '</button>';
  }).join('');

  E('seg').innerHTML = RANGES.map(function (r) {
    return '<button data-r="' + r[0] + '"' + (r[0] === RANGE && !CUSTOM ? ' class="on"' : '') + '>' + r[1] + '</button>';
  }).join('');

  E('tabs').onclick = function (ev) {
    var btn = ev.target.closest('.tab');
    if (!btn) return;
    TAB = btn.dataset.t;
    document.querySelectorAll('.tab').forEach(function (b) { b.classList.toggle('on', b.dataset.t === TAB); });
    document.querySelectorAll('.pan').forEach(function (p) { p.classList.toggle('on', p.id === 'p-' + TAB); });
  };

  E('seg').onclick = function (ev) {
    var btn = ev.target.closest('button');
    if (!btn) return;
    RANGE = btn.dataset.r;
    CUSTOM = null;
    document.querySelectorAll('#seg button').forEach(function (b) { b.classList.toggle('on', b.dataset.r === RANGE); });
    setDateInputs();
    render();
  };

  E('cmp').onchange = function () { COMPARE = this.value; render(); };

  E('d0').onchange = E('d1').onchange = function () {
    var from = E('d0').value, to = E('d1').value;
    if (!from || !to) return;
    var a = weekIndexFor(from), b = weekIndexFor(to);
    if (b < a) { var t = a; a = b; b = t; }   // tolerate reversed pickers
    CUSTOM = { a: a, b: b };
    document.querySelectorAll('#seg button').forEach(function (x) { x.classList.remove('on'); });
    setDateInputs();
    render();
  };
}

fetch('/api/data', { cache: 'no-store' })
  .then(function (res) {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  })
  .then(function (payload) {
    if (payload && payload.error) throw new Error(payload.error);
    D = payload;
    var loader = E('load');
    if (loader) loader.remove();
    buildUI();
    setDateInputs();
    render();
  })
  .catch(function (err) {
    var loader = E('load');
    if (loader) {
      loader.innerHTML = '<div class="lc">Could not load the dashboard.<br>'
        + '<small>' + esc(String((err && err.message) || err)) + '</small></div>';
    }
  });
