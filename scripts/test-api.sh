#!/usr/bin/env bash
# Own container and randomly assigned loopback port; never uses DATABASE_URL/.env/lbpg.
set -euo pipefail
cd "$(dirname "$0")/.."
name="lb-test-$$"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
docker run -d --rm --name "$name" -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=lb_test -p 127.0.0.1::5432 postgres:17-alpine >/dev/null
ready=false
for i in {1..60}; do if docker exec "$name" pg_isready -U postgres -d lb_test -q; then ready=true; break; fi; sleep 0.5; done
$ready || { echo 'Test database did not start' >&2; exit 1; }
port=$(docker port "$name" 5432/tcp | cut -d: -f2)
export TEST_DATABASE_URL="postgres://postgres:dev@127.0.0.1:$port/lb_test?sslmode=disable"
unset DATABASE_URL ORIGIN_SECRET BREVO_KEY CLOUDINARY_KEY CLOUDINARY_SECRET GITHUB_TOKEN TURNSTILE_SECRET
cd apps/api
go test -race -count=1 "$@" .
