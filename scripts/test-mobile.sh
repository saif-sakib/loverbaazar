#!/usr/bin/env bash
# Own a temporary full stack; never write ordinary local or cloud shop data.
set -euo pipefail
cd "$(dirname "$0")/.."
export LB_ISOLATED=1
export LB_API_PORT=${LB_API_PORT:-18081} LB_STORE_PORT=${LB_STORE_PORT:-18788} LB_DB_PORT=${LB_DB_PORT:-0}
export SHOP_URL="http://127.0.0.1:$LB_STORE_PORT"
# Refuse occupied ports before waiting; otherwise readiness could belong to somebody else.
python3 - "$LB_API_PORT" "$LB_STORE_PORT" "$LB_DB_PORT" <<'PY'
import socket,sys
# The default isolated database is published on a port assigned by Docker.
ports = sys.argv[1:]
for p in ports[:2] if ports[2] == '0' else ports:
    with socket.socket() as s:
        try:s.bind(('127.0.0.1',int(p)))
        except OSError:raise SystemExit(f'Fixture port {p} is occupied; leave its owner running and choose another port.')
PY
fixture_log=$(mktemp)
fixture_pid=''
cleanup() {
  if [[ -n "$fixture_pid" ]]; then kill -TERM "$fixture_pid" 2>/dev/null || true; wait "$fixture_pid" 2>/dev/null || true; fi
  rm -f "$fixture_log"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
./scripts/dev.sh >"$fixture_log" 2>&1 & fixture_pid=$!
fixture_ready=false
for attempt in {1..150}; do
  kill -0 "$fixture_pid" 2>/dev/null || { tail -40 "$fixture_log"; exit 1; }
  if curl --max-time 1 -sf "$SHOP_URL/api/ready" >/dev/null; then fixture_ready=true; break; fi
  sleep 1
done
$fixture_ready || { tail -40 "$fixture_log"; echo 'Fixture startup timed out' >&2; exit 1; }
if [[ ${1:-} == --ci || ${1:-} == --acceptance ]]; then
  node apps/store/tests/seo-release.mjs
  (cd apps/store && npm run test:ui)
  node apps/store/tests/accessibility.mjs
fi
node apps/store/tests/mobile-flow.mjs

if [[ ${1:-} == --acceptance ]]; then
  node apps/store/tests/browser-acceptance.mjs
fi
