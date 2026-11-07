#!/usr/bin/env bash
# Starts everything locally. Run from anywhere: ./scripts/dev.sh  (Ctrl+C stops it)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
docker start lbpg >/dev/null 2>&1 || docker run -d --name lbpg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=lb -p 55432:5432 postgres:17-alpine >/dev/null
until docker exec lbpg pg_isready -U postgres -d lb -q; do sleep 0.5; done; sleep 1
export DATABASE_URL='postgres://postgres:dev@127.0.0.1:55432/lb?sslmode=disable' DEV=1 PORT=8080
export ADMIN_TOKEN=local-admin-token-for-this-computer-only
export LOCAL_UPLOADS="$ROOT/apps/store/public/uploads" DEV_BUILD_DIR="$ROOT/apps/store"
cd "$ROOT/apps/store"
[ -d node_modules ] || npm i --no-audit --no-fund
BIN="$(mktemp -d)/api"
(cd "$ROOT/apps/api" && go build -o "$BIN" . && "$BIN" seed seed/products.json ../store/src/data/content.json)
"$BIN" & API=$!
trap 'kill $API 2>/dev/null' EXIT
until curl -sf http://127.0.0.1:8080/api/health >/dev/null; do sleep 0.2; done
CATALOG_URL=http://127.0.0.1:8080/api/catalog npx astro build >/dev/null
echo; echo "  Shop:  http://127.0.0.1:8787/"; echo "  Admin: http://127.0.0.1:8787/admin/"; echo "  Admin token: $ADMIN_TOKEN (local only)"; echo
WRANGLER_SEND_METRICS=false npx wrangler dev --port 8787 --ip 127.0.0.1 --var API_ORIGIN:http://127.0.0.1:8080 --var ORIGIN_SECRET:dev
