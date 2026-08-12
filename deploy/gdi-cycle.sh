#!/usr/bin/env bash
# Wrapper invoked by gdi-ingest.service: ingest → publish → snapshot, in order.
# Publish runs even if ingest fails — it's idempotent and re-renders from
# whatever's in SQLite, useful after a methodology bump or just to refresh
# the timestamp on the published files. Snapshot runs last and reads the DB
# directly (not the published JSON), so it is useful even after a publish miss.
#
# Exit-code policy (systemd reads $? into the unit result):
#   0  everything succeeded
#   1  BOTH ingest AND publish failed — the primary data pipeline is broken
#   3  pipeline OK (publish produced output) but the bot-feed snapshot failed
#
# A snapshot failure gets its OWN distinct code (3, not 1) so it is visible in
# `systemctl status` / journald without being mistaken for a data-pipeline
# failure, and without MASKING an otherwise-successful ingest+publish — those
# record their success independently (ingestion_runs rows + freshly-timestamped
# published JSON), and the watchdog's heartbeat (timer LastTriggerUSec) and
# freshness (ingestion_runs) checks are unaffected by this exit code.

set -uo pipefail

cd "$(dirname "$0")/.."

INGEST_RC=0
node --experimental-strip-types scripts/gdi-ingest.ts || INGEST_RC=$?
if [[ $INGEST_RC -ne 0 ]]; then
    echo "INGEST exited non-zero ($INGEST_RC) — proceeding to publish anyway"
fi

PUBLISH_RC=0
node --experimental-strip-types scripts/gdi-publish.ts || PUBLISH_RC=$?

# Snapshot the DB for the read-only helper bot. Independent of publish; its own
# sanity guards refuse to overwrite the last good snapshot with garbage.
SNAPSHOT_RC=0
node --experimental-strip-types scripts/gdi-snapshot.ts || SNAPSHOT_RC=$?
if [[ $SNAPSHOT_RC -ne 0 ]]; then
    echo "SNAPSHOT exited non-zero ($SNAPSHOT_RC) — ingest/publish results above are unaffected"
fi

if [[ $INGEST_RC -ne 0 && $PUBLISH_RC -ne 0 ]]; then
    exit 1
fi
if [[ $SNAPSHOT_RC -ne 0 ]]; then
    exit 3
fi
exit 0
