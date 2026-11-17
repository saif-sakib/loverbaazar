-- Prelaunch migration closes permanently on the first new-store order.
CREATE TABLE catalog_migration_gate(id INT PRIMARY KEY CHECK(id=1), phase TEXT NOT NULL CHECK(phase IN('prelaunch','closed')));
INSERT INTO catalog_migration_gate VALUES(1,CASE WHEN EXISTS(SELECT 1 FROM orders) THEN 'closed' ELSE 'prelaunch' END);
CREATE TABLE catalog_imported(kind TEXT NOT NULL, key TEXT NOT NULL, origin TEXT NOT NULL, PRIMARY KEY(kind,key));
CREATE TABLE catalog_import_batches(digest TEXT PRIMARY KEY, source_digest TEXT NOT NULL, approved_by TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE FUNCTION close_catalog_migration() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN UPDATE catalog_migration_gate SET phase='closed' WHERE id=1 AND phase='prelaunch'; RETURN NEW; END $$;
CREATE TRIGGER order_closes_catalog_migration AFTER INSERT ON orders FOR EACH ROW EXECUTE FUNCTION close_catalog_migration();
