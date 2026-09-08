// GET /api/health — platform health as JSON.
//
// Deliberately the one endpoint that needs no session. It exposes no metrics
// and no query text, only whether each connected source is current: enough for
// an uptime check or an alert to act on, and nothing worth protecting.
//
// Returns 200 when every source is ok, 503 otherwise, so a monitor that
// understands nothing but status codes still does the right thing.

import { health } from '../lib/health.js';

export default async function handler(req, res) {
  try {
    const h = await health(process.env.ORG_SLUG || 'covu');
    res.setHeader('cache-control', 'no-store');
    res.status(h.status === 'ok' ? 200 : 503).json(h);
  } catch (err) {
    res.setHeader('cache-control', 'no-store');
    res.status(500).json({ status: 'error', error: String(err?.message || err) });
  }
}
