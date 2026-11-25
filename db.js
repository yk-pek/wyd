const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  address      TEXT PRIMARY KEY,
  display_name TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nonces (
  nonce      TEXT PRIMARY KEY,
  address    TEXT NOT NULL,
  message    TEXT NOT NULL,
  used       BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  address    TEXT NOT NULL REFERENCES users(address) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id         SERIAL PRIMARY KEY,
  author     TEXT NOT NULL REFERENCES users(address) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS posts_author_idx ON posts(author, id DESC);

CREATE TABLE IF NOT EXISTS replies (
  id         SERIAL PRIMARY KEY,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author     TEXT NOT NULL REFERENCES users(address) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS replies_post_idx ON replies(post_id, id);

-- Sign-in requests remember which chain they're for ('eth' or 'sol').
ALTER TABLE nonces ADD COLUMN IF NOT EXISTS chain TEXT NOT NULL DEFAULT 'eth';

-- Ideas: a post of kind 'idea' is a suggestion for something to build.
ALTER TABLE posts ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'update';
CREATE INDEX IF NOT EXISTS posts_kind_idx ON posts(kind, id DESC);

CREATE TABLE IF NOT EXISTS idea_votes (
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  address    TEXT NOT NULL REFERENCES users(address) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, address)
);

CREATE TABLE IF NOT EXISTS idea_builders (
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  address    TEXT NOT NULL REFERENCES users(address) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, address)
);
`;

async function init() {
  // The database silo may still be starting when the app boots, so retry for a while.
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query(SCHEMA);
      return;
    } catch (err) {
      if (attempt >= 30) throw err;
      console.log(`Database not ready (${err.code || err.message}), retrying in 2s...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

module.exports = { pool, init };
