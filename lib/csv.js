// CSV parsing for spreadsheet exports.
//
// Google Sheets is read through /export?format=csv&gid=… and never through
// /gviz/tq. gviz coerces every column to a single type and silently blanks any
// cell that disagrees — on a mixed-type key/value tab that returns nothing at
// all, and it merges the first two rows into one header. /export returns raw
// cell values and ISO dates. This cost a debugging session to learn and is the
// only supported way to read a sheet here.

export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }   // escaped quote
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

/** First row becomes keys. Blank trailing lines are dropped. */
export function objectify(rows) {
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

export const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
export const int = (v) => Math.round(num(v));
