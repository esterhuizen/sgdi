// Helpers for the per-epoch leaderboard archives in a published directory.
//
// `leaderboard-<epoch>.json` tracks the live epoch and freezes once the epoch
// rolls over (see the writers in gdi-publish / gdi-publish-shadow). That is
// only safe while the epoch we publish keeps moving forward. It can go
// backwards: the force-re-ingest recipe in docs/MAINTENANCE.md deletes the
// current epoch's rows, and a DB restore rolls the whole table back — in both
// cases latestScoredEpoch() briefly reports an OLDER epoch, and a naive
// rewrite would overwrite a finished archive with a partial one.

import { readdirSync } from 'node:fs';

const ARCHIVE_RE = /^leaderboard-(\d+)\.json$/;

/**
 * Highest epoch among the `leaderboard-<epoch>.json` files already in `dir`,
 * or null when there are none (or the directory can't be read — first publish
 * into a fresh output dir). `leaderboard-latest.json` never matches.
 */
export function maxArchivedLeaderboardEpoch(dir: string): number | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  let max: number | null = null;
  for (const name of names) {
    const m = ARCHIVE_RE.exec(name);
    if (!m) continue;
    const epoch = Number(m[1]);
    if (Number.isFinite(epoch) && (max == null || epoch > max)) max = epoch;
  }
  return max;
}
