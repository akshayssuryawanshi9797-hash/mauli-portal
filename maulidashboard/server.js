/* Mauli College portal backend.
 * - Serves the frontend from ./public
 * - REST API:  GET    /api/health
 *              GET    /api/state            -> { key: value, ... }   (read all)
 *              GET    /api/state/:key       -> { key, value, updated_at }
 *              PUT    /api/state/:key       body {value}  -> create/update (upsert)
 *              DELETE /api/state/:key       -> delete
 * - Storage: PostgreSQL when DATABASE_URL is set (production), otherwise a local SQLite file (development).
 */
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = process.env.PORT || 3000;
const KEYS = ['mauli_staff', 'mauli_as2', 'mauli_resp', 'mauli_tasks'];
const MAX_BODY = 5 * 1024 * 1024;

/* ---------- storage adapters ---------- */
async function makeStore() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 });
    await pool.query(`CREATE TABLE IF NOT EXISTS app_state(
      key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
    return {
      kind: 'postgres',
      async all() { return (await pool.query('SELECT key,value,updated_at FROM app_state')).rows; },
      async get(k) { return (await pool.query('SELECT key,value,updated_at FROM app_state WHERE key=$1', [k])).rows[0]; },
      async put(k, v) { await pool.query(
        `INSERT INTO app_state(key,value,updated_at) VALUES($1,$2::jsonb,now())
         ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [k, JSON.stringify(v)]); },
      async del(k) { return (await pool.query('DELETE FROM app_state WHERE key=$1', [k])).rowCount; }
    };
  }
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  const db = new DatabaseSync(process.env.SQLITE_FILE || path.join(__dirname, 'data', 'portal.db'));
  db.exec(`CREATE TABLE IF NOT EXISTS app_state(
    key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);
  const parse = r => r && { key: r.key, value: JSON.parse(r.value), updated_at: r.updated_at };
  return {
    kind: 'sqlite',
    async all() { return db.prepare('SELECT key,value,updated_at FROM app_state').all().map(parse); },
    async get(k) { return parse(db.prepare('SELECT key,value,updated_at FROM app_state WHERE key=?').get(k)); },
    async put(k, v) { db.prepare(
      `INSERT INTO app_state(key,value,updated_at) VALUES(?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(k, JSON.stringify(v)); },
    async del(k) { return Number(db.prepare('DELETE FROM app_state WHERE key=?').run(k).changes); }
  };
}

/* ---------- helpers ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function send(res, code, body, headers = {}) {
  const isObj = body !== null && typeof body === 'object';
  res.writeHead(code, {
    'Content-Type': isObj ? 'application/json' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    ...(process.env.CORS_ORIGIN ? { 'Access-Control-Allow-Origin': process.env.CORS_ORIGIN,
      'Access-Control-Allow-Methods': 'GET,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } : {}),
    ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject({ code: 413, msg: 'Payload too large' }); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { reject({ code: 400, msg: 'Invalid JSON' }); } });
    req.on('error', () => reject({ code: 400, msg: 'Bad request' }));
  });
}

/* ---------- server ---------- */
(async () => {
  const store = await makeStore();
  const PUB = path.join(__dirname, 'public');

  http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const p = decodeURIComponent(url.pathname);

      if (p.startsWith('/api/')) {
        if (req.method === 'OPTIONS') return send(res, 204, '');
        if (p === '/api/health') return send(res, 200, { ok: true, storage: store.kind });

        if (p === '/api/state' && req.method === 'GET') {
          const out = {}; (await store.all()).forEach(r => { if (KEYS.includes(r.key)) out[r.key] = r.value; });
          return send(res, 200, out);
        }
        const m = p.match(/^\/api\/state\/([\w-]+)$/);
        if (m) {
          const key = m[1];
          if (!KEYS.includes(key)) return send(res, 404, { error: 'Unknown key' });
          if (req.method === 'GET') {
            const row = await store.get(key);
            return row ? send(res, 200, row) : send(res, 404, { error: 'Not found' });
          }
          if (req.method === 'PUT') {
            const body = await readJson(req);
            if (!('value' in body)) return send(res, 400, { error: 'Body must be {"value": ...}' });
            await store.put(key, body.value);
            return send(res, 200, { ok: true, key });
          }
          if (req.method === 'DELETE') {
            const n = await store.del(key);
            return send(res, 200, { ok: true, key, deleted: n });
          }
        }
        return send(res, 404, { error: 'Not found' });
      }

      /* static files */
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      let file = path.normalize(path.join(PUB, p === '/' ? 'index.html' : p));
      if (!file.startsWith(PUB)) return send(res, 403, 'Forbidden');
      fs.readFile(file, (err, data) => {
        if (err) return send(res, 404, 'Not found');
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        res.end(data);
      });
    } catch (e) {
      if (e && e.code && e.msg) return send(res, e.code, { error: e.msg });
      console.error(e); send(res, 500, { error: 'Server error' });
    }
  }).listen(PORT, () => console.log(`Mauli portal running on port ${PORT} (storage: ${store.kind})`));
})();
