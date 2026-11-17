#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
for tool in docker go node npm curl python3; do command -v "$tool" >/dev/null || { echo "Install $tool first" >&2; exit 1; }; done
docker info >/dev/null
node -e 'if (+process.versions.node.split(".")[0]<22) process.exit(1)'
(cd apps/store && npm ci --no-audit --no-fund)
if [[ ${1:-} == --browsers ]]; then (cd apps/store && npx playwright install chromium); fi
(cd apps/api && test -z "$(gofmt -l .)" && go vet .)
node --test edge/worker.test.mjs
./scripts/test-api.sh
