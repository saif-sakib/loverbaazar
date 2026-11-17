---
name: run-local
description: Start the LoverBaazar shop locally, or stop it
---
Needs Docker running. Start in the background: `setsid nohup ./scripts/dev.sh >/tmp/lb-dev.log 2>&1 &`.

Wait until `curl -sf 127.0.0.1:8787/api/ready` returns readiness JSON. Shop: `:8787`. Admin: `:8787/admin/`.

For destructive/manual test scenarios, use `LB_ISOLATED=1` and the alternate ports documented in `docs/foundation.md`; keep the ordinary `lbpg` business data untouched. The development script rejects occupied ports and cleans up only the API/Worker/container resources it owns. Stop the owning dev shell with Ctrl+C/TERM rather than killing unrelated processes by port. The ordinary database stays in `lbpg`; isolated fixtures are removed on exit.
