CREATE TABLE IF NOT EXISTS analytics_daily(
  day DATE PRIMARY KEY,
  visitors BIGINT NOT NULL DEFAULT 0 CHECK(visitors>=0),
  pageviews BIGINT NOT NULL DEFAULT 0 CHECK(pageviews>=0),
  sample_rate DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK(sample_rate>=1),
  source TEXT NOT NULL DEFAULT 'cloudflare_rum',
  finalized BOOL NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
