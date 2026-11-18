#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
for tool in docker go node npm curl python3; do command -v "$tool" >/dev/null || { echo "Install $tool first" >&2; exit 1; }; done
docker info >/dev/null
node -e '
const encode = value => value.trim().split(".").reduce((n, part) => n * 1000 + Number(part), 0);
const minimum = require("node:fs").readFileSync(".nvmrc", "utf8");
if (encode(process.versions.node) < encode(minimum)) {
  console.error("Install Node " + minimum.trim() + " or newer.");
  process.exit(1);
}'
(cd apps/store && npm ci --no-audit --no-fund)
if [[ ${1:-} == --browsers ]]; then (cd apps/store && npx playwright install chromium); fi
(cd apps/api && test -z "$(gofmt -l .)" && go vet .)
for file in apps/store/public/*.js edge/*.js scripts/*.mjs; do node --check "$file"; done
node --test edge/worker.test.mjs scripts/release*.test.mjs
python3 -m unittest discover -s scripts -p 'test_maintenance.py'
./scripts/test-api.sh
