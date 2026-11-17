ALTER TABLE orders ADD COLUMN IF NOT EXISTS request_hash TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS publication_state(id INT PRIMARY KEY CHECK(id=1), revision BIGINT NOT NULL DEFAULT 0, published BIGINT NOT NULL DEFAULT -1);
INSERT INTO publication_state(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS releases(id TEXT PRIMARY KEY, key_hash TEXT NOT NULL, revision BIGINT NOT NULL, state TEXT NOT NULL CHECK(state IN ('queued','running','failed','published','superseded')), payload JSONB NOT NULL, commit_sha TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS retired_images(url TEXT PRIMARY KEY, retired_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE OR REPLACE FUNCTION editorial_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='products' AND TG_OP='UPDATE' THEN
  IF (OLD.data - ARRAY['price','regular','inStock']) IS NOT DISTINCT FROM (NEW.data - ARRAY['price','regular','inStock']) AND OLD.slug=NEW.slug THEN RETURN NULL; END IF;
 END IF;
 IF TG_TABLE_NAME='settings' THEN
  IF TG_OP='DELETE' THEN IF OLD.key<>'site' THEN RETURN NULL; END IF;
  ELSE IF NEW.key<>'site' THEN RETURN NULL; END IF;
  END IF;
  IF TG_OP='UPDATE' AND OLD.data=NEW.data THEN RETURN NULL; END IF;
 END IF;
 UPDATE publication_state SET revision=revision+1 WHERE id=1;
 RETURN NULL;
END $$;
DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['products','content','settings','reviews'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS editorial_revision ON %I',t);
  EXECUTE format('CREATE TRIGGER editorial_revision AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION editorial_changed()',t);
 END LOOP;
END $$;
