#!/usr/bin/env bash
# promote.sh — the sanctioned way to put new code into production for this repo.
# Cycle: implement → test locally → commit → push → ./deploy/promote.sh
# Guard: refuses a promote on a dirty tracked tree or if HEAD != origin/main —
# GitHub drives production; nothing unpushed ever runs in prod.
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "PROMOTE GUARD: uncommitted tracked changes in $REPO_DIR — commit first." >&2
  exit 1
fi
BRANCH="$(git branch --show-current)"
git fetch -q origin "$BRANCH"
if [ "$(git rev-parse HEAD)" != "$(git rev-parse "origin/$BRANCH")" ]; then
  echo "PROMOTE GUARD: HEAD != origin/$BRANCH — push (or pull) first." >&2
  exit 1
fi
echo "No long-running services here — timer-driven units pick up this sha on their next tick."
echo "PROMOTED $(git rev-parse --short HEAD) (clean, pushed)"
