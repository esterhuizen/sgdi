#!/usr/bin/env bash
# Atomic deploy script for SGDI.
#
# Usage:
#   sudo -u definity /var/www/sgdi/deploy.sh                 # builds origin/main, restarts service
#   sudo -u definity /var/www/sgdi/deploy.sh some-branch     # builds that ref
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

# Atomic symlink swap
ln -sfn "$RELEASE" "$APP_ROOT/current.new"
mv -Tf "$APP_ROOT/current.new" "$APP_ROOT/current"

echo "==> Reloading service: $SERVICE"
sudo systemctl restart "$SERVICE"

# Purge Cloudflare cache so users see the new build immediately rather
# than waiting up to 4h for the max-age TTL to expire. Sources the env
# file via sudo cat (definity has read access via group). Failure is
# logged but doesn't fail the deploy — the worst case is users see
# stale content for a few minutes, which is fine.
if [[ -r "$RELEASE/scripts/purge-cloudflare.mjs" ]]; then
    echo "==> Purging Cloudflare cache"
    if sudo bash -c "set -a; source /etc/default/sgdi.env; set +a; node $RELEASE/scripts/purge-cloudflare.mjs"; then
        :
    else
        echo "    (purge failed — cache will expire naturally within max-age)"
    fi
fi

# Prune old releases
cd "$APP_ROOT/releases"
ls -1tr | head -n -"$KEEP_RELEASES" | xargs -r rm -rf

echo "==> Deployed $RELEASE"
