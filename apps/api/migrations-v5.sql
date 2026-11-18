-- Leave the low numbers used by previously imported galleries available.
CREATE SEQUENCE product_photo_numbers START WITH 1000;
CREATE TABLE product_photo_saves (
  save_key TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  attempt TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  product_id BIGINT
);
CREATE TABLE product_photo_uploads (
  public_id TEXT PRIMARY KEY,
  attempt TEXT NOT NULL,
  storage TEXT NOT NULL,
  check_after TIMESTAMPTZ DEFAULT now() + interval '10 minutes'
);
CREATE INDEX product_photo_uploads_due ON product_photo_uploads(check_after);
