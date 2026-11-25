CREATE OR REPLACE FUNCTION editorial_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='products' AND TG_OP='UPDATE' THEN
  IF (OLD.data - ARRAY['price','regular','inStock']) IS NOT DISTINCT FROM (NEW.data - ARRAY['price','regular','inStock'])
     AND OLD.slug=NEW.slug
     AND OLD.active=NEW.active
     AND (OLD.regular > OLD.price) = (NEW.regular > NEW.price) THEN
   RETURN NULL;
  END IF;
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
