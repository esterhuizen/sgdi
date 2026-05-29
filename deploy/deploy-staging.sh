#!/usr/bin/env bash
# Atomic deploy to the SGDI STAGING tree (test.gdindex.app).
#
# Mirrors deploy.sh's discipline (git archive → npm ci → build → atomic
# symlink swap → service restart) but writes to /var/www/sgdi-staging/
# and restarts sgdi-staging.service instead of touching prod.
#
# Reuses prod's bare repo cache at /var/www/sgdi/repo.git to avoid
# duplicating ~50MB of git history on disk.
#
# Usage:
#   sudo -u definity /var/www/sgdi-staging/deploy-staging.sh           # builds origin/main
#   sudo -u definity /var/www/sgdi-staging/deploy-staging.sh my-branch # builds that ref
#
# After deploy: visit https://test.gdindex.app — same content as prod
# would show for that ref, sharing the same /var/lib/sgdi/published/
# JSON data feed.

set -euo pipefail

APP_ROOT="${APP_ROOT:-/var/www/sgdi-staging}"
PROD_REPO_GIT="${PROD_REPO_GIT:-/var/www/sgdi/repo.git}"
REPO_URL="${REPO_URL:-https://github.com/esterhuizen/sgdi.git}"
SERVICE="${SERVICE:-sgdi-staging}"
KEEP_RELEASES="${KEEP_RELEASES:-3}"
[[ "$KEEP_RELEASES" -lt 2 ]] && KEEP_RELEASES=2
REF="${1:-main}"

mkdir -p "$APP_ROOT/releases"

# Reuse prod's bare repo cache. If it doesn't exist (e.g. fresh host),
# bootstrap our own. Both prod's deploy.sh and this one keep it in sync.
if [[ ! -d "$PROD_REPO_GIT" ]]; then
    echo "==> Bootstrapping bare repo at $PROD_REPO_GIT"
    git clone --bare "$REPO_URL" "$PROD_REPO_GIT"
fi
git --git-dir="$PROD_REPO_GIT" fetch --prune origin '+refs/heads/*:refs/heads/*'

SHA="$(git --git-dir="$PROD_REPO_GIT" rev-parse "$REF" | cut -c1-7)"
STAMP="$(date -u +%Y-%m-%d-%H%M%S)"
RELEASE="$APP_ROOT/releases/$STAMP-$SHA"

echo "==> Building staging release $STAMP-$SHA from ref $REF"
mkdir -p "$RELEASE"
git --git-dir="$PROD_REPO_GIT" archive "$REF" | tar -x -C "$RELEASE"

cd "$RELEASE"
npm ci
npm run build

# Same Next standalone symlink dance as deploy.sh
rm -rf ".next/standalone/public" ".next/standalone/.next/static"
ln -s ../../public ".next/standalone/public"
ln -s ../../static ".next/standalone/.next/static"

# Drop build-time prerendered HTMLs — same reason as deploy.sh: the build
# can't see /var/lib/sgdi/published/, so the baked ISR pages are all the
# "Awaiting first ingest" empty state. Delete them so first request
# re-SSRs with live data.
find ".next/standalone/.next/server/app" -maxdepth 3 -name "*.html" -delete

# Atomic symlink swap
ln -sfn "$RELEASE" "$APP_ROOT/current.new"
mv -Tf "$APP_ROOT/current.new" "$APP_ROOT/current"

echo "==> Reloading service: $SERVICE"
sudo systemctl restart "$SERVICE"

# Prune older releases (keep last $KEEP_RELEASES)
cd "$APP_ROOT/releases"
ls -1tr | head -n -"$KEEP_RELEASES" | xargs -r rm -rf

echo "==> Deployed $RELEASE → https://test.gdindex.app"
