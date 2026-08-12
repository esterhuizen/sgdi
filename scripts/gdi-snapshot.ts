// gdi-snapshot.ts — Publish a read-only, self-contained SQLite snapshot of the
// production GDI database, with a small semantic view layer on top, for a
// downstream read-only Telegram helper bot to query.
//
// WHY THIS EXISTS
// ---------------
// The live gdi.db is written by the ingest pipeline every 15 min (WAL mode,
// concurrent writers). A helper bot must never open that file — a bug or a
// long-running query could contend with ingest, and the bot has no business
// with write access to production data. Instead we hand it a frozen, compact,
// single-file copy with convenience views baked in, refreshed once per cycle.
//
// HOW
// ---
//   1. Open the source DB READ-ONLY and `VACUUM INTO` a fresh <dir>/…​.db.tmp.
//      VACUUM INTO reads the source and writes a brand-new, defragmented single
//      file; it never touches the source (verified: a read-only connection can
//      run it and the source checksum is unchanged afterwards). No WAL sidecars.
//   2. Create the view layer inside the .tmp copy (the source is read-only and
//      must stay pristine — the views only ever live in the snapshot).
//   3. Run sanity guards against the .tmp copy. On any failure we ABORT: the
//      .tmp is removed and the previous good snapshot is left in place.
//   4. Atomically rename .tmp → gdi-snapshot.db (same directory, same fs) and
//      chmod 0644 so the bot's (unprivileged) user can read it.
//
// Only the current snapshot is kept — the rename overwrites the previous file
// and there is never more than one .db (+ a transient .tmp).
//
// USAGE
//   node --experimental-strip-types scripts/gdi-snapshot.ts
//   SGDI_DB_PATH=/path/to/gdi.db SGDI_PUBLISHED_DIR=/tmp/out \
//     node --experimental-strip-types scripts/gdi-snapshot.ts
//   node --experimental-strip-types scripts/gdi-snapshot.ts --published-dir /tmp/out
//
// Exits 0 on a published snapshot, non-zero (with the previous snapshot intact)
// on any sanity failure or error.

import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const SNAPSHOT_BASENAME = 'gdi-snapshot.db';

// Sanity guard: refuse to publish if the active-validator count has collapsed
// vs the previous snapshot by more than this fraction. A snapshot is a coarse
// convenience artifact, not the scored leaderboard (the watchdog guards that
// with a tight 2% stake bound). Here we only need to catch GROSS corruption —
// half the network vanishing — before it reaches the bot; normal epoch churn
// moves the active count by a handful out of ~700 (well under 1%), and a loose
// bound also avoids false-positives when the timer legitimately skips cycles
// and the previous snapshot is several epochs old. Overridable for tuning.
const MAX_ACTIVE_DROP_PCT = Number(process.env.SGDI_SNAPSHOT_MAX_ACTIVE_DROP_PCT ?? 50);

// ───────────────────────────────────────────────────────────────────────────
// View layer — the single source of truth for the snapshot's semantics.
// Exported so tests assert against the exact SQL the pipeline ships.
//
// "Currently running" is defined EXACTLY as the live scoring pipeline defines
// its active-voting set (src/lib/gdi/scoring.ts, scripts/gdi-publish.ts):
//     activated_stake_lamports > 0  AND  delinquent IS NOT 1
// The stored `delinquent` column is already the DEBOUNCED effective flag (the
// hysteresis in storage.ts upsert only flips it to 1 after 4 consecutive raw=1
// samples), so the view needs no streak arithmetic — it reads the same column
// scoring reads. `delinquent IS NOT 1` (not `= 0`) matches the pipeline's
// `v.delinquent !== 1`, treating an unknown (NULL) flag as active; and
// `> 0` on a NULL stake is NULL⇒excluded, matching `(stake ?? 0) > 0`.
// ───────────────────────────────────────────────────────────────────────────
export const SNAPSHOT_VIEWS_SQL = `
-- v_validators_active: the single definition of "currently running" — the
-- active-voting set the GDI scores against. One row per live validator.
CREATE VIEW v_validators_active AS
SELECT
  validator_pubkey,
  identity_pubkey,
  identity_name,
  country,
  city,
  asn,
  asn_name,
  datacenter,
  activated_stake_lamports,
  activated_stake_lamports / 1000000000.0 AS activated_stake_sol,
  stakewiz_wiz_score,
  client_name,
  client_version,
  is_jito,
  is_dz,
  is_bam,
  ibrl_score,
  image_url
FROM validators
WHERE activated_stake_lamports > 0
  AND delinquent IS NOT 1;

-- v_validators_geo: every validator with a geo-coverage indicator. has_full_geo
-- = all three location dimensions (country/city/asn) are populated; the
-- per-dimension flags and is_active let a caller answer "how many active
-- validators in country X do we have full geo for?" without any joins.
CREATE VIEW v_validators_geo AS
SELECT
  validator_pubkey,
  identity_name,
  country,
  city,
  asn,
  asn_name,
  country_source,
  city_source,
  asn_source,
  activated_stake_lamports,
  delinquent,
  CASE WHEN activated_stake_lamports > 0 AND delinquent IS NOT 1
       THEN 1 ELSE 0 END AS is_active,
  CASE WHEN country IS NOT NULL AND country <> '' THEN 1 ELSE 0 END AS has_country,
  CASE WHEN city    IS NOT NULL AND city    <> '' THEN 1 ELSE 0 END AS has_city,
  CASE WHEN asn     IS NOT NULL AND asn     <> '' THEN 1 ELSE 0 END AS has_asn,
  CASE WHEN country IS NOT NULL AND country <> ''
        AND city    IS NOT NULL AND city    <> ''
        AND asn     IS NOT NULL AND asn     <> ''
       THEN 1 ELSE 0 END AS has_full_geo
FROM validators;

-- v_pools_current: the latest scored epoch's pool rows, joined to pool
-- metadata, so a caller never does epoch arithmetic. "Latest" = the global
-- MAX(epoch) in pool_scores, matching how gdi-publish picks the leaderboard
-- epoch. Ordered best-GDI-first.
CREATE VIEW v_pools_current AS
SELECT
  ps.epoch,
  ps.pool_address,
  p.pool_name,
  p.pool_token_mint,
  ps.gdi_composite,
  ps.dc_country,
  ps.dc_city,
  ps.dc_asn,
  ps.network_impact_score,
  ps.placement_coverage,
  ps.validator_count,
  ps.total_stake_lamports,
  ps.total_stake_lamports / 1000000000.0 AS total_stake_sol,
  ps.methodology_version,
  ps.computed_at
FROM pool_scores ps
LEFT JOIN pools p ON p.pool_address = ps.pool_address
WHERE ps.epoch = (SELECT MAX(epoch) FROM pool_scores)
ORDER BY ps.gdi_composite DESC;
`;

/** SQLite string literal — single-quote and double any embedded quote. */
function sqlLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export type SnapshotResult = {
  path: string;
  activeValidators: number;
  totalValidators: number;
  currentPools: number;
  latestEpoch: number | null;
};

export type SnapshotOptions = {
  /** Source production DB — opened strictly read-only. */
  sourceDbPath: string;
  /** Directory the snapshot (and its transient .tmp) is written to. */
  publishedDir: string;
  /** Max tolerated drop in active count vs the previous snapshot, in percent. */
  maxActiveDropPct?: number;
};

/**
 * Build and publish the snapshot. Throws (leaving any previous snapshot intact
 * and removing the .tmp) if a sanity guard trips or anything fails.
 */
export function runSnapshot(opts: SnapshotOptions): SnapshotResult {
  const maxDropPct = opts.maxActiveDropPct ?? MAX_ACTIVE_DROP_PCT;
  mkdirSync(opts.publishedDir, { recursive: true });

  const finalPath = join(opts.publishedDir, SNAPSHOT_BASENAME);
  const tmpPath = `${finalPath}.tmp`;

  // A stale .tmp from a previously-crashed run would break VACUUM INTO (it
  // refuses to overwrite an existing file), so clear it first.
  rmSync(tmpPath, { force: true });

  try {
    // 1. Read-only VACUUM INTO — never mutates the source.
    const src = new Database(opts.sourceDbPath, { readonly: true });
    try {
      src.exec(`VACUUM INTO ${sqlLiteral(tmpPath)}`);
    } finally {
      src.close();
    }

    // 2 + 3. Create views and sanity-check, in the .tmp copy.
    const snap = new Database(tmpPath);
    let result: SnapshotResult;
    try {
      snap.exec(SNAPSHOT_VIEWS_SQL);

      const totalValidators = (snap.prepare('SELECT COUNT(*) AS n FROM validators').get() as { n: number }).n;
      const activeValidators = (snap.prepare('SELECT COUNT(*) AS n FROM v_validators_active').get() as { n: number }).n;
      const currentPools = (snap.prepare('SELECT COUNT(*) AS n FROM v_pools_current').get() as { n: number }).n;
      const latestEpoch = (snap.prepare('SELECT MAX(epoch) AS e FROM pool_scores').get() as { e: number | null }).e;

      // Guard 1 — an empty active set means the DB is empty/corrupt or the
      // active predicate broke. Never publish that to the bot.
      if (activeValidators === 0) {
        throw new Error('sanity: active-validator count is 0 — refusing to publish');
      }
      // Guard 2 — active can never exceed the total row count; if it does the
      // view logic is inverted or the DB is corrupt.
      if (activeValidators > totalValidators) {
        throw new Error(
          `sanity: active count ${activeValidators} exceeds total rows ${totalValidators} — refusing to publish`,
        );
      }
      // Guard 3 — a >maxDropPct collapse vs the previous snapshot is the
      // 2026-06-10 class of event (a large chunk of the active set vanishing).
      // Compared read-only against the previous snapshot; skipped on the first
      // ever run (no baseline).
      if (existsSync(finalPath)) {
        const prev = new Database(finalPath, { readonly: true });
        try {
          const prevActive = (prev.prepare('SELECT COUNT(*) AS n FROM v_validators_active').get() as { n: number }).n;
          if (prevActive > 0) {
            const dropPct = ((prevActive - activeValidators) / prevActive) * 100;
            if (dropPct > maxDropPct) {
              throw new Error(
                `sanity: active count dropped ${dropPct.toFixed(1)}% ` +
                  `(${prevActive} → ${activeValidators}, threshold ${maxDropPct}%) — refusing to publish`,
              );
            }
          }
        } finally {
          prev.close();
        }
      }

      result = { path: finalPath, activeValidators, totalValidators, currentPools, latestEpoch };
    } finally {
      snap.close();
    }

    // 4. Publish: world-readable, then atomic rename onto the live path.
    chmodSync(tmpPath, 0o644);
    renameSync(tmpPath, finalPath);
    return result;
  } catch (err) {
    // Leave no partial state — the previous good snapshot (if any) is untouched.
    rmSync(tmpPath, { force: true });
    throw err;
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const dirFlag = args.indexOf('--published-dir');
  const publishedDir =
    (dirFlag !== -1 ? args[dirFlag + 1] : undefined) ??
    process.env.SGDI_PUBLISHED_DIR ??
    '/var/lib/sgdi/published';
  const sourceDbPath = process.env.SGDI_DB_PATH ?? '/var/lib/sgdi/gdi.db';

  const r = runSnapshot({ sourceDbPath, publishedDir });
  console.log(
    `snapshot OK: ${r.activeValidators} active / ${r.totalValidators} total validators, ` +
      `${r.currentPools} pools (epoch ${r.latestEpoch ?? 'n/a'}) → ${r.path}`,
  );
}

// Run only when invoked directly, not when imported by tests.
if (process.argv[1] && process.argv[1].endsWith('gdi-snapshot.ts')) {
  try {
    main();
  } catch (err) {
    console.error('snapshot FAILED:', (err as Error).message);
    process.exit(1);
  }
}
