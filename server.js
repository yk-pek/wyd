const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { verifyMessage, getAddress, isAddress } = require('ethers');
const { pool, init } = require('./db');

const PORT = process.env.PORT || 3000;
const COOKIE = '__Host-wyd';
const SESSION_DAYS = 30;
const NONCE_MINUTES = 10;

const LIMITS = { title: 120, body: 5000, reply: 2000, name: 32 };

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '32kb' }));

// ---------- helpers ----------

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function requestHost(req) {
  return (req.get('x-forwarded-host') || req.get('host') || 'localhost').split(',')[0].trim();
}

function readCookie(req, name) {
  const header = req.get('cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function setSessionCookie(res, token, maxAgeSeconds) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`
  );
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function cleanText(value, field, max, { required = true } = {}) {
  if (typeof value !== 'string') {
    if (!required && (value === undefined || value === null)) return '';
    throw new HttpError(400, `${field} must be text`);
  }
  const text = value.replace(/\r\n/g, '\n').trim();
  if (required && !text) throw new HttpError(400, `${field} can't be empty`);
  if (text.length > max) throw new HttpError(400, `${field} is too long (max ${max} characters)`);
  return text;
}

// Simple in-memory rate limiter: at most `max` hits per `windowMs` per key.
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) throw new HttpError(429, 'Slow down a little and try again shortly');
  hits.push(now);
  buckets.set(key, hits);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, hits] of buckets) if (hits.every((t) => now - t > 3600_000)) buckets.delete(k);
}, 600_000).unref();

// Block cross-site writes: if a browser sends an Origin, it must be this site.
app.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const origin = req.get('origin');
    if (origin) {
      let host;
      try { host = new URL(origin).host; } catch { host = null; }
      if (host !== requestHost(req)) return res.status(403).json({ error: 'Cross-site request refused' });
    }
  }
  next();
});

// Load the signed-in user, if any.
app.use(wrap(async (req, res, next) => {
  req.user = null;
  const token = readCookie(req, COOKIE);
  if (token) {
    const { rows } = await pool.query(
      `SELECT u.address, u.display_name FROM sessions s JOIN users u ON u.address = s.address
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [sha256(token)]
    );
    if (rows[0]) req.user = rows[0];
  }
  next();
}));

function requireUser(req) {
  if (!req.user) throw new HttpError(401, 'Sign in with your wallet first');
  return req.user;
}

const AUTHOR_FIELDS = `p.author, COALESCE(u.display_name, '') AS author_name`;

// ---------- auth ----------

app.post('/api/auth/nonce', wrap(async (req, res) => {
  rateLimit(`nonce:${req.ip}`, 20, 600_000);
  const { address } = req.body || {};
  if (typeof address !== 'string' || !isAddress(address)) throw new HttpError(400, 'Invalid wallet address');
  const checksummed = getAddress(address);
  const nonce = crypto.randomBytes(16).toString('hex');
  const host = requestHost(req);
  const message =
    `${host} wants you to sign in with your Ethereum account:\n${checksummed}\n\n` +
    `Sign in to wyd. This only proves you own this address; it costs nothing and sends no transaction.\n\n` +
    `URI: https://${host}\nVersion: 1\nChain ID: 1\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
  await pool.query('INSERT INTO nonces (nonce, address, message) VALUES ($1, $2, $3)', [
    nonce, checksummed.toLowerCase(), message,
  ]);
  res.json({ nonce, message });
}));

app.post('/api/auth/verify', wrap(async (req, res) => {
  rateLimit(`verify:${req.ip}`, 20, 600_000);
  const { nonce, signature } = req.body || {};
  if (typeof nonce !== 'string' || typeof signature !== 'string') throw new HttpError(400, 'Missing nonce or signature');

  // Each nonce can be used once, and only for a few minutes.
  const { rows } = await pool.query(
    `UPDATE nonces SET used = true
     WHERE nonce = $1 AND used = false AND created_at > now() - make_interval(mins => $2)
     RETURNING address, message`,
    [nonce, NONCE_MINUTES]
  );
  if (!rows[0]) throw new HttpError(400, 'Sign-in request expired, please try again');

  let recovered;
  try {
    recovered = verifyMessage(rows[0].message, signature).toLowerCase();
  } catch {
    throw new HttpError(400, 'Invalid signature');
  }
  if (recovered !== rows[0].address) throw new HttpError(401, 'Signature does not match the wallet address');

  await pool.query('INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING', [recovered]);
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO sessions (token_hash, address, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`,
    [sha256(token), recovered, SESSION_DAYS]
  );
  setSessionCookie(res, token, SESSION_DAYS * 86400);
  const user = await pool.query('SELECT address, display_name FROM users WHERE address = $1', [recovered]);
  res.json({ user: user.rows[0] });
}));

app.post('/api/auth/logout', wrap(async (req, res) => {
  const token = readCookie(req, COOKIE);
  if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
  setSessionCookie(res, '', 0);
  res.json({ ok: true });
}));

app.get('/api/me', (req, res) => res.json({ user: req.user }));

app.put('/api/me', wrap(async (req, res) => {
  const user = requireUser(req);
  const name = cleanText(req.body?.display_name, 'Display name', LIMITS.name, { required: false });
  const { rows } = await pool.query(
    'UPDATE users SET display_name = $1 WHERE address = $2 RETURNING address, display_name',
    [name || null, user.address]
  );
  res.json({ user: rows[0] });
}));

// ---------- posts ----------

app.get('/api/posts', wrap(async (req, res) => {
  const params = [];
  const where = [];
  const before = parseInt(req.query.before, 10);
  if (Number.isInteger(before) && before > 0) {
    params.push(before);
    where.push(`p.id < $${params.length}`);
  }
  if (typeof req.query.author === 'string' && isAddress(req.query.author)) {
    params.push(req.query.author.toLowerCase());
    where.push(`p.author = $${params.length}`);
  }
  const { rows } = await pool.query(
    `SELECT p.id, p.title, LEFT(p.body, 400) AS excerpt, LENGTH(p.body) > 400 AS truncated,
            p.created_at, ${AUTHOR_FIELDS},
            (SELECT COUNT(*)::int FROM replies r WHERE r.post_id = p.id) AS reply_count
     FROM posts p JOIN users u ON u.address = p.author
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY p.id DESC LIMIT 30`,
    params
  );
  res.json({ posts: rows, more: rows.length === 30 });
}));

app.post('/api/posts', wrap(async (req, res) => {
  const user = requireUser(req);
  rateLimit(`post:${user.address}`, 5, 600_000);
  const title = cleanText(req.body?.title, 'Title', LIMITS.title);
  const body = cleanText(req.body?.body, 'Post', LIMITS.body);
  const { rows } = await pool.query(
    'INSERT INTO posts (author, title, body) VALUES ($1, $2, $3) RETURNING id',
    [user.address, title, body]
  );
  res.status(201).json({ id: rows[0].id });
}));

function postId(req) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Post not found');
  return id;
}

app.get('/api/posts/:id', wrap(async (req, res) => {
  const id = postId(req);
  const post = await pool.query(
    `SELECT p.id, p.title, p.body, p.created_at, ${AUTHOR_FIELDS}
     FROM posts p JOIN users u ON u.address = p.author WHERE p.id = $1`,
    [id]
  );
  if (!post.rows[0]) throw new HttpError(404, 'Post not found');
  const replies = await pool.query(
    `SELECT p.id, p.body, p.created_at, ${AUTHOR_FIELDS}
     FROM replies p JOIN users u ON u.address = p.author WHERE p.post_id = $1 ORDER BY p.id`,
    [id]
  );
  res.json({ post: post.rows[0], replies: replies.rows });
}));

app.delete('/api/posts/:id', wrap(async (req, res) => {
  const user = requireUser(req);
  const { rowCount } = await pool.query('DELETE FROM posts WHERE id = $1 AND author = $2', [postId(req), user.address]);
  if (!rowCount) throw new HttpError(404, 'Post not found');
  res.json({ ok: true });
}));

app.post('/api/posts/:id/replies', wrap(async (req, res) => {
  const user = requireUser(req);
  rateLimit(`reply:${user.address}`, 20, 600_000);
  const id = postId(req);
  const body = cleanText(req.body?.body, 'Reply', LIMITS.reply);
  const exists = await pool.query('SELECT 1 FROM posts WHERE id = $1', [id]);
  if (!exists.rows[0]) throw new HttpError(404, 'Post not found');
  const { rows } = await pool.query(
    'INSERT INTO replies (post_id, author, body) VALUES ($1, $2, $3) RETURNING id',
    [id, user.address, body]
  );
  res.status(201).json({ id: rows[0].id });
}));

app.delete('/api/replies/:id', wrap(async (req, res) => {
  const user = requireUser(req);
  const { rowCount } = await pool.query('DELETE FROM replies WHERE id = $1 AND author = $2', [postId(req), user.address]);
  if (!rowCount) throw new HttpError(404, 'Reply not found');
  res.json({ ok: true });
}));

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ---------- frontend ----------

app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: '5m' }));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---------- errors ----------

app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

// ---------- start ----------

init()
  .then(() => {
    // Tidy up old sign-in requests and sessions every hour.
    setInterval(() => {
      pool.query(`DELETE FROM nonces WHERE created_at < now() - interval '1 day'`).catch(() => {});
      pool.query(`DELETE FROM sessions WHERE expires_at < now()`).catch(() => {});
    }, 3600_000).unref();
    app.listen(PORT, () => console.log(`wyd listening on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
  });
