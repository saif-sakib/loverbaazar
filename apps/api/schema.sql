-- Safe to run on every start: everything here is IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS products(
  id BIGINT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, price BIGINT NOT NULL CHECK(price>=0),
  regular BIGINT NOT NULL, stock INT NOT NULL DEFAULT 0 CHECK(stock>=0), active BOOL NOT NULL DEFAULT TRUE, data JSONB NOT NULL);
-- Products added in admin start well above the WordPress ids.
CREATE SEQUENCE IF NOT EXISTS product_ids START 10000000;

CREATE TABLE IF NOT EXISTS users(
  id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, phone TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users ON DELETE CASCADE, expires_at TIMESTAMPTZ NOT NULL);

CREATE TABLE IF NOT EXISTS orders(
  id BIGSERIAL PRIMARY KEY, number TEXT UNIQUE NOT NULL, user_id BIGINT REFERENCES users, name TEXT NOT NULL, phone TEXT NOT NULL,
  address TEXT NOT NULL, area TEXT NOT NULL, payment TEXT NOT NULL, txn_id TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
  subtotal BIGINT NOT NULL, shipping BIGINT NOT NULL, total BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT now());
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount BIGINT NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS admin_note TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS idem TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS orders_idem ON orders(idem);
CREATE INDEX IF NOT EXISTS orders_recent ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS orders_phone ON orders(phone);
CREATE TABLE IF NOT EXISTS order_items(
  order_id BIGINT NOT NULL REFERENCES orders ON DELETE CASCADE, product_id BIGINT NOT NULL REFERENCES products,
  name TEXT NOT NULL, price BIGINT NOT NULL, qty INT NOT NULL CHECK(qty>0), PRIMARY KEY(order_id,product_id));
CREATE TABLE IF NOT EXISTS order_events(
  order_id BIGINT NOT NULL REFERENCES orders ON DELETE CASCADE, status TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS order_events_order ON order_events(order_id);

CREATE TABLE IF NOT EXISTS messages(id BIGSERIAL PRIMARY KEY, name TEXT, contact TEXT, body TEXT, created_at TIMESTAMPTZ DEFAULT now());
ALTER TABLE messages ADD COLUMN IF NOT EXISTS read BOOL NOT NULL DEFAULT FALSE;

-- Shop settings: 'live' takes effect at once, 'site' needs Publish. A missing row means defaults.json.
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, data JSONB NOT NULL);
-- One-time updates that have already run, so a deploy can never repeat one over the admin's edits.
CREATE TABLE IF NOT EXISTS applied(name TEXT PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now());
-- Categories, tags, pages and blog posts.
CREATE TABLE IF NOT EXISTS content(kind TEXT NOT NULL CHECK(kind IN('cat','tag','page','post')), slug TEXT NOT NULL, data JSONB NOT NULL, PRIMARY KEY(kind,slug));

CREATE TABLE IF NOT EXISTS coupons(
  code TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN('percent','amount')), value BIGINT NOT NULL CHECK(value>0),
  min_order BIGINT NOT NULL DEFAULT 0, max_uses INT NOT NULL DEFAULT 0, used INT NOT NULL DEFAULT 0 CHECK(used>=0),
  expires_at TIMESTAMPTZ, active BOOL NOT NULL DEFAULT TRUE);

CREATE TABLE IF NOT EXISTS reviews(
  id BIGSERIAL PRIMARY KEY, product_id BIGINT NOT NULL REFERENCES products ON DELETE CASCADE, name TEXT NOT NULL,
  rating INT NOT NULL CHECK(rating BETWEEN 1 AND 5), body TEXT NOT NULL, approved BOOL NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS reviews_product ON reviews(product_id);
