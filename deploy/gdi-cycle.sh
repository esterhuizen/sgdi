#!/usr/bin/env bash
# Wrapper invoked by gdi-ingest.service: ingest → publish, in that order.
# Publish runs even if ingest fails — it's idempotent and re-renders from
# whatever's in SQLite, useful after a methodology bump or just to refresh
# the timestamp on the published files.

set -uo pipefail

cd "$(dirname "$0")/.."

INGEST_RC=0
node --experimental-strip-types scripts/gdi-ingest.ts || INGEST_RC=$?
if [[ $INGEST_RC -ne 0 ]]; then
    echo "INGEST exited non-zero ($INGEST_RC) — proceeding to publish anyway"
fi

PUBLISH_RC=0
node --experimental-strip-types scripts/gdi-publish.ts || PUBLISH_RC=$?

if [[ $INGEST_RC -ne 0 && $PUBLISH_RC -ne 0 ]]; then
    exit 1
fi
exit 0
