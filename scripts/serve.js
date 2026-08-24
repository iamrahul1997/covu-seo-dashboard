// Local dev server. Mimics Vercel's routing: /api/* -> api/*.js handler,
// everything else -> public/. Used for verification before deploying.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = process.env.PORT || 3210;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// Minimal stand-in for Vercel's res helpers.
function decorate(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
  res.send = (body) => res.end(body);
  return res;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  decorate(res);

  if (pathname.startsWith('/api/')) {
    const name = pathname.replace(/^\/api\//, '').replace(/\.js$/, '');
    try {
      const mod = await import(path.join(root, 'api', name + '.js') + `?t=${Date.now()}`);
      req.query = Object.fromEntries(url.searchParams);
      await mod.default(req, res);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: String(err && err.message || err) });
    }
    return;
  }

  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  try {
    const file = path.join(root, 'public', rel);
    if (!file.startsWith(path.join(root, 'public'))) throw new Error('nope');
    const body = await fs.readFile(file);
    res.setHeader('content-type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch {
    res.status(404).end('Not found');
  }
});

server.listen(PORT, () => console.log(`dashboard dev server on http://localhost:${PORT}`));
