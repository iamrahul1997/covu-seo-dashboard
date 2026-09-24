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
  ['gads', 'Google Ads'],
  ['mads', 'Meta Ads'],
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

/* Totals across an already-aggregated list of queries or pages. Query- and
 * page-level rows only cover part of site traffic (Search Console withholds
 * rare queries), so these deliberately do not match the site totals. */
function sumAgg(rows) {
  var c = 0, imp = 0, weighted = 0;
  for (var i = 0; i < rows.length; i++) {
    c += rows[i].c;
    imp += rows[i].i;
    weighted += rows[i].po * rows[i].i;
  }
  return { c: c, i: imp, ct: imp ? c / imp * 100 : 0, po: imp ? weighted / imp : 0 };
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

  /* `why` distinguishes the two ways a comparison can be absent: the user turned
   * it off, or we simply do not hold enough history to build an equal-length
   * window. Those need to read differently — "from 0" for the second is a lie. */
  var span = b - a + 1;
  var pa, pb, valid = true, why = null, need = 0;
  if (COMPARE === 'none') {
    valid = false; why = 'off';
  } else if (COMPARE === 'year') {
    pa = a - 52; pb = b - 52;
    valid = pa >= 0;
    if (!valid) { why = 'history'; need = span + 52; }
  } else {
    pa = a - span; pb = a - 1;
    valid = pa >= 0;
    if (!valid) { why = 'history'; need = span * 2; }
  }
  return {
    a: a, b: b, pa: Math.max(0, pa), pb: pb, valid: valid, span: span,
    why: why, need: need, held: D.weeks.length,
  };
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
    var head = 'Showing <b>' + fmtDate(D.weeks[w.a]) + '</b> to <b>' + fmtDate(weekEnd(D.weeks[w.b]))
      + '</b>. Clicks <b>' + F(now.c) + '</b>, impressions <b>' + F(now.i)
      + '</b>, average position <b>' + F1(now.po) + '</b>.';
    if (w.why === 'history') {
      return head + ' No comparison shown: an equal-length window would need <b>' + w.need
        + '</b> weeks of history and only <b>' + w.held + '</b> are held, back to '
        + fmtDate(D.weeks[0]) + '. Comparing against a shorter window would overstate the change, '
        + 'so nothing is shown rather than something misleading.';
    }
    return head + ' Comparison is turned off.';
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

/* The Search Console property is a domain property, so it covers every
 * subdomain — news, podcast, go, my and friends, not just www. Rolling the
 * pages up by host makes that visible instead of leaving it buried in a URL
 * list, and it is where the wasted impressions show up. */
function hostTotals(pages) {
  var byHost = {};
  pages.forEach(function (p) {
    var m = String(p.k).match(/^https?:\/\/([^/]+)/);
    var host = m ? m[1] : '(other)';
    var e = byHost[host];
    if (!e) { e = { k: host, c: 0, i: 0, w: 0 }; byHost[host] = e; }
    e.c += p.c; e.i += p.i; e.w += p.po * p.i;
  });
  var out = [];
  for (var h in byHost) {
    var e = byHost[h];
    e.ct = e.i ? e.c / e.i * 100 : 0;
    e.po = e.i ? e.w / e.i : 0;
    out.push(e);
  }
  return out.sort(function (a, b) { return b.i - a.i; });
}

function renderPages(w) {
  var pages = aggregate(D.pStr, D.pW, w.a, w.b, false)
    .sort(function (a, b) { return b.c - a.c; });
  var pairs = (D.queryPage || []).slice(0, 25);
  var hosts = hostTotals(pages);
  /* Hosts pulling real reach but almost no clicks. */
  var wasted = hosts.filter(function (h) { return h.i >= 500 && h.ct < 0.5; });

  E('p-pages').innerHTML = '<div class="card g"><h2>By subdomain</h2>'
    + '<div class="sub">The property covers every host under ' + esc(D.meta.property)
    + ' · ranked by impressions</div>'
    + dimTable(hosts, 'Host')
    + (wasted.length
      ? '<div class="note">' + wasted.map(function (h) {
        return '<b>' + esc(h.k) + '</b> took ' + F(h.i) + ' impressions for ' + F(h.c)
          + ' clicks (' + F1(h.ct) + '% CTR)';
      }).join(', ') + ' — reach that is being shown and ignored. Worth deciding whether those hosts '
        + 'should rank at all, or whether their titles and snippets need work.</div>'
      : '')
    + '</div>'
    + '<div class="card g"><h2>Top pages</h2>'
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

/* blog.covu.com is a separate Search Console property with its own, much
 * shorter history (it only starts in March 2026), so its week indices do not
 * line up with the main site's. Translate the selected window by DATE instead,
 * which is what makes the range buttons actually drive this tab. */
function blogWindowFor(startDate, endDate) {
  var b = D.blog;
  var first = -1, last = -1;
  for (var i = 0; i < b.weeks.length; i++) {
    if (first < 0 && b.weeks[i] >= startDate) first = i;
    if (b.weeks[i] <= endDate) last = i;
  }
  if (first < 0 || last < 0 || last < first) return null;
  return { a: first, b: last };
}

/* The old build showed four KPIs and a list of 15 queries with a "full
 * range-control coming next" note. */
function renderBlog(w) {
  var b = D.blog;
  if (!b || !b.weeks.length) {
    E('p-blog').innerHTML = '<div class="card g"><h2>Blog</h2>'
      + '<div class="note">' + esc(D.meta.blogProperty || 'blog.covu.com') + ' has no data yet.</div></div>';
    return;
  }

  var win = blogWindowFor(D.weeks[w.a], D.weeks[w.b]);
  if (!win) {
    E('p-blog').innerHTML = '<div class="card g"><h2>Blog</h2><div class="note">'
      + 'No blog data in the selected range. ' + esc(D.meta.blogProperty || 'blog.covu.com')
      + ' only has Search Console history from <b>' + fmtDate(b.weeks[0]) + '</b> onwards.'
      + '</div></div>';
    return;
  }
  var a = win.a, last = win.b;

  /* The range may start before the blog property existed, in which case the
   * window is shorter than the one selected — say so rather than let the
   * numbers look like a like-for-like. */
  var truncated = D.weeks[w.a] < b.weeks[0];
  var selectedWeeks = w.b - w.a + 1;
  var actualWeeks = last - a + 1;

  var cmpWin = w.valid ? blogWindowFor(D.weeks[w.pa], D.weeks[w.pb]) : null;
  var hasCompare = !!cmpWin;
  /* An unequal comparison window would overstate growth; flag when that is the
   * case rather than quietly comparing 13 weeks against 4. */
  var cmpWeeks = hasCompare ? cmpWin.b - cmpWin.a + 1 : 0;
  var cmpUneven = hasCompare && cmpWeeks !== actualWeeks;

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

  /* No KPI row here — the shared row at the top of the page now shows blog
   * figures whenever this tab is active, so repeating them was two sets of
   * cards disagreeing about which numbers mattered. */
  E('p-blog').innerHTML =
    (truncated || cmpUneven
      ? '<div class="warn"><span class="ic">⚠</span><span>'
        + (truncated
          ? 'The blog property only has history from <b>' + fmtDate(b.weeks[0]) + '</b>, so this window covers <b>'
            + actualWeeks + '</b> of the <b>' + selectedWeeks + '</b> weeks you selected. '
          : '')
        + (cmpUneven
          ? 'The comparison period covers <b>' + cmpWeeks + '</b> weeks against this window\'s <b>'
            + actualWeeks + '</b>, so the percentages below compare unequal spans — read them as direction, not size.'
          : '')
        + '</span></div>'
      : '')

    + '<div class="card g"><h2>Blog impressions by week</h2>'
    + '<div class="sub">' + esc(D.meta.blogProperty || 'blog.covu.com') + ' · '
    + fmtDate(b.weeks[a]) + ' → ' + fmtDate(weekEnd(b.weeks[last])) + ' · ' + actualWeeks + ' weeks'
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

  /* GA form events are the conversion signal available here. */
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
    + evBlock;
}

/* ---------- paid media ---------- */

var MONEY = '$';   // Google Ads reports in the account currency

/* Currency always to two places — F1 renders $139.90 as "$139.9", which reads
 * like a truncated number rather than an amount. */
function money(cents) {
  return MONEY + (cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

/* First week the ads pipeline holds any data for. Ranges reaching back past it
 * have no comparison to make, which is different from a comparison of zero. */
function adsFirstWeek(table) {
  if (!table || !table.rows.length) return null;
  var min = table.rows[0][0];
  for (var i = 1; i < table.rows.length; i++) if (table.rows[i][0] < min) min = table.rows[i][0];
  return min;
}

/* Totals from a rollUpAds table over a week range.
 * Row shape: [weekIdx, keyIdx, impressions, clicks, cents, conversions*100] */
function adsTotals(table, a, b) {
  var t = { i: 0, c: 0, cents: 0, conv: 0 };
  if (!table || !table.rows) return t;
  for (var j = 0; j < table.rows.length; j++) {
    var r = table.rows[j];
    if (r[0] < a || r[0] > b) continue;
    t.i += r[2]; t.c += r[3]; t.cents += r[4]; t.conv += r[5];
  }
  return t;
}

function adsByKey(table, a, b) {
  if (!table || !table.keys.length) return [];
  var out = table.keys.map(function (k) {
    return { k: k, i: 0, c: 0, cents: 0, conv: 0, lc: 0, mtg: 0 };
  });
  table.rows.forEach(function (r) {
    if (r[0] < a || r[0] > b) return;
    var e = out[r[1]];
    if (!e) return;
    e.i += r[2]; e.c += r[3]; e.cents += r[4]; e.conv += r[5];
    e.lc += (r[6] || 0); e.mtg += (r[7] || 0);
  });
  return out.filter(function (e) { return e.i > 0 || e.cents > 0; })
    .sort(function (x, y) { return y.cents - x.cents; });
}

function adsSeries(table, a, b) {
  var series = [];
  for (var i = a; i <= b; i++) series.push(0);
  if (!table || !table.rows) return series;
  table.rows.forEach(function (r) {
    if (r[0] < a || r[0] > b) return;
    series[r[0] - a] += r[4];
  });
  return series.map(function (cents) { return cents / 100; });
}

function adsTable(rows, label) {
  if (!rows.length) return '<div class="note">No spend in this range</div>';
  return '<div class="tw"><table><thead><tr><th>' + label + '</th><th>Spend</th><th>Impr.</th>'
    + '<th>Clicks</th><th>CTR</th><th>CPC</th><th>Conv.</th><th>Cost / conv.</th>'
    + '</tr></thead><tbody>'
    + rows.map(function (r) {
      var conv = r.conv / 100;
      return '<tr><td class="q" title="' + esc(r.k) + '">' + esc(r.k) + '</td>'
        + '<td>' + money(r.cents) + '</td>'
        + '<td>' + F(r.i) + '</td><td>' + F(r.c) + '</td>'
        + '<td>' + F1(r.i ? r.c / r.i * 100 : 0) + '%</td>'
        + '<td>' + (r.c ? money(r.cents / r.c) : '—') + '</td>'
        + '<td>' + F1(conv) + '</td>'
        + '<td class="p">' + (conv ? money(r.cents / conv) : '—') + '</td></tr>';
    }).join('') + '</tbody></table></div>';
}

function renderGoogleAds(w, queries) {
  var g = (D.ads && D.ads.google) || null;
  if (!g || !g.campaigns || !g.campaigns.keys.length) {
    E('p-gads').innerHTML = '<div class="card g"><h2>Google Ads</h2>'
      + '<div class="note">No ads data in the sheet yet. The Google Ads script writes '
      + '<b>ads_google_daily</b> and <b>ads_google_keyword</b>; once it has run, this tab fills in.'
      + '</div></div>';
    return;
  }

  var labels = [], flags = [];
  for (var i = w.a; i <= w.b; i++) {
    labels.push('Week of ' + fmtDate(D.weeks[i]));
    flags.push(D.weekDays[i] < 7);
  }
  var spend = adsSeries(g.campaigns, w.a, w.b);
  var campaigns = adsByKey(g.campaigns, w.a, w.b);

  /* Ads have no reporting lag, so the pipeline usually holds days beyond the
   * organic window. Say so rather than letting the difference look like a drop. */
  var beyond = g.through && g.through > D.meta.dataThrough
    ? '<div class="note">Ads data runs to <b>' + fmtDate(g.through) + '</b>, but the weeks here '
      + 'align to the organic window ending <b>' + fmtDate(D.meta.dataThrough) + '</b> so paid and '
      + 'organic stay comparable. The most recent days are held back, not missing.</div>'
    : '';

  /* Brand overlap — only answerable now that paid and organic sit together.
   * Presented as a question, not a verdict: defending the brand SERP against
   * competitors is a legitimate reason to pay for clicks you also rank for. */
  var brandOrganic = 0;
  queries.forEach(function (q) { if (q.brand) brandOrganic += q.c; });
  var paidClicks = campaigns.reduce(function (a, r) { return a + r.c; }, 0);
  var paidCents = campaigns.reduce(function (a, r) { return a + r.cents; }, 0);
  var brandCard = '';
  if (paidClicks && brandOrganic) {
    var share = paidClicks / (paidClicks + brandOrganic) * 100;
    brandCard = '<div class="card g"><h2>Brand overlap</h2>'
      + '<div class="sub">Paid and organic clicks on branded terms, same range</div>'
      + '<div class="brow"><span>Organic (free)</span><div class="bar by"><span style="width:'
      + (brandOrganic / (brandOrganic + paidClicks) * 100).toFixed(1) + '%"></span></div>'
      + '<span>' + F(brandOrganic) + '</span></div>'
      + '<div class="brow"><span>Paid</span><div class="bar bt"><span style="width:'
      + share.toFixed(1) + '%"></span></div><span>' + F(paidClicks) + '</span></div>'
      + '<div class="note">The one live campaign bids on brand terms — <b>covu</b>, '
      + '<b>covu insurance</b> — where the site already ranks first organically. Paid supplied '
      + '<b>' + F1(share) + '%</b> of branded clicks for <b>' + money(paidCents) + '</b>; the other '
      + '<b>' + F(brandOrganic) + '</b> cost nothing. That is worth paying for if the goal is '
      + 'holding the top of the page against competitors bidding on your name — worth cutting if '
      + 'it is not. The data cannot settle which; it can only price the question.</div></div>';
  }

  var stale = '';
  if (g.lastRun) {
    var ageDays = Math.floor((Date.now() - new Date(g.lastRun).getTime()) / 86400000);
    if (ageDays >= 2) {
      stale = '<div class="warn"><span class="ic">⚠</span><span>The ads pipeline last ran <b>'
        + ageDays + ' days ago</b> (' + esc(String(g.lastRun).slice(0, 10)) + '). Check the daily '
        + 'schedule on the Google Ads script — these numbers are going stale.</span></div>';
    }
  }

  E('p-gads').innerHTML = stale
    + '<div class="card g"><h2>Weekly spend</h2>'
    + '<div class="sub">' + campaigns.length + ' campaign'
    + (campaigns.length === 1 ? '' : 's') + ' · ' + spend.length + ' weeks'
    + (flags.some(Boolean) ? ' · hollow dot = partial week' : '') + '</div>'
    + chart(spend, labels, flags, '#1a56c4')
    + beyond + '</div>'
    + '<div class="card g"><h2>Campaigns</h2>'
    + '<div class="sub">Ranked by spend in the selected range</div>'
    + adsTable(campaigns, 'Campaign') + '</div>'
    + brandCard
    + '<div class="card g"><h2>Keywords</h2>'
    + '<div class="sub">Snapshot of the pipeline\'s trailing window'
    + (g.through ? ' · through ' + fmtDate(g.through) : '')
    + ' · not filtered by the range above</div>'
    + adsTable((g.keywords || []).map(function (k) {
      return { k: k.k + (k.m ? '  · ' + k.m.toLowerCase() : ''), i: k.i, c: k.c, cents: Math.round(k.cost * 100), conv: Math.round(k.conv * 100) };
    }), 'Keyword') + '</div>';
}

/* Meta reports spend, link clicks and leads — a different shape from Google's
 * cost/conversions, so it gets its own table rather than a shared one bent to
 * fit both. Link clicks matter: reactions and profile taps land in `clicks` but
 * never reach the site. */
function metaTable(rows, label) {
  if (!rows.length) return '<div class="note">No spend in this range</div>';
  return '<div class="tw"><table><thead><tr><th>' + label + '</th><th>Spend</th><th>Impr.</th>'
    + '<th>Link clicks</th><th>Link CTR</th><th>Leads</th><th>Cost / lead</th>'
    + '<th>Meetings</th>'
    + '</tr></thead><tbody>'
    + rows.map(function (r) {
      var leads = r.conv / 100;
      return '<tr><td class="q" title="' + esc(r.k) + '">' + esc(r.k) + '</td>'
        + '<td>' + money(r.cents) + '</td><td>' + F(r.i) + '</td>'
        + '<td>' + F(r.lc) + '</td>'
        + '<td>' + F1(r.i ? r.lc / r.i * 100 : 0) + '%</td>'
        + '<td>' + F1(leads) + '</td>'
        + '<td class="p">' + (leads ? money(r.cents / leads) : '—') + '</td>'
        + '<td>' + F(r.mtg) + '</td></tr>';
    }).join('') + '</tbody></table></div>';
}

function median(values) {
  if (!values.length) return 0;
  var s = values.slice().sort(function (a, b) { return a - b; });
  var mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/* What a campaign was bought to do decides how its creatives are judged.
 *
 * Grading everything on cost per lead punished campaigns that never optimised
 * for leads: TOF LINK CLICK IMPRESSION takes 242k impressions and 1,291 clicks
 * for zero leads, by design, and read KILL against a benchmark it was not
 * competing in. Meta's own objective decides the close metric instead. */
function campaignGoal(objective, totals) {
  var o = String(objective || '').toUpperCase();
  if (/LEAD|SALES|CONVERSION/.test(o)) return 'leads';
  if (/TRAFFIC|LINK_CLICK/.test(o)) return 'clicks';
  if (/AWARENESS|REACH|IMPRESSION/.test(o)) return 'reach';
  if (/ENGAGEMENT/.test(o)) return 'clicks';

  /* No objective recorded yet — infer from the campaign's own conversion rate.
   *
   * "Did any creative produce a lead" is too weak a test: TOF LINK CLICK
   * IMPRESSION has zero leads across 1,291 link clicks, yet two of its
   * creatives carry fractional lead values that round to nothing, which was
   * enough to get the whole campaign judged on cost per lead. The account
   * separates cleanly on rate instead — real lead campaigns run 4.7% to 45% of
   * link clicks, TOF runs 0%. */
  var leads = (totals.conv || 0) / 100;
  var rate = totals.lc ? leads / totals.lc : 0;
  return (leads >= 1 && rate >= 0.01) ? 'leads' : 'clicks';
}

var GOAL_LABEL = {
  leads: { close: 'Cost / lead', unit: 'cost per lead' },
  clicks: { close: 'Cost / link click', unit: 'cost per link click' },
  reach: { close: 'CPM', unit: 'cost per 1,000 impressions' },
};

/* The close metric, in cents, for one creative under its campaign's goal.
 * null means the creative produced nothing to divide by. */
function closeCost(r, goal) {
  if (goal === 'leads') return r.conv > 0 ? r.cents / (r.conv / 100) : null;
  if (goal === 'clicks') return r.lc > 0 ? r.cents / r.lc : null;
  return r.i > 0 ? r.cents / (r.i / 1000) : null;   // reach -> CPM
}

/* Per-campaign benchmarks for the creative table.
 *
 * Returns the medians each ad in the campaign is read against: hook is link CTR
 * — did the ad earn the click — and close follows the campaign's objective.
 * Medians are per campaign because one median across five campaigns with
 * different economics is not a benchmark for any of them.
 *
 * Withheld below four funded creatives: an average over two or three is a coin
 * toss. Named a scorecard from when it also printed a call per ad; it now
 * supplies the line and leaves the judgement to the reader. */
function creativeScorecard(rows, goal) {
  var SPEND_FLOOR = 0.3;
  var medSpend = median(rows.map(function (r) { return r.cents; }));
  var qualifying = rows.filter(function (r) { return r.cents >= medSpend * SPEND_FLOOR; });

  if (qualifying.length < 4) {
    return { rows: rows, graded: false, goal: goal, n: qualifying.length };
  }

  var medHook = median(qualifying.map(function (r) { return r.i ? r.lc / r.i * 100 : 0; }));
  var closes = [];
  qualifying.forEach(function (r) {
    var c = closeCost(r, goal);
    if (c !== null) closes.push(c);
  });
  var medClose = median(closes);

  return { rows: rows, graded: true, goal: goal, medHook: medHook, medClose: medClose, n: qualifying.length };
}

/* One creative row. Thumbnail only — no link out; the picture is the point. */
function creativeRow(r, goal) {
  var art = ((D.ads.meta && D.ads.meta.thumbs) || {})[r.k] || {};
  var name = adKeyParts(r.k).ad;
  var close = closeCost(r, goal);
  return '<tr><td class="q" title="' + esc(name) + '"><div class="adcell">'
    + (art.t
      ? '<img class="thumb" src="' + esc(art.t) + '" alt="Creative for ' + esc(name) + '" '
        + 'loading="lazy" tabindex="0" data-full="' + esc(art.f || art.t) + '" '
        + 'data-name="' + esc(name) + '" onerror="this.style.display=\'none\'">'
      : '<span class="thumb"></span>')
    + '<span>' + esc(name) + '</span></div></td>'
    + '<td>' + money(r.cents) + '</td>'
    + '<td>' + (r.i ? (r.lc / r.i * 100).toFixed(2) : '0.00') + '%</td>'
    + '<td>' + F(r.lc) + '</td>'
    + '<td>' + F1(r.conv / 100) + '</td>'
    + '<td class="p">' + (close === null ? '—' : money(close)) + '</td></tr>';
}

/* Creatives and ad sets are both keyed campaign-then-name: the same creative
 * runs in up to three campaigns, and the "Bex" ad set in two, so keying on the
 * name alone merged their spend and filed the total under one of them. */
function adKeyParts(key) {
  var sep = (D.ads.meta && D.ads.meta.adKeySep) || '\u241f';
  var i = String(key).indexOf(sep);
  return i < 0
    ? { campaign: '', ad: String(key) }
    : { campaign: key.slice(0, i), ad: key.slice(i + sep.length) };
}

function renderMetaAds(w) {
  var m = (D.ads && D.ads.meta) || null;
  if (!m || !m.campaigns || !m.campaigns.keys.length) {
    E('p-mads').innerHTML = '<div class="card g"><h2>Meta Ads</h2>'
      + '<div class="note">No Meta data in the sheet yet. The Apps Script in '
      + '<b>pipeline/meta-ads-appsscript.gs</b> writes <b>ads_meta_daily</b> and '
      + '<b>ads_meta_ad</b>; once it has run, this tab fills in.</div></div>';
    return;
  }

  var labels = [], flags = [];
  for (var i = w.a; i <= w.b; i++) {
    labels.push('Week of ' + fmtDate(D.weeks[i]));
    flags.push(D.weekDays[i] < 7);
  }

  var campaigns = adsByKey(m.campaigns, w.a, w.b);
  var adsets = adsByKey(m.adsets, w.a, w.b);
  var creatives = adsByKey(m.creatives, w.a, w.b);
  var objectives = m.objectives || {};


  var stale = '';
  if (m.lastRun) {
    var ageDays = Math.floor((Date.now() - new Date(m.lastRun).getTime()) / 86400000);
    if (ageDays >= 2) {
      stale = '<div class="warn"><span class="ic">⚠</span><span>The Meta fetcher last ran <b>'
        + ageDays + ' days ago</b> (' + esc(String(m.lastRun).slice(0, 10)) + '). Check the daily '
        + 'trigger in Apps Script — these numbers are going stale.</span></div>';
    }
  }

  /* Account-level spend first, then one self-contained block per campaign.
   * Three flat tables threw away the hierarchy that actually matters when
   * managing this account. */
  var html = stale
    + '<div class="card g"><h2>Weekly spend</h2>'
    + '<div class="sub">' + campaigns.length + ' campaign'
    + (campaigns.length === 1 ? '' : 's') + ' · ' + (w.b - w.a + 1) + ' weeks'
    + (flags.some(Boolean) ? ' · hollow dot = partial week' : '') + '</div>'
    + chart(adsSeries(m.campaigns, w.a, w.b), labels, flags, '#0b5ed9') + '</div>';

  campaigns.forEach(function (camp) {
    var mine = creatives.filter(function (r) { return adKeyParts(r.k).campaign === camp.k; });
    /* Ad sets carry the same composite key as creatives — "Bex" runs in two
     * campaigns — so they are filtered and relabelled the same way. */
    var mySets = adsets.filter(function (r) { return adKeyParts(r.k).campaign === camp.k; })
      .map(function (r) {
        var copy = {}; for (var f in r) copy[f] = r[f];
        copy.k = adKeyParts(r.k).ad;
        return copy;
      });
    var goal = campaignGoal(objectives[camp.k], camp);
    var lbl = GOAL_LABEL[goal];
    var score = creativeScorecard(mine, goal);
    var leads = camp.conv / 100;
    var close = closeCost(camp, goal);

    html += '<div class="card g"><h2>' + esc(camp.k) + '</h2>'
      + '<div class="sub">'
      + (objectives[camp.k]
        ? 'Objective <b>' + esc(objectives[camp.k].replace(/^OUTCOME_/, '').toLowerCase()) + '</b>'
        : 'No objective recorded — judged on what it produced')
      + ' · judged on ' + lbl.unit + '</div>'

      /* Campaign headline, in the terms of its own objective. */
      + '<div class="brow" style="grid-template-columns:repeat(4,1fr);gap:16px">'
      + '<span>Spend <b>' + money(camp.cents) + '</b></span>'
      + '<span>Link clicks <b>' + F(camp.lc) + '</b></span>'
      + '<span>Leads <b>' + F1(leads) + '</b></span>'
      + '<span>' + lbl.close + ' <b>' + (close === null ? '—' : money(close)) + '</b></span>'
      + '</div>'

      + (mySets.length > 1
        ? '<div class="sub" style="margin-top:14px;padding-left:0"><b>Ad sets</b></div>'
          + metaTable(mySets, 'Ad set')
        : '')

      + '<div class="sub" style="margin-top:16px;padding-left:0"><b>Creatives</b> · hook = link CTR'
      + ' · close = ' + lbl.unit + '</div>'
      + (mine.length
        ? '<div class="tw"><table><thead><tr><th>Ad</th><th>Spend</th>'
          + '<th>Link CTR</th><th>Link clicks</th><th>Leads</th><th>' + lbl.close + '</th>'
          + '</tr></thead><tbody>'
          + score.rows.map(function (r) { return creativeRow(r, goal); }).join('')
          + '</tbody></table></div>'
          + (score.graded
            ? '<div class="note">Median hook <b>' + score.medHook.toFixed(2) + '%</b> and median '
              + lbl.unit + ' <b>' + money(score.medClose) + '</b>, across ' + score.n
              + ' funded creatives <b>in this campaign</b> — the line each ad above is above or '
              + 'below. Benchmarks are per campaign, so they are not comparable between them.</div>'
            : '<div class="note">Only ' + score.n + ' creative'
              + (score.n === 1 ? '' : 's') + ' here has meaningful spend, so no median is shown — '
              + 'an average over two or three is a coin toss rather than a benchmark.</div>')
        : '<div class="note">No ad-level spend in this range</div>')
      + '</div>';
  });

  E('p-mads').innerHTML = html;
}

/* Full creative on demand. The thumbnail is all the table needs; the whole ad
 * is often a 1080px square, so it is only fetched when someone asks for it. */
function openLightbox(src, name) {
  var box = E('lightbox');
  E('lbImg').src = src;
  E('lbCap').textContent = name || '';
  box.classList.add('on');
  E('lbClose').focus();
}

function closeLightbox() {
  E('lightbox').classList.remove('on');
  E('lbImg').removeAttribute('src');   // stop a large image decoding behind the overlay
}

document.addEventListener('click', function (ev) {
  var img = ev.target.closest && ev.target.closest('img.thumb[data-full]');
  if (img) { openLightbox(img.dataset.full, img.dataset.name); return; }
  if (ev.target.id === 'lightbox' || ev.target.id === 'lbClose') closeLightbox();
});

document.addEventListener('keydown', function (ev) {
  if (ev.key === 'Escape') closeLightbox();
  /* Thumbnails are focusable, so the keyboard gets the same affordance. */
  if ((ev.key === 'Enter' || ev.key === ' ')
    && document.activeElement && document.activeElement.matches('img.thumb[data-full]')) {
    ev.preventDefault();
    openLightbox(document.activeElement.dataset.full, document.activeElement.dataset.name);
  }
});

/* ---------- KPI row ---------- */

var CTX = null;   // last render's context, so the KPI row can redraw on tab change

/* Four cards whose meaning follows the active tab. Each set names its own scope
 * in the card titles so two tabs can never show the same four numbers under the
 * same four labels. */
function renderKpis() {
  if (!CTX) return;
  var w = CTX.w, queries = CTX.queries;
  var noChip = '<span class="chip fl">—</span>';
  var noFrom = w.why === 'history' ? 'no prior window' : 'comparison off';

  function four(labels, nowVals, beforeVals, kinds, valid) {
    var out = '';
    for (var i = 0; i < labels.length; i++) {
      var chip;
      if (!valid) chip = noChip;
      else if (kinds[i] === 'pts') chip = ptChip(nowVals[i], beforeVals[i]);
      else if (kinds[i] === 'pos') chip = posChip(nowVals[i], beforeVals[i]);
      else chip = pctChip(nowVals[i], beforeVals[i]);
      var shown = kinds[i] === 'int' ? F(nowVals[i])
        : kinds[i] === 'pts' ? F1(nowVals[i]) + '%' : F1(nowVals[i]);
      var from = !valid ? noFrom
        : kinds[i] === 'int' ? F(beforeVals[i])
          : kinds[i] === 'pts' ? F1(beforeVals[i]) + '%' : F1(beforeVals[i]);
      out += kpi(labels[i], shown, chip, from);
    }
    return out;
  }

  if (TAB === 'queries' || TAB === 'pages') {
    var isQ = TAB === 'queries';
    var nowRows = isQ ? queries : aggregate(D.pStr, D.pW, w.a, w.b, false);
    var n = sumAgg(nowRows);
    var b = w.valid
      ? sumAgg(aggregate(isQ ? D.qStr : D.pStr, isQ ? D.qW : D.pW, w.pa, w.pb, false))
      : { c: 0, i: 0, ct: 0, po: 0 };
    E('k4').innerHTML = four(
      [(isQ ? 'Query' : 'Page') + ' clicks', (isQ ? 'Query' : 'Page') + ' impressions', 'CTR', 'Avg. position'],
      [n.c, n.i, n.ct, n.po], [b.c, b.i, b.ct, b.po],
      ['int', 'int', 'pts', 'pos'], w.valid,
    );
    /* These will not reconcile with the Overview, and the reason differs by
     * dimension — so say which one applies rather than printing a percentage
     * that can exceed 100 and look like a bug. */
    E('kpiNote').innerHTML = '<div class="note" style="margin:0 0 16px">'
      + F(nowRows.length) + ' ' + (isQ ? 'queries' : 'pages') + ' in range. '
      + (isQ
        ? 'These total <b>' + F1(CTX.now.c ? n.c / CTX.now.c * 100 : 0) + '%</b> of the site\'s <b>'
          + F(CTX.now.c) + '</b> clicks — Search Console withholds rare queries to protect privacy, '
          + 'so query rows always add up to less than the Overview.'
        : 'Page impressions exceed the site total because Search Console counts them differently: '
          + 'one query showing two of your URLs is one impression for the property but one for each '
          + 'page. The property is <b>' + esc(D.meta.property) + '</b>, which spans every subdomain '
          + '— see the breakdown below.')
      + '</div>';
    return;
  }

  if (TAB === 'blog') {
    var bd = D.blog;
    var bw = (bd && bd.weeks.length) ? blogWindowFor(D.weeks[w.a], D.weeks[w.b]) : null;
    if (!bw) {
      E('k4').innerHTML = '';
      E('kpiNote').innerHTML = '';
      return;
    }
    var cw = w.valid ? blogWindowFor(D.weeks[w.pa], D.weeks[w.pb]) : null;
    var bn = sumTotals(bd.totals, bw.a, bw.b);
    var bb = cw ? sumTotals(bd.totals, cw.a, cw.b) : { c: 0, i: 0, ct: 0, po: 0 };
    E('k4').innerHTML = four(
      ['Blog clicks', 'Blog impressions', 'Blog CTR', 'Blog position'],
      [bn.c, bn.i, bn.ct, bn.po], [bb.c, bb.i, bb.ct, bb.po],
      ['int', 'int', 'pts', 'pos'], !!cw,
    );
    E('kpiNote').innerHTML = '<div class="note" style="margin:0 0 16px">'
      + esc(D.meta.blogProperty || 'blog.covu.com') + ' is a separate Search Console property, so '
      + 'these are its own numbers — not a slice of the site totals on Overview.</div>';
    return;
  }

  if (TAB === 'aeo') {
    var ga = D.ga || { channels: [], rows: [], aiChannel: -1 };
    var aiNow = 0, aiBefore = 0, allNow = 0;
    if (ga.aiChannel >= 0) {
      ga.rows.forEach(function (r) {
        if (r[1] >= w.a && r[1] <= w.b) {
          allNow += r[2];
          if (r[0] === ga.aiChannel) aiNow += r[2];
        } else if (w.valid && r[1] >= w.pa && r[1] <= w.pb && r[0] === ga.aiChannel) {
          aiBefore += r[2];
        }
      });
    }
    var qq = queries.filter(function (q) { return q.question; });
    var qqImpr = qq.reduce(function (a, q) { return a + q.i; }, 0);
    var gapCount = queries.filter(function (q) {
      return q.question && q.i >= 30 && q.ct < 1;
    }).length;
    E('k4').innerHTML =
      kpi('AI assistant sessions', F(aiNow),
        w.valid ? pctChip(aiNow, aiBefore) : noChip, w.valid ? F(aiBefore) : noFrom)
      + kpi('AI share of traffic', (allNow ? F1(aiNow / allNow * 100) : '0') + '%',
        '<span class="chip fl">of ' + F(allNow) + '</span>', 'GA4 sessions')
      + kpi('Question impressions', F(qqImpr),
        '<span class="chip fl">' + F(qq.length) + ' queries</span>', 'question-shaped')
      + kpi('Zero-click gap', F(gapCount),
        '<span class="chip fl">30+ impr, &lt;1% CTR</span>', 'queries to target');
    E('kpiNote').innerHTML = '<div class="note" style="margin:0 0 16px">'
      + 'AI assistant sessions are the only first-party answer-engine measure available. '
      + 'The other three are Search Console proxies: question-shaped queries and those earning '
      + 'impressions without clicks.</div>';
    return;
  }

  if (TAB === 'gads') {
    var g = (D.ads && D.ads.google) || null;
    var t = g ? adsTotals(g.campaigns, w.a, w.b) : { i: 0, c: 0, cents: 0, conv: 0 };
    /* Only compare when the pipeline actually held data for the earlier window.
     * Otherwise every figure reads "new", which implies growth from nothing
     * rather than an absence of history. */
    var first = g ? adsFirstWeek(g.campaigns) : null;
    var canCompare = w.valid && first !== null && w.pa >= first;
    var p = canCompare ? adsTotals(g.campaigns, w.pa, w.pb) : { i: 0, c: 0, cents: 0, conv: 0 };
    var cpc = t.c ? t.cents / t.c : 0, pcpc = p.c ? p.cents / p.c : 0;
    var cpa = t.conv ? t.cents / (t.conv / 100) : 0, pcpa = p.conv ? p.cents / (p.conv / 100) : 0;
    var adsFrom = canCompare ? null : 'no ads history';
    /* Spend and cost-per rise and fall for opposite reasons, so a rising CPC is
     * flagged as bad while rising spend is left neutral — the chip colour should
     * not imply that spending more is a win. */
    E('k4').innerHTML =
      kpi('Spend', money(t.cents), canCompare ? pctChip(t.cents, p.cents) : noChip,
        canCompare ? money(p.cents) : (adsFrom || noFrom))
      + kpi('Clicks', F(t.c), canCompare ? pctChip(t.c, p.c) : noChip,
        canCompare ? F(p.c) : (adsFrom || noFrom))
      + kpi('Cost per click', cpc ? money(cpc) : '—',
        canCompare && pcpc ? posChip(cpc, pcpc) : noChip,
        canCompare && pcpc ? money(pcpc) : (adsFrom || noFrom))
      + kpi('Conversions', F1(t.conv / 100), canCompare ? pctChip(t.conv, p.conv) : noChip,
        canCompare ? F1(p.conv / 100) : (adsFrom || noFrom));
    E('kpiNote').innerHTML = '<div class="note" style="margin:0 0 16px">'
      + (cpa ? 'Cost per conversion <b>' + money(cpa) + '</b>'
        + (canCompare && pcpa ? ', from ' + money(pcpa) + ' in the comparison window' : '') + '. '
        : 'No conversions recorded in this range. ')
      + (adsFrom && g && g.campaigns.rows.length
        ? 'The pipeline holds ads data from <b>' + fmtDate(D.weeks[first]) + '</b>, which does not '
          + 'reach the comparison window, so no change is shown. It will once the daily job has '
          + 'been running longer. '
        : '')
      + 'Spend is in the Google Ads account currency. Cost-per-click is shown green when it '
      + 'falls, since cheaper clicks are the win — unlike the other three, where up is up.</div>';
    return;
  }

  if (TAB === 'mads') {
    var m = (D.ads && D.ads.meta) || null;
    var mt = m ? adsTotals(m.campaigns, w.a, w.b) : { i: 0, c: 0, cents: 0, conv: 0 };
    var mFirst = m ? adsFirstWeek(m.campaigns) : null;
    var mCan = w.valid && mFirst !== null && w.pa >= mFirst;
    var mp = mCan ? adsTotals(m.campaigns, w.pa, w.pb) : { i: 0, c: 0, cents: 0, conv: 0 };
    var mFrom = mCan ? null : 'no Meta history';
    var leadsNow = mt.conv / 100, leadsPrev = mp.conv / 100;
    var cpl = leadsNow ? mt.cents / leadsNow : 0;
    var pcpl = leadsPrev ? mp.cents / leadsPrev : 0;
    var lcNow = 0, lcPrev = 0;
    if (m && m.campaigns.rows) {
      m.campaigns.rows.forEach(function (r) {
        if (r[0] >= w.a && r[0] <= w.b) lcNow += (r[6] || 0);
        else if (mCan && r[0] >= w.pa && r[0] <= w.pb) lcPrev += (r[6] || 0);
      });
    }
    E('k4').innerHTML =
      kpi('Spend', money(mt.cents), mCan ? pctChip(mt.cents, mp.cents) : noChip,
        mCan ? money(mp.cents) : (mFrom || noFrom))
      + kpi('Leads', F1(leadsNow), mCan ? pctChip(mt.conv, mp.conv) : noChip,
        mCan ? F1(leadsPrev) : (mFrom || noFrom))
      + kpi('Cost per lead', cpl ? money(cpl) : '—',
        mCan && pcpl ? posChip(cpl, pcpl) : noChip, mCan && pcpl ? money(pcpl) : (mFrom || noFrom))
      + kpi('Link clicks', F(lcNow), mCan ? pctChip(lcNow, lcPrev) : noChip,
        mCan ? F(lcPrev) : (mFrom || noFrom));
    E('kpiNote').innerHTML = '<div class="note" style="margin:0 0 16px">'
      + 'Link clicks, not all clicks — reactions and profile taps count in Meta\'s click total but '
      + 'never reach the site. Cost per lead is shown green when it falls. '
      + 'Leads are Meta\'s own attribution.</div>';
    return;
  }

  // Overview — the site-wide totals.
  var now = CTX.now, before = CTX.before;
  E('k4').innerHTML = four(
    ['Total clicks', 'Impressions', 'Avg. CTR', 'Avg. position'],
    [now.c, now.i, now.ct, now.po], [before.c, before.i, before.ct, before.po],
    ['int', 'int', 'pts', 'pos'], w.valid,
  );
  E('kpiNote').innerHTML = '';
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
    + (w.valid ? ' · ' + (COMPARE === 'year' ? 'vs last year' : 'vs previous period')
      : (w.why === 'history' ? ' · no comparison — not enough history' : ' · no comparison'));

  /* The KPI row lives outside the tab panels, so it has to be told which tab is
   * showing. Left global it reads identical site-wide totals everywhere, which
   * is misleading on Queries and Pages (they cover only part of site traffic),
   * plainly wrong on Blog (a different property) and meaningless on AEO Lens. */
  CTX = { w: w, now: now, before: before, queries: queries };
  renderKpis();

  renderPartialNotice(w);
  renderOverview(w, now, before, queries);
  renderQueries(queries);
  renderPages(w);
  renderBlog(w);
  renderAEO(w, queries);
  renderGoogleAds(w, queries);
  renderMetaAds(w);

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
    renderKpis();   // the KPI row is scoped to the active tab
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

/* Header identity chip. The session cookie is HttpOnly, so who-am-I comes from
 * the server. Also surfaces the case where sign-in has not been configured yet,
 * so a dashboard everyone can read does not stay that way by accident. */
function renderWho() {
  fetch('/api/auth/me', { cache: 'no-store' })
    .then(function (res) { return res.json().catch(function () { return null; }); })
    .then(function (info) {
      if (!info) return;
      var el = E('who');
      if (!el) return;
      if (info.authEnabled === false) {
        el.innerHTML = '<span class="pub" title="Anyone with the link can read this dashboard">'
          + 'public · sign-in not configured</span>';
      } else if (info.email) {
        el.innerHTML = '<span class="sep">·</span>' + esc(info.email)
          + '<span class="sep">·</span><a href="/api/auth/logout">Sign out</a>';
      }
    })
    .catch(function () { /* header chip is cosmetic; never block the dashboard */ });
}

renderWho();

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
