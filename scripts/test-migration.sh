#!/usr/bin/env bash
# Private artifacts, owned disposable lb_test database, no business data or hosting writes.
set -euo pipefail
cd "$(dirname "$0")/.."
migration_work=$(mktemp -d)
migration_container="lb-migration-test-$$"
cleanup() { docker rm -fv "$migration_container" >/dev/null 2>&1 || true; rm -rf "$migration_work"; }
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
docker run -d --rm --name "$migration_container" -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=lb_test -p 127.0.0.1::5432 postgres:17-alpine >/dev/null
for attempt in {1..60}; do
 if docker exec -e PGPASSWORD=dev "$migration_container" psql -h 127.0.0.1 -U postgres -d lb_test -c 'SELECT 1' >/dev/null 2>&1; then break; fi
 [[ $attempt != 60 ]] || exit 1
 sleep .5
done
migration_port=$(docker port "$migration_container" 5432/tcp | cut -d: -f2)
export DATABASE_URL="postgres://postgres:dev@127.0.0.1:$migration_port/lb_test?sslmode=disable"
export APP_ENV=local MIGRATION_MAINTENANCE=1 LB_MIGRATION_CONTAINER="$migration_container" PYTHONPATH=scripts
unset ORIGIN_SECRET ADMIN_TOKEN BREVO_KEY CLOUDINARY_KEY CLOUDINARY_SECRET GITHUB_TOKEN TURNSTILE_SECRET
(cd apps/api && go build -o "$migration_work/api" .)
python3 -m migration.rehearse "$migration_work/api" "$migration_work"
