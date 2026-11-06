---
name: run-local
description: Start the LoverBaazar shop locally, or stop it
---
Needs Docker running. Start in the background: `setsid nohup ./scripts/dev.sh >/tmp/lb-dev.log 2>&1 &`

Wait until `curl -s 127.0.0.1:8787/api/health` prints `ok`. Shop: `:8787`. Admin: `:8787/admin/`.

Stop: `fuser -k 8787/tcp 8080/tcp`. The database stays in the `lbpg` container.
