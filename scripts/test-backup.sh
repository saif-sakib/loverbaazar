#!/usr/bin/env bash
# Own a disposable PostgreSQL server and keep all artifacts outside the checkout.
set -euo pipefail
cd "$(dirname "$0")/.."
work=$(mktemp -d)
name="lb-backup-test-$$"
cleanup() {
  docker rm -fv "$name" >/dev/null 2>&1 || true
  python3 -c 'import pathlib,shutil,sys; shutil.rmtree(pathlib.Path(sys.argv[1]))' "$work"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
docker run -d --rm --name "$name" -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=lb_test -p 127.0.0.1::5432 postgres:17-alpine >/dev/null
for i in {1..60}; do
  if docker exec -e PGPASSWORD=dev "$name" psql -h 127.0.0.1 -U postgres -d lb_test -c 'SELECT 1' >/dev/null 2>&1; then break; fi
  [[ $i != 60 ]] || exit 1
  sleep 0.5
done
db_port=$(docker port "$name" 5432/tcp | cut -d: -f2)
export DATABASE_URL="postgresql://postgres:dev@127.0.0.1:$db_port/lb_test?sslmode=disable"
export BACKUP_DATABASE_URL="$DATABASE_URL"
export RESTORE_DATABASE_URL="postgresql://postgres:dev@127.0.0.1:$db_port/lb_restore?sslmode=disable"
export BACKUP_PASSPHRASE
BACKUP_PASSPHRASE=$(openssl rand -hex 32)
export APP_ENV=local DEV=1 LB_ISOLATED=1 ADMIN_TOKEN=local-admin-token-for-this-computer-only
unset ORIGIN_SECRET TURNSTILE_SECRET BREVO_KEY SHOP_EMAIL ADMIN_EMAIL
(cd apps/api && go build -o "$work/api" . && "$work/api" catalog-snapshot "$work/empty.json")
sql() { docker exec "$name" psql -v ON_ERROR_STOP=1 -XAt -U postgres -d "$1" -c "$2"; }
sql lb_test "$(cat <<'SQL'
INSERT INTO products VALUES(1,'fixture-widget',1250,1500,3,true,'{"id":1,"name":"Fixture","images":[{"src":"https://res.cloudinary.com/fixture/image/upload/media.jpg"}]}');
INSERT INTO settings VALUES('live','{"ordersOpen":true}');
INSERT INTO content VALUES('page','example','{"slug":"example","title":"Example"}');
INSERT INTO orders(id,number,name,phone,address,area,payment,subtotal,shipping,total)
VALUES(1,'LB-FIXTURE-A','Fixture','01710000000','Fixture address','Jashore','COD',1250,60,1310);
INSERT INTO order_items VALUES(1,1,'Fixture',1250,1);
SQL
)" >/dev/null
started=$SECONDS
python3 scripts/backup-store.py create "$work/verified.tar.gpg"
python3 scripts/backup-store.py verify "$work/verified.tar.gpg"
if BACKUP_DATABASE_URL='postgresql://postgres:invalid@127.0.0.1:1/lb_test' python3 scripts/backup-store.py create "$work/failed.tar.gpg"; then exit 1; fi
test ! -e "$work/failed.tar.gpg"
if BACKUP_PASSPHRASE='weak' python3 scripts/backup-store.py create "$work/weak.tar.gpg"; then exit 1; fi
test ! -e "$work/weak.tar.gpg"
touch "$work/empty.tar.gpg"
head -c 100 "$work/verified.tar.gpg" > "$work/corrupt.tar.gpg"
for bad in empty corrupt; do
  if python3 scripts/backup-store.py verify "$work/$bad.tar.gpg"; then exit 1; fi
done
sql lb_test "
INSERT INTO orders(id,number,name,phone,address,area,payment,subtotal,shipping,total)
VALUES(2,'LB-FIXTURE-B','Fixture','01710000001','Fixture address','Jashore','COD',1250,60,1310);
INSERT INTO order_items VALUES(2,1,'Fixture',1250,1);
UPDATE products SET stock=stock-1 WHERE id=1;" >/dev/null
sql postgres 'CREATE DATABASE lb_restore' >/dev/null
restore_started=$SECONDS
python3 scripts/backup-store.py restore "$work/verified.tar.gpg"
restore_elapsed=$((SECONDS - restore_started))
[[ $(sql lb_restore 'SELECT count(*)||'\'','\''||sum(total) FROM orders') == '1,1310' ]]
[[ $(sql lb_restore "SELECT stock||','||price FROM products WHERE id=1") == '3,1250' ]]
[[ $(sql lb_restore "SELECT data#>>'{images,0,src}' FROM products WHERE id=1") == 'https://res.cloudinary.com/fixture/image/upload/media.jpg' ]]
[[ $(sql lb_restore "SELECT data->>'ordersOpen' FROM settings WHERE key='live'") == 'true' ]]
[[ $(sql lb_restore "SELECT data->>'title' FROM content WHERE slug='example'") == 'Example' ]]
[[ $(sql lb_test "SELECT count(*)||','||sum(total) FROM orders") == '2,2620' ]]
[[ $(sql lb_test 'SELECT stock FROM products WHERE id=1') == '2' ]]
if python3 scripts/backup-store.py restore "$work/verified.tar.gpg"; then exit 1; fi
if RESTORE_DATABASE_URL="$BACKUP_DATABASE_URL" python3 scripts/backup-store.py restore "$work/verified.tar.gpg"; then exit 1; fi
echo "PASS: encrypted snapshot, independent restore in ${restore_elapsed}s, source order delta retained, invalid target and corrupt/empty/dump/key failures refused. Total $((SECONDS-started))s."
