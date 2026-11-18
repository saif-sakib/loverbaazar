-- Record mail intentions in the order transaction. Additive for API rollback.
CREATE TABLE order_notifications (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('owner','customer')),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','accepted','failed','uncertain')),
  payload JSONB NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  next_attempt TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  outcome TEXT NOT NULL DEFAULT '',
  UNIQUE(order_id, kind)
);
CREATE INDEX order_notifications_queue ON order_notifications(next_attempt,id)
  WHERE state IN ('pending','failed');
CREATE TABLE notification_daily_budget(day DATE PRIMARY KEY, recipients INTEGER NOT NULL CHECK(recipients>=0));

ALTER TABLE releases ADD COLUMN artifact_sha TEXT NOT NULL DEFAULT '';
