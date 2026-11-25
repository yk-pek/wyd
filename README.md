# wyd

**what are you doing?** A small forum where people post what they're working on and reply to each other.

- Sign in with an Ethereum wallet (a free signature, no transaction).
- Write posts, reply to posts, delete your own posts and replies.
- Set an optional display name. Profiles list a person's posts.

## Stack

- Node.js + Express 5, plain HTML/CSS/JS frontend in `public/` (no build step)
- PostgreSQL (tables are created on startup)
- Wallet sign-in: the server issues a one-time message with a nonce, the wallet signs it with `personal_sign`, the server checks the signature with `ethers.verifyMessage`, then sets a `__Host-wyd` session cookie (Secure, HttpOnly, SameSite=Lax). Sessions last 30 days.

## Run

```sh
npm install
DATABASE_URL=postgres://user:pass@localhost/wyd PORT=3000 npm start
```

Note: the session cookie is `Secure`, so browsers only keep it over HTTPS (or on `localhost` in most browsers).

## Deploy on SILOS

Node.js silo built from this repo, with `DATABASE_URL={{wyd-db.url}}` pointing at a Postgres silo named `wyd-db`.
