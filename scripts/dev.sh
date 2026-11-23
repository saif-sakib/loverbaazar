#!/usr/bin/env bash
# Full local stack. LB_ISOLATED=1 creates and removes task-owned fixtures.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -f "$ROOT/.env" ]]; then set -a; source "$ROOT/.env"; set +a; fi
for tool in docker go node npm curl python3 setsid; do command -v "$tool" >/dev/null || { echo "Install $tool first" >&2; exit 1; }; done
api_port=${LB_API_PORT:-8080}; store_port=${LB_STORE_PORT:-8787}; db_port=${LB_DB_PORT:-55432}
python3 - "$api_port" "$store_port" "$db_port" "${LB_ISOLATED:-0}" <<'PY'
import socket,sys
ports=[int(p) for p in sys.argv[1:4]]
if sys.argv[4] == "1" and ports[2] == 0:
    ports.pop()
if len(set(ports))!=len(ports) or any(p<1024 or p>65535 for p in ports): raise SystemExit('Choose three distinct local ports above 1023')
for port in ports[:2]:
    with socket.socket() as s:
        try:s.bind(('127.0.0.1',port))
        except OSError:raise SystemExit(f'Port {port} is in use; leave the existing process running or stop its owner first.')
PY
if [[ ${LB_ISOLATED:-0} == 1 ]]; then
 # Astro moves build assets with rename, so keep isolated builds inside the project filesystem.
 mkdir -p "$ROOT/apps/store/.astro"
 task_dir=$(mktemp -d "$ROOT/apps/store/.astro/lb-dev.XXXXXX")
else
 task_dir=$(mktemp -d)
fi
API=''; EDGE=''; db_name=lbpg
cleanup() {
 if [[ -n "$EDGE" ]]; then
  kill -TERM -- "-$EDGE" 2>/dev/null || true
  for _ in {1..10}; do kill -0 -- "-$EDGE" 2>/dev/null || break; sleep 0.2; done
  kill -KILL -- "-$EDGE" 2>/dev/null || true
 fi
 if [[ -n "$API" ]]; then
  kill -TERM "$API" 2>/dev/null || true
  for _ in {1..10}; do kill -0 "$API" 2>/dev/null || break; sleep 0.2; done
  kill -KILL "$API" 2>/dev/null || true
 fi
 if [[ ${LB_ISOLATED:-0} == 1 && "$db_name" != lbpg ]]; then docker rm -fv "$db_name" >/dev/null 2>&1 || true; fi
 rm -rf "$task_dir"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ ${LB_ISOLATED:-0} == 1 ]]; then
 db_name="lb-dev-test-$$"
 publish_port=$db_port
 if [[ $db_port == 0 ]]; then publish_port=""; fi
 docker run -d --rm --name "$db_name" -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=lb -p "127.0.0.1:$publish_port:5432" postgres:17-alpine >/dev/null
 if [[ $db_port == 0 ]]; then
  db_address=$(docker port "$db_name" 5432/tcp)
  db_port=${db_address##*:}
  [[ $db_port =~ ^[0-9]+$ ]] || { echo "Could not resolve the isolated PostgreSQL port" >&2; exit 1; }
 fi
else
 docker start lbpg >/dev/null 2>&1 || docker run -d --name lbpg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=lb -p "127.0.0.1:$db_port:5432" postgres:17-alpine >/dev/null
fi
for attempt in {1..60}; do
 if docker exec -e PGPASSWORD=dev "$db_name" psql -h 127.0.0.1 -U postgres -d lb -c 'SELECT 1' >/dev/null 2>&1; then break; fi
 [[ $attempt != 60 ]] || { echo 'Local database startup timed out' >&2; exit 1; }; sleep 0.5
done
export APP_ENV=local DEV=1 PORT="$api_port"
export DATABASE_URL="postgres://postgres:dev@127.0.0.1:$db_port/lb?sslmode=disable"
export ADMIN_TOKEN=local-admin-token-for-this-computer-only
unset ORIGIN_SECRET TURNSTILE_SECRET TURNSTILE_SITE PUBLIC_TURNSTILE_SITE BREVO_KEY GITHUB_TOKEN GITHUB_REPO PUBLISH_TOKEN
export LOCAL_UPLOADS="$ROOT/apps/store/public/uploads" DEV_BUILD_DIR="$ROOT/apps/store"
cd "$ROOT/apps/store"
[[ -d node_modules ]] || npm ci --no-audit --no-fund
BIN="$task_dir/api"
seed_mode=seed
if [[ ${LB_ISOLATED:-0} == 1 ]]; then seed_mode=seed-fixture; fi
(cd "$ROOT/apps/api" && go build -o "$BIN" . && "$BIN" "$seed_mode" seed/products.json ../store/src/data/content.json)
export BUILD_OUTPUT="$ROOT/apps/store/dist"
if [[ ${LB_ISOLATED:-0} == 1 ]]; then
 export BUILD_OUTPUT="$task_dir/store" BUILD_PUBLIC_DIR="$task_dir/public"
 mkdir -p "$BUILD_PUBLIC_DIR"
 for asset in "$ROOT/apps/store/public/"*; do
  [[ ${asset##*/} == uploads ]] || cp -a "$asset" "$BUILD_PUBLIC_DIR/"
 done
 export LOCAL_UPLOADS="$BUILD_PUBLIC_DIR/uploads"
fi
"$BIN" & API=$!
for attempt in {1..150}; do
 if curl --max-time 2 -sf "http://127.0.0.1:$api_port/api/ready" >/dev/null; then break; fi
 [[ $attempt != 150 ]] || { echo 'API readiness timed out' >&2; exit 1; }
 kill -0 "$API" 2>/dev/null || exit 1; sleep 0.2
done
export BUILD_ENV=local CATALOG_URL="http://127.0.0.1:$api_port/api/catalog"
node node_modules/.bin/astro build --outDir "$BUILD_OUTPUT" >/dev/null
printf '\nShop: http://127.0.0.1:%s/\nAdmin: http://127.0.0.1:%s/admin/\n' "$store_port" "$store_port"
WRANGLER_SEND_METRICS=false setsid npx wrangler dev --assets "$BUILD_OUTPUT" --port "$store_port" --ip 127.0.0.1 --var "API_ORIGIN:http://127.0.0.1:$api_port" --var ORIGIN_SECRET:dev & EDGE=$!
wait "$EDGE"
