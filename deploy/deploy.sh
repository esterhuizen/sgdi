#!/usr/bin/env bash
# Atomic deploy script for SGDI.
#
# Usage:
#   sudo -u definity bash deploy/deploy.sh                   # builds origin/main, restarts service
#   sudo -u definity bash deploy/deploy.sh some-branch       # builds that ref
#
# Run it from a checkout of this repo. There is no copy at /var/www/sgdi/ —
# the path this header used to give returns "command not found", which is a
# poor thing to discover during an incident.
#
# Layout produced:
#   /var/www/sgdi/
#   ├── current -> releases/<stamp>-<sha>     # symlink to active build
#   ├── releases/                              # last 3 builds (rollback target)
#   ├── repo.git/                              # bare clone for fast deploys
#   └── deploy.sh
#
# Published JSON lives OUTSIDE the release tree at /var/lib/sgdi/published/
# so it survives deploys (nginx serves /gdi/* directly from there).

set -euo pipefail

APP_ROOT="${APP_ROOT:-/var/www/sgdi}"
REPO_URL="${REPO_URL:-https://github.com/esterhuizen/sgdi.git}"
SERVICE="${SERVICE:-sgdi}"
KEEP_RELEASES="${KEEP_RELEASES:-3}"
[[ "$KEEP_RELEASES" -lt 2 ]] && KEEP_RELEASES=2
REF="${1:-main}"

mkdir -p "$APP_ROOT/releases"

# Bare repo cache (faster than full clone every deploy).
if [[ ! -d "$APP_ROOT/repo.git" ]]; then
    git clone --bare "$REPO_URL" "$APP_ROOT/repo.git"
fi
git --git-dir="$APP_ROOT/repo.git" fetch --prune origin '+refs/heads/*:refs/heads/*'

SHA="$(git --git-dir="$APP_ROOT/repo.git" rev-parse "$REF" | cut -c1-7)"
STAMP="$(date -u +%Y-%m-%d-%H%M%S)"
RELEASE="$APP_ROOT/releases/$STAMP-$SHA"

echo "==> Building release $STAMP-$SHA from ref $REF"
mkdir -p "$RELEASE"
git --git-dir="$APP_ROOT/repo.git" archive "$REF" | tar -x -C "$RELEASE"

cd "$RELEASE"
npm ci
npm run build

# Next standalone needs ./public and ./.next/static colocated next to server.js.
# Symlink (not copy) so any later changes propagate.
rm -rf ".next/standalone/public" ".next/standalone/.next/static"
ln -s ../../public ".next/standalone/public"
ln -s ../../static ".next/standalone/.next/static"

# Drop build-time prerendered HTMLs. The build runs without access to
# /var/lib/sgdi/published/, so loadJson returns null and Next bakes the
# "Awaiting first ingest" empty state into every ISR page. Deleting
# them forces fresh SSR on first request, which then writes a real one
# back into the cache.
find ".next/standalone/.next/server/app" -maxdepth 3 -name "*.html" -delete

# Atomic symlink swap. Remember what we are replacing so the smoke test below
# has somewhere to roll back to.
if [[ -L "$APP_ROOT/current" ]]; then
    ln -sfn "$(readlink -f "$APP_ROOT/current")" "$APP_ROOT/current.prev"
fi
ln -sfn "$RELEASE" "$APP_ROOT/current.new"
mv -Tf "$APP_ROOT/current.new" "$APP_ROOT/current"

echo "==> Reloading service: $SERVICE"
PREVIOUS_RELEASE="$(readlink -f "$APP_ROOT/current.prev" 2>/dev/null || true)"
sudo systemctl restart "$SERVICE"

# ── Smoke test, and the reason it exists ────────────────────────────────────
# The build has no access to /var/lib/sgdi/published/, so every ISR page is
# baked empty and deleted above. That makes the FIRST REQUEST after restart the
# one that renders for real and writes the ISR cache — and whatever it produces
# sticks, because a cached not-found is terminal: `revalidate = 60` never
# replaces it.
#
# On 2026-08-31 that first request produced Next's 404 page. gdindex.app served
# "404: This page could not be found." under an HTTP 200 for five weeks, through
# every X post that cited it as the source, and nothing noticed — a status-code
# health check would have called it healthy the whole time.
#
# So the deploy now makes that first request itself, checks what came back, and
# refuses to leave a broken build live. Warming the cache deliberately is also
# strictly better than letting a random visitor do it.
PORT="$(systemctl show "$SERVICE" -p Environment --value | tr ' ' '\n' | sed -n 's/^PORT=//p')"
PORT="${PORT:-4400}"
SMOKE_URL="http://127.0.0.1:${PORT}/"
echo "==> Smoke test: $SMOKE_URL"
SMOKE_OK=0
for attempt in 1 2 3 4 5 6 7 8 9 10; do
    sleep 2
    BODY="$(curl -fsS --max-time 20 "$SMOKE_URL" 2>/dev/null || true)"
    [[ -z "$BODY" ]] && continue
    # Match the <title>, not the body: every healthy Next page embeds the
    # not-found component in its RSC payload, so "could not be found" appears
    # in good HTML too. Only the rendered title distinguishes them.
    TITLE="$(grep -o '"'"'<title[^>]*>[^<]*'"'"' <<<"$BODY" | head -1 | sed 's/.*>//')"
    if grep -qiE '"'"'^404|could not be found'"'"' <<<"$TITLE"; then
        echo "    attempt $attempt: served a 404 page (title: $TITLE)"
        break   # deterministic, not a warm-up race — fail fast
    fi
    if grep -qi "Decentralisation Index" <<<"$TITLE"; then
        echo "    attempt $attempt: OK ($(wc -c <<<"$BODY") bytes)"
        SMOKE_OK=1
        break
    fi
    echo "    attempt $attempt: unexpected body, retrying"
done

if [[ "$SMOKE_OK" -ne 1 ]]; then
    echo "!!! Smoke test FAILED — the homepage does not render."
    if [[ -n "$PREVIOUS_RELEASE" && -d "$PREVIOUS_RELEASE" ]]; then
        echo "!!! Rolling back to $PREVIOUS_RELEASE"
        ln -sfn "$PREVIOUS_RELEASE" "$APP_ROOT/current.new"
        mv -Tf "$APP_ROOT/current.new" "$APP_ROOT/current"
        sudo systemctl restart "$SERVICE"
        echo "!!! Rolled back. The bad build is at $RELEASE for inspection."
    else
        echo "!!! No previous release recorded — $SERVICE is live and BROKEN. Fix forward."
    fi
    exit 1
fi

# Purge Cloudflare cache so users see the new build immediately rather
# than waiting up to 4h for the max-age TTL to expire. /etc/default/sgdi.env
# is mode 640 root:definity, so definity can read it directly — no sudo
# needed here. Failure is logged but doesn't fail the deploy: worst case
# is users see stale content for a few minutes, which is acceptable.
if [[ -r "$RELEASE/scripts/purge-cloudflare.mjs" && -r /etc/default/sgdi.env ]]; then
    echo "==> Purging Cloudflare cache"
    if ( set -a; source /etc/default/sgdi.env; set +a; node "$RELEASE/scripts/purge-cloudflare.mjs" ); then
        :
    else
        echo "    (purge failed — cache will expire naturally within max-age)"
    fi
fi

# Prune old releases
cd "$APP_ROOT/releases"
KEEP_NAME="$(basename "$(readlink -f "$APP_ROOT/current.prev" 2>/dev/null || echo __none__)")"
ls -1tr | head -n -"$KEEP_RELEASES" | grep -vx "$KEEP_NAME" | xargs -r rm -rf

echo "==> Deployed $RELEASE"
