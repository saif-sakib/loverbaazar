#!/usr/bin/env bash
# Optional source-side integration: no public ports, no real site/accounts or hosting changes.
set -euo pipefail
cd "$(dirname "$0")/.."
wordpress_work=$(mktemp -d)
wordpress_tag="lb-wp-export-test-$$"
printf 'memory_limit=512M\n' > "$wordpress_work/php-fixture.ini"
wordpress_uid=$(id -u); wordpress_gid=$(id -g)
cleanup() {
 docker rm -f "$wordpress_tag-db" >/dev/null 2>&1 || true
 docker volume rm "$wordpress_tag-files" >/dev/null 2>&1 || true
 docker network rm "$wordpress_tag-net" >/dev/null 2>&1 || true
 rm -rf "$wordpress_work"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker network create "$wordpress_tag-net" >/dev/null
docker volume create "$wordpress_tag-files" >/dev/null
docker run -d --rm --name "$wordpress_tag-db" --network "$wordpress_tag-net" -e MARIADB_ROOT_PASSWORD=fixture -e MARIADB_DATABASE=wordpress -e MARIADB_USER=fixture -e MARIADB_PASSWORD=fixture mariadb:11 >/dev/null
for attempt in {1..90}; do
 if docker exec "$wordpress_tag-db" healthcheck.sh --connect --innodb_initialized >/dev/null 2>&1; then break; fi
 [[ $attempt != 90 ]] || { echo 'Fixture database timed out' >&2; exit 1; }
 sleep 1
done
docker run --rm --user 0 -v "$wordpress_tag-files:/var/www/html" --entrypoint chown wordpress:cli-php8.3 -R "$wordpress_uid:$wordpress_gid" /var/www/html
docker run --rm --user "$wordpress_uid:$wordpress_gid" --network "$wordpress_tag-net" -e WP_CLI_CACHE_DIR=/tmp/lb-wp-cache -e LB_FIXTURE_DB_HOST="$wordpress_tag-db" \
 -v "$wordpress_tag-files:/var/www/html" -v "$wordpress_work/php-fixture.ini:/usr/local/etc/php/conf.d/lb-fixture.ini:ro" -v "$wordpress_work:/private" -v "$PWD/scripts/export-wordpress.php:/opt/export.php:ro" -v "$PWD/scripts/migration/wordpress_fixture.php:/opt/fixture.php:ro" \
 --entrypoint sh wordpress:cli-php8.3 -ec '
 wp core download
 wp config create --dbname=wordpress --dbuser=fixture --dbpass=fixture --dbhost="$LB_FIXTURE_DB_HOST" --skip-check
 wp config set DISABLE_WP_CRON true --raw
 wp config set WP_MEMORY_LIMIT 512M
 wp core install --url=https://shop.example --title="LoverBaazar export fixture" --admin_user=fixture --admin_password=Local-fixture-only --admin_email=fixture@example.invalid --skip-email
 wp plugin install woocommerce --activate
 wp eval-file /opt/fixture.php
 wp eval-file /opt/export.php /private/export
 wp eval "echo json_encode(array(\"wordpress\"=>get_bloginfo(\"version\"),\"woocommerce\"=>WC_VERSION));"
 '
PYTHONPATH=scripts python3 - "$wordpress_work/export" <<'PY'
import sys
from migration.core import load_bundle,normalize,legacy_archive
b=load_bundle(sys.argv[1])
assert len(b['products'])==105, len(b['products'])
assert isinstance(b['manifest']['hpos_enabled'], bool)
assert b['orders'][0]['legacy_stock_reduced'] is True
assert len(b['orders'])==1, len(b['orders'])
assert b['products'][0]['seo']['title']=='Fixture preserved SEO'
c=normalize(b)
assert len(c['review'])==105
assert next(r['value'] for r in c['records'] if r['kind']=='page' and r['key']=='protected-fixture')['draft'] is True
assert 'Do-not-export-this-fixture-password' not in __import__('json').dumps(b)
assert next(p for p in b['products'] if p['slug']=='fixture-product-1')['stock_quantity']==2
assert len([p for p in b['products'] if p['type']=='variation'])==1
assert all(not r['active'] for r in c['review'] if r['id'] in {p['id'] for p in b['products'] if p['type'] in {'variable','variation'}})
assert any(r['value']['title']=='পরীক্ষার পাতা' for r in c['records'] if r['kind']=='page')
a=legacy_archive(b,sys.argv[1]+'/archive.sqlite')
assert a['outstanding_orders']==1
print('\nPASS: real WordPress/WooCommerce private export, 105 product/variation records across pages, native stock/orders/customers, Rank Math metadata, Bangla page and private archive.')
PY
