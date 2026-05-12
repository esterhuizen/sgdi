# SGDI maintenance notes

Operational quirks, deployment gotchas, and known-but-not-yet-fixed limitations.
This file is the place for context that doesn't fit into code comments or
`CONTRIBUTING.md` (which is policy / methodology). When a future session works
on this codebase, read this first.

## Deployment paths

- **Production releases live at** `/var/lib/sgdi/www/releases/<stamp>-<sha>/`.
  `current` symlink at `/var/www/sgdi/current` points at the active one.
- **systemd service**: `sgdi.service` (port 4400, behind nginx). Runs the
  Next.js standalone server from `/var/www/sgdi/current/.next/standalone/server.js`.
- **Production DB**: `/var/lib/sgdi/gdi.db` (the only DB the production
  ingest writes to — `SGDI_DB_PATH` is set in `gdi-ingest.service`). Don't
  confuse with the smaller stub `/var/lib/sgdi/sgdi.db` (legacy / unused).
- **Published JSON**: `/var/lib/sgdi/published/` (served by nginx at `/gdi/*`).
  `SGDI_PUBLISHED_DIR` env var.
- **Log dir**: `/var/lib/sgdi/logs/runs-YYYY-MM-DD.jsonl` (one file per UTC day).

## Force re-ingest the current epoch

Ingest is idempotent per epoch: it bails on `storage.isEpochAlreadyIngested(epoch)`
if there's a successful row in `ingestion_runs`. To force a re-run of the
current epoch (e.g. after a code change that affects discovery / scoring):

```sh
# 1. Clear the idempotency row(s)
sudo -u definity sqlite3 /var/lib/sgdi/gdi.db \
  "DELETE FROM ingestion_runs WHERE epoch = $EPOCH AND status IN ('success', 'partial')"

# 2. Also wipe per-epoch snapshots + scores if you want a TRULY clean rerun
#    (otherwise stale rows from the previous run are re-published; UPSERT
#    only fixes pools we re-snapshot, not ones the new code excludes).
sudo -u definity sqlite3 /var/lib/sgdi/gdi.db \
  "DELETE FROM pool_scores WHERE epoch = $EPOCH;
   DELETE FROM pool_snapshots WHERE epoch = $EPOCH;"

# 3. Stop the timer (avoid race), fire the service, re-enable timer when done
sudo systemctl stop gdi-ingest.timer
sudo systemctl start gdi-ingest.service       # ~75s with 30 pools
# wait until: systemctl show -p ActiveState --value gdi-ingest.service == "inactive"
sudo systemctl start gdi-ingest.timer
```

The `epochs` table is informational only — deleting from it does NOT bypass
idempotency. The check looks at `ingestion_runs`.

## Pool discovery (gdi-1.1.x)

Pool universe is no longer the static watchlist. Each ingest:

1. Calls `getProgramAccounts` against three SPL-stake-pool family programs:
   `SPoo1Ku8...` (canonical), `SVSPxpvH...` (Sanctum single-validator),
   `SPMBzsVU...` (Sanctum multi).
2. Decodes the StakePool accounts, sorts by `totalLamports`, drops anything
   below `MIN_POOL_TVL_LAMPORTS` (currently **20,000 SOL**, in `gdi-ingest.ts`).
3. Names resolved in order: `pools-watchlist.json` override → Jupiter LST
   tag list (mint lookup) → `null` (frontend shows truncated address).

### Known limitation: SVSP decoder missing

The Sanctum SVSP (`SVSPxpvHdN29nkVg9rPapPNDddN5DipNLRUFhyjFThE`) program
returns StakePool accounts with a **shorter layout** than canonical SPL.
Our `parseStakePoolAccount` reads `total_lamports` at offset 258, which
overshoots the SVSP buffer. As of 2026-05-12, **all ~54 SVSP pools fail to
parse and are excluded** from discovery. This isn't critical (SVSP is mostly
single-validator institutional pools), but if SolanaCompass parity matters,
add an SVSP decoder.

### Known limitation: Jupiter LST tag list misses some legitimate LSTs

The `tag?query=lst` endpoint is curated and lags new launches. As of
2026-05-12, MXSOL, BGSOL, saveSOL, ThetaSOL were all in Jupiter's full token
database but NOT in the LST-tagged list. They were resolved via:

- Jupiter `/v2/search?query=<mint>` — fuller token coverage (any mint that
  Jupiter knows, including `tag: ["unknown"]`)
- Helius DAS `getAsset` — Metaplex metadata for everything else

Quick auto-resolve approach for future work — extend `jupiter.ts`:

```ts
// After fetchLstList:
async function fillMissingNames(mints: string[]): Promise<Map<string, string>>
// 1. /v2/search?query=<mint> for each missing one (single result per call)
// 2. fallback to Helius DAS getAsset if Jupiter has nothing
```

Until that lands, new LSTs need to be hand-added to `config/pools-watchlist.json`.

## Frontend: top-25 cap is client-side

The published `leaderboard-latest.json` contains the FULL set of scored pools
(after the TVL floor). The "show top 25 / show all" toggle is implemented in
`src/components/LeaderboardWithSearch.tsx` — a client component that wraps the
dumb `Leaderboard.tsx` renderer.

Don't try to cap in `gdi-publish.ts`: search needs the full set to filter
across.

## Stale-release cleanup gotcha

`deploy/deploy.sh`'s prune logic at the bottom targets `$APP_ROOT/releases`
where `$APP_ROOT` defaults to `/var/www/sgdi`. But the production releases
actually live at `/var/lib/sgdi/www/releases/`. So **the prune does nothing
in production** and old releases accumulate.

In May 2026 this manifested as 16+ release dirs (~780 MB each) filling the
disk to 96%. Additionally, an earlier deploy.sh run had created hardlink-
based release copies at `/var/www/sgdi/releases/` that shared inodes with
`/var/lib/sgdi/www/releases/` — so deleting one tree dropped inodes from
the other, briefly emptying the active release. The current sgdi service
survived only because it had file handles open from before the delete.

**Fix to do**: either set `APP_ROOT=/var/lib/sgdi/www` in `gdi-ingest.service`
env (which runs deploy.sh), or change deploy.sh's default. **Cleanup
periodically**: keep last 2-3 releases, delete the rest.

## Disk constraints

This VM has 14 GB root disk, regularly at 90%+ usage between definity prod +
staging (~750 MB / release × 3 each) and sgdi releases. Adding a new release
needs ~700 MB free. Clean up before deploying if tight.

## Future improvements (good first issues)

- [ ] **SVSP decoder** in `rpc.ts` — separate decoder for shorter layout,
      add to discovery loop. Adds ~50 single-validator pools to the universe.
- [ ] **Jupiter search + Helius DAS fallback** in `jupiter.ts` — auto-resolve
      names for new LSTs without watchlist editing (see snippet above).
- [ ] **`FORCE_REINGEST_EPOCH` env var** in `gdi-ingest.ts` — bypass the
      idempotency check + auto-wipe per-epoch tables. Replaces the manual
      SQL dance in the "Force re-ingest" section above.
- [ ] **Fix deploy.sh prune path** — see "Stale-release cleanup gotcha".
- [ ] **sgdi-staging environment** — `definity-staging.service` exists as a
      twin of the prod service; the pattern was never duplicated for sgdi.
      Preview workflow is currently "build → swap prod symlink → preview at
      gdindex.app", which only works because we're not yet at scale.
- [ ] **Solanacompass parity audit** — our discovered set may diverge from
      what compass shows (compass might exclude certain programs, apply a
      different TVL floor, or include CBR-style pools we don't decode).
      Worth a one-off comparison once per quarter.
