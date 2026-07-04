# CLAUDE.md — sgdi

SGDI ingest/publish pipeline (leaderboard at /var/lib/sgdi/published/, GDI site data). All units are timer-driven oneshots (gdi-ingest, gdi-watchdog, sgdi-geoip-refresh, sgdi-pool-fees-refresh) — they run whatever code is on disk at tick time.

**Release cycle (same as every repo on this box):** implement → test → commit → push → `./deploy/promote.sh`. The promote guard refuses a dirty tracked tree or unpushed HEAD — GitHub drives production. Never leave this checkout dirty between sessions: the next timer tick would run your half-finished change against production data.

Secrets: HELIUS creds come from /etc/default/sgdi.env (also carries TG bot creds used by several services) — never print values.
