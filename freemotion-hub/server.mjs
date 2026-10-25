#!/usr/bin/env node
/**
 * freemotion-hub/server.mjs — the Free Motion dashboard's server. It runs on the laptop (Docker, see
 * compose.yml) and decides nothing about the work: it keeps what each machine's agent sends
 * (freemotion-night/hub-agent.mjs), serves the page, and passes the page's commands to the machines.
 *
 * Two listeners, never mixed:
 *   PAGE_PORT  (8790) the page and /api/v1/*: reached only through the Cloudflare tunnel, and every
 *              request must carry a valid Cloudflare Access token for an allowed email.
 *   AGENT_PORT (8791) /agent/v1/*: reached over Tailscale by the agents, each with its own key.
 *
 * Storage: one SQLite file (DB, default /data/hub.db).
 *   records   (machine, t, k) → d, rev, deleted    what the agents sent; `rev` orders every change
 *   commands  id → machine, action, args, status   queued → sent → running → done | failed | cancelled
 *   machines  machine → hello, last_seen
 * The page asks for every change after the last `rev` it has (GET /api/v1/changes?since=N), so a
 * reload, a phone and a laptop all show the same thing.
 *
 * Settings (environment):
 *   AGENT_KEYS      "pc:<secret>,laptop:<secret>"  one key per machine
 *   CF_TEAM         the Cloudflare Access team name (<team>.cloudflareaccess.com)
 *   CF_AUD          the Access application's audience tag
 *   ALLOWED_EMAILS  "a@b.com,c@d.com"
 *   HUB_AUTH=off    no login check: only allowed while PAGE_HOST is 127.0.0.1 (local tests)
 */
import { createServer } from 'http';
import { createPublicKey, createHash, randomUUID, timingSafeEqual, verify } from 'crypto';
import { readFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { dirname, extname, join, normalize } from 'path';
import { fileURLToPath } from 'url';
import { gunzipSync, gzipSync } from 'zlib';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, 'public');
const E = process.env;
const PAGE_HOST = E.PAGE_HOST || '0.0.0.0', PAGE_PORT = +(E.PAGE_PORT || 8790);
const AGENT_HOST = E.AGENT_HOST || '0.0.0.0', AGENT_PORT = +(E.AGENT_PORT || 8791);
const DB_PATH = E.DB || '/data/hub.db';
const AUTH_OFF = E.HUB_AUTH === 'off';
if (AUTH_OFF && PAGE_HOST !== '127.0.0.1') { console.error('HUB_AUTH=off is only allowed with PAGE_HOST=127.0.0.1'); process.exit(1); }
const KEYS = new Map((E.AGENT_KEYS || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => { const i = x.indexOf(':'); return [x.slice(0, i), x.slice(i + 1)]; }));
const ALLOWED = new Set((E.ALLOWED_EMAILS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
const OFFLINE_AFTER = 20000;          // a machine that has not synced for 20 s is offline
const COMMAND_TIMEOUT = 15 * 60000;   // a command taken and never answered fails after 15 min
const say = (l) => console.log(`${new Date().toISOString()} ${l}`);

// ── storage ──────────────────────────────────────────────────────────────
mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS records (machine TEXT, t TEXT, k TEXT, d TEXT, rev INTEGER, deleted INTEGER DEFAULT 0, PRIMARY KEY (machine, t, k));
  CREATE INDEX IF NOT EXISTS records_rev ON records (rev);
  CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, machine TEXT, action TEXT, args TEXT, status TEXT, message TEXT, data TEXT,
    by TEXT, created INTEGER, updated INTEGER, rev INTEGER);
  CREATE INDEX IF NOT EXISTS commands_rev ON commands (rev);
  CREATE TABLE IF NOT EXISTS machines (machine TEXT PRIMARY KEY, hello TEXT, last_seen INTEGER, rev INTEGER);
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER);
  INSERT OR IGNORE INTO meta VALUES ('rev', 0);
`);
const q = {
  rev: db.prepare(`UPDATE meta SET v = v + 1 WHERE k = 'rev' RETURNING v`),
  revNow: db.prepare(`SELECT v FROM meta WHERE k = 'rev'`),
  upsert: db.prepare(`INSERT INTO records (machine, t, k, d, rev, deleted) VALUES (?, ?, ?, ?, ?, 0)
    ON CONFLICT (machine, t, k) DO UPDATE SET d = excluded.d, rev = excluded.rev, deleted = 0`),
  del: db.prepare(`UPDATE records SET deleted = 1, rev = ? WHERE machine = ? AND t = ? AND k = ? AND deleted = 0`),
  since: db.prepare(`SELECT machine, t, k, d, rev, deleted FROM records WHERE rev > ? ORDER BY rev`),
  all: db.prepare(`SELECT machine, t, k, d, rev, deleted FROM records WHERE deleted = 0`),
  cmdAdd: db.prepare(`INSERT INTO commands (id, machine, action, args, status, message, data, by, created, updated, rev) VALUES (?, ?, ?, ?, 'queued', '', NULL, ?, ?, ?, ?)`),
  cmdQueued: db.prepare(`SELECT id, action, args FROM commands WHERE status = 'queued' AND machine = ? ORDER BY created`),
  cmdSet: db.prepare(`UPDATE commands SET status = ?, message = ?, data = COALESCE(?, data), updated = ?, rev = ? WHERE id = ? AND machine = ?`),
  cmdSetAny: db.prepare(`UPDATE commands SET status = ?, message = ?, updated = ?, rev = ? WHERE id = ?`),
  cmdGet: db.prepare(`SELECT * FROM commands WHERE id = ?`),
  cmdSince: db.prepare(`SELECT id, machine, action, args, status, message, by, created, updated, rev, data IS NOT NULL AS hasData FROM commands WHERE rev > ? ORDER BY rev`),
  cmdStale: db.prepare(`SELECT id FROM commands WHERE status IN ('sent', 'running') AND updated < ?`),
  cmdDropData: db.prepare(`UPDATE commands SET data = NULL WHERE data IS NOT NULL AND updated < ?`),
  seen: db.prepare(`INSERT INTO machines (machine, hello, last_seen, rev) VALUES (?, ?, ?, ?)
    ON CONFLICT (machine) DO UPDATE SET hello = COALESCE(excluded.hello, hello), last_seen = excluded.last_seen, rev = CASE WHEN excluded.hello IS NULL THEN rev ELSE excluded.rev END`),
  machines: db.prepare(`SELECT machine, hello, last_seen FROM machines`),
};
const nextRev = () => q.rev.get().v;
const tx = (fn) => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

// Commands taken and never answered fail; file data is dropped after 10 minutes.
setInterval(() => {
  const now = Date.now();
  for (const c of q.cmdStale.all(now - COMMAND_TIMEOUT)) q.cmdSetAny.run('failed', 'The machine never answered', now, nextRev(), c.id);
  q.cmdDropData.run(now - 10 * 60000);
}, 30000).unref();

// ── HTTP helpers ─────────────────────────────────────────────────────────
const MAX_BODY = 32 << 20;
function body(req) {
  return new Promise((res, rej) => {
    const parts = []; let n = 0;
    req.on('data', (b) => { n += b.length; if (n > MAX_BODY) { rej(Object.assign(new Error('too big'), { status: 413 })); req.destroy(); } else parts.push(b); });
    req.on('end', () => {
      try {
        let buf = Buffer.concat(parts);
        if (req.headers['content-encoding'] === 'gzip') buf = gunzipSync(buf, { maxOutputLength: 256 << 20 });
        res(buf.length ? JSON.parse(buf.toString('utf8')) : {});
      } catch { rej(Object.assign(new Error('bad body'), { status: 400 })); }
    });
    req.on('error', rej);
  });
}
const SEC = {
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; frame-src 'self' blob:; object-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
function send(req, res, status, data, type = 'application/json; charset=utf-8', extra = {}) {
  let buf = Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
  const h = { ...SEC, 'content-type': type, 'cache-control': 'no-store', ...extra };
  if (buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '') && !/^image\/|pdf/.test(type)) { buf = gzipSync(buf); h['content-encoding'] = 'gzip'; h.vary = 'accept-encoding'; }
  h['content-length'] = buf.length;
  res.writeHead(status, h);
  res.end(buf);
}
const fail = (req, res, status, message) => send(req, res, status, { error: message });

// ── Cloudflare Access ────────────────────────────────────────────────────
const jwks = { at: 0, keys: new Map() };
async function keyFor(kid) {
  if (!jwks.keys.has(kid) || Date.now() - jwks.at > 3600e3) {
    const r = await fetch(`https://${E.CF_TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    jwks.keys = new Map((j.keys || []).map((k) => [k.kid, createPublicKey({ key: k, format: 'jwk' })]));
    jwks.at = Date.now();
  }
  return jwks.keys.get(kid);
}
const b64u = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
function cookie(req, name) {
  for (const c of (req.headers.cookie || '').split(';')) { const i = c.indexOf('='); if (c.slice(0, i).trim() === name) return c.slice(i + 1).trim(); }
  return '';
}
/** The signed-in email, or null. Every page request goes through this. */
async function who(req) {
  if (AUTH_OFF) return 'local@test';
  if (!E.CF_TEAM || !E.CF_AUD || !ALLOWED.size) return null;
  const tok = req.headers['cf-access-jwt-assertion'] || cookie(req, 'CF_Authorization');
  const parts = String(tok).split('.');
  if (parts.length !== 3) return null;
  try {
    const head = JSON.parse(b64u(parts[0])), claims = JSON.parse(b64u(parts[1]));
    if (head.alg !== 'RS256') return null;
    const key = await keyFor(head.kid);
    if (!key || !verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), key, b64u(parts[2]))) return null;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const now = Date.now() / 1000;
    if (!aud.includes(E.CF_AUD) || claims.iss !== `https://${E.CF_TEAM}.cloudflareaccess.com` || !(claims.exp > now) || (claims.nbf && claims.nbf > now + 60)) return null;
    const email = String(claims.email || '').toLowerCase();
    return ALLOWED.has(email) ? email : null;
  } catch { return null; }
}

// ── the page's API ───────────────────────────────────────────────────────
const ACTIONS = new Set(['burn', 'stop-after-job', 'stop-now', 'start-round', 'driver', 'settings', 'blacklist', 'skip', 'alert', 'scan', 'read']);
function machinesView() {
  const now = Date.now();
  return q.machines.all().map((m) => ({ machine: m.machine, hello: m.hello ? JSON.parse(m.hello) : null, lastSeen: m.last_seen, online: now - m.last_seen < OFFLINE_AFTER }));
}
const cmdRow = (c) => ({ id: c.id, machine: c.machine, action: c.action, args: JSON.parse(c.args || '{}'), status: c.status, message: c.message, by: c.by, created: c.created, updated: c.updated, hasData: !!c.hasData });

async function page(req, res) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') return send(req, res, 200, { ok: true });   // the container's health check, nothing else
  const email = await who(req);
  if (!email) return fail(req, res, 403, 'Sign in through Cloudflare Access first.');
  if (url.pathname === '/api/v1/changes' && req.method === 'GET') {
    const since = Math.max(0, +url.searchParams.get('since') || 0);
    const rev = q.revNow.get().v;
    const recs = since ? q.since.all(since) : q.all.all();
    return send(req, res, 200, {
      rev, full: !since, me: email, now: Date.now(), machines: machinesView(),
      records: recs.map((r) => (r.deleted ? { m: r.machine, t: r.t, k: r.k, x: 1 } : { m: r.machine, t: r.t, k: r.k, d: JSON.parse(r.d) })),
      commands: q.cmdSince.all(since ? since : Math.max(0, rev - 5000)).map(cmdRow),
    });
  }
  if (url.pathname === '/api/v1/commands' && req.method === 'POST') {
    const b = await body(req);
    if (!ACTIONS.has(b.action)) return fail(req, res, 400, 'Unknown action');
    const machine = String(b.machine || '');
    if (!machinesView().some((m) => m.machine === machine)) return fail(req, res, 400, 'Unknown machine');
    const id = randomUUID(), now = Date.now();
    q.cmdAdd.run(id, machine, b.action, JSON.stringify(b.args || {}), email, now, now, nextRev());
    say(`command ${id} ${b.action} for ${machine} by ${email}`);
    return send(req, res, 200, { id });
  }
  let m = /^\/api\/v1\/commands\/([0-9a-f-]{36})(\/file|\/cancel)?$/.exec(url.pathname);
  if (m) {
    const c = q.cmdGet.get(m[1]);
    if (!c) return fail(req, res, 404, 'No such command');
    if (m[2] === '/cancel' && req.method === 'POST') {
      if (c.status !== 'queued') return fail(req, res, 409, 'It already reached the machine');
      q.cmdSetAny.run('cancelled', 'Cancelled before it reached the machine', Date.now(), nextRev(), c.id);
      return send(req, res, 200, { ok: true });
    }
    if (m[2] === '/file') {
      const d = c.data ? JSON.parse(c.data) : null;
      if (!d?.b64) return fail(req, res, 404, 'No file (it is kept 10 minutes)');
      const name = String(d.name || 'file').replace(/[^\w.-]/g, '_');
      return send(req, res, 200, Buffer.from(d.b64, 'base64'), d.type || 'application/octet-stream', { 'content-disposition': `inline; filename="${name}"` });
    }
    return send(req, res, 200, cmdRow({ ...c, hasData: c.data != null }));
  }
  if (url.pathname.startsWith('/api/')) return fail(req, res, 404, 'Not found');
  return statics(req, res, url.pathname);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
function statics(req, res, path) {
  const rel = normalize(path === '/' ? '/index.html' : path).replace(/^([/\\])+/, '');
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC) || !existsSync(file) || !statSync(file).isFile()) return statics(req, res, '/');
  const type = MIME[extname(file)] || 'application/octet-stream';
  return send(req, res, 200, readFileSync(file), type, { 'cache-control': rel === 'index.html' ? 'no-store' : 'no-cache' });
}

// ── the agents' API ──────────────────────────────────────────────────────
// AGENT_FROM (e.g. "100.64.0.0/10", Tailscale's addresses): agents are only heard from there.
const FROM = (E.AGENT_FROM || '').split(',').map((x) => x.trim()).filter(Boolean).map((c) => {
  const [ip, bits] = c.split('/'); const n = ip.split('.').reduce((a, b) => a * 256 + +b, 0);
  const mask = bits ? (2 ** 32 - 2 ** (32 - +bits)) : 2 ** 32 - 1;
  return { net: n - (n % 2 ** (32 - (+bits || 32))), mask, bits: +bits || 32 };
});
function fromOk(req) {
  if (!FROM.length) return true;
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  const n = ip.split('.').reduce((a, b) => a * 256 + +b, 0);
  return FROM.some((f) => n - (n % 2 ** (32 - f.bits)) === f.net);
}
function agentOk(req) {
  if (!fromOk(req)) return null;
  const machine = String(req.headers['x-machine'] || '');
  const key = KEYS.get(machine);
  const got = String(req.headers.authorization || '').replace(/^Bearer /, '');
  if (!key || !got) return null;
  const a = createHash('sha256').update(key).digest(), b = createHash('sha256').update(got).digest();
  return timingSafeEqual(a, b) ? machine : null;
}
async function agent(req, res) {
  const machine = agentOk(req);
  if (!machine) return fail(req, res, 401, 'Unknown machine or key');
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/agent/v1/sync' && req.method === 'POST') {
    const b = await body(req);
    const now = Date.now();
    const out = tx(() => {
      const ups = Array.isArray(b.upserts) ? b.upserts : [];
      for (const r of ups) if (r && r.t && r.k != null) q.upsert.run(machine, String(r.t), String(r.k), JSON.stringify(r.d ?? null), nextRev());
      for (const id of Array.isArray(b.deletes) ? b.deletes : []) { const i = id.indexOf('|'); if (i > 0) q.del.run(nextRev(), machine, id.slice(0, i), id.slice(i + 1)); }
      q.seen.run(machine, b.hello ? JSON.stringify(b.hello) : null, now, nextRev());
      const cmds = q.cmdQueued.all(machine);
      for (const c of cmds) q.cmdSet.run('sent', 'Reached the machine', null, now, nextRev(), c.id, machine);
      return cmds.map((c) => ({ id: c.id, action: c.action, args: JSON.parse(c.args || '{}') }));
    });
    if ((b.upserts || []).length > 100) say(`${machine}: ${b.upserts.length} records`);
    return send(req, res, 200, { ok: true, commands: out });
  }
  if (url.pathname === '/agent/v1/result' && req.method === 'POST') {
    const b = await body(req);
    const st = ['running', 'done', 'failed'].includes(b.status) ? b.status : 'failed';
    q.cmdSet.run(st, String(b.message || '').slice(0, 2000), b.data ? JSON.stringify(b.data) : null, Date.now(), nextRev(), String(b.id), machine);
    return send(req, res, 200, { ok: true });
  }
  return fail(req, res, 404, 'Not found');
}

const guard = (fn) => (req, res) => fn(req, res).catch((e) => { if (!res.headersSent) fail(req, res, e.status || 500, e.status ? e.message : 'Server error'); if (!e.status) say(`error: ${e.stack}`); });
createServer(guard(page)).listen(PAGE_PORT, PAGE_HOST, () => say(`page on ${PAGE_HOST}:${PAGE_PORT}${AUTH_OFF ? ' (no login check: local test)' : ''}`));
createServer(guard(agent)).listen(AGENT_PORT, AGENT_HOST, () => say(`agents on ${AGENT_HOST}:${AGENT_PORT}, machines: ${[...KEYS.keys()].join(', ') || 'none'}`));
