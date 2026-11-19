ALTER TABLE order_notifications DROP CONSTRAINT order_notifications_kind_check;
ALTER TABLE order_notifications ADD CONSTRAINT order_notifications_kind_check
  CHECK(kind IN ('owner','customer','customer_shipped','customer_cancelled','customer_returned'));
