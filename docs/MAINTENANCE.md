# SGDI maintenance notes

Operational quirks, deployment gotchas, and known-but-not-yet-fixed limitations.
This file is the place for context that doesn't fit into code comments or
`CONTRIBUTING.md` (which is policy / methodology). When a future session works
on this codebase, read this first.

## Deployment paths

### Production (gdindex.app)

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

### Staging (test.gdindex.app)

- **Staging releases at** `/var/www/sgdi-staging/releases/<stamp>-<sha>/`.
  `current` symlink at `/var/www/sgdi-staging/current`.
- **systemd service**: `sgdi-staging.service` (port 4401). Same hardening
  template as prod, runs as `definity` user.
- **Shares with prod**: published JSON (`/var/lib/sgdi/published/`) and DB
  (`/var/lib/sgdi/gdi.db`). One ingest cycle feeds both sites.
- **Cloudflare**: `test.gdindex.app` is **DNS-only** (grey-cloud), not
  proxied — staging traffic hits origin directly. The TLS cert is a
  separate Let's Encrypt cert at `/etc/letsencrypt/live/test.gdindex.app/`.
- **`X-Robots-Tag: noindex, nofollow`** is set on staging responses so
  search engines don't index it.

#### Staging deploy workflow

```sh
# Deploy a specific branch to staging:
sudo -u definity /var/www/sgdi-staging/deploy-staging.sh feature-branch

# Deploy main (default):
sudo -u definity /var/www/sgdi-staging/deploy-staging.sh

# Or run directly from the repo:
sudo -u definity /home/ubuntu/build/sgdi/deploy/deploy-staging.sh <ref>
```

Typical flow: edit → push to branch → deploy-staging.sh → verify on
`https://test.gdindex.app` → merge to main → `deploy.sh` to ship prod.

#### When the shared-data assumption is risky

Staging and prod **share** the published JSON + DB. So most code changes
(UI, layout, copy, components, OG images) are safe — staging changes only
the rendering, both sites read the same data.

⚠️ These categories of changes WILL affect prod data when deployed (even
to staging), because they modify the ingest/publish output that both
sites read:

- `scripts/gdi-ingest.ts` — pool universe / scoring inputs / TVL filter
- `scripts/gdi-publish.ts` — JSON schema / filtering / rank computation
- `src/lib/gdi/scoring.ts` — methodology
- `config/pools-watchlist.json` — display names (resolved server-side)
- Schema migrations to `gdi.db`

For those: dry-run with a fixture JSON, OR deploy to staging+prod
together knowing both sites flip atomically.

#### Merged geo pipeline (single published tree)

The published world is scored from MERGED geo (override > maxmind >
stakewiz) — the same merge as [[the geo data sources section]] documents.
This started life as a parallel "shadow" pipeline (the safe MaxMind
rollout path) and was consolidated into the single canonical pipeline on
**2026-05-30**. History, for anyone archaeologising the code:

- **Rollout** (2026-05-29): a Pass B (`runShadowPass` in
  `scripts/gdi-publish-shadow.ts`) computed merged scores into
  `*_shadow` tables + a parallel `/var/lib/sgdi/published-shadow/` tree,
  while Pass A kept emitting the Stakewiz world to `/var/lib/sgdi/published/`.
  nginx + `sgdi.service` served `published-shadow/` with a fallthrough to
  `published/` for the geo-independent files Pass B doesn't emit.
- **Consolidation** (2026-05-30): Pass B now writes into
  `/var/lib/sgdi/published/` directly (its merged files overwrite Pass A's
  Stakewiz versions in place), driven by the
  `gdi-ingest.service.d/consolidate.conf` drop-in
  (`SGDI_SHADOW_PUBLISHED_DIR=/var/lib/sgdi/published`; template in
  `deploy/`). The `mergedOwnsGeo` gate in `gdi-publish.ts` makes Pass A
  defer the write-once frozen `leaderboard-<epoch>.json` to Pass B.
  nginx + `sgdi.service` serve plain `published/` again — **no fallthrough,
  no `published-shadow/`**.

Current served files in `published/`: geo-dependent ones
(`leaderboard-{epoch,latest}.json`, `network-baseline.json`,
`validator-index.json`, `validators.json`, per-pool `latest.json` +
`history.json` for the ~29 current-epoch-snapshot pools) come from Pass B
(merged); geo-independent ones (`methodology.json`,
`concentration-crosscheck.json`) from Pass A; `pool-fees-*.json` from the
separate pool-fees timer. Pools tracked but without a current-epoch
snapshot (~71) still get Pass-A Stakewiz detail pages — pre-existing,
unchanged by the consolidation.

**Rollback net (kept until ~epoch 987):** the `*_shadow` tables still get
written by Pass B each cycle, the frozen `published-shadow/` tree remains
on disk, and `validator_geo_shadow` (raw maxmind + canonical snapshots)
keeps flowing from ingest. To revert serving to the pre-consolidation
shadow tree: remove `gdi-ingest.service.d/consolidate.conf`, restore the
`sgdi.service` shadow drop-in + the nginx `@gdi_canonical` fallthrough.

**Deferred internal cleanup (separate follow-up, zero UI/data impact):**
Pass A still computes Stakewiz scores (into the canonical `pool_scores` /
`network_baseline` / `network_shares` tables) that are then unread/
overwritten — a few seconds of wasted compute per cycle. Excising it
cleanly means untangling shared state (`clientDistByPool`,
`networkClientDistribution`, `allValidators`) that the surviving Pass A
sections still use; left for a focused PR.

#### Comparing canonical vs shadow

Two read-only CLIs surface the rollout's progress:

- `bin/geo-shadow-report` — input-side agreement: for each active
  validator, did the MaxMind shadow lookup match the canonical Stakewiz
  row? Reads `validator_geo_shadow` rows from `gdi.db`.

- `bin/geo-shadow-diff` — output-side diff: takes the published trees
  and shows the actual scoring impact (network GDI delta, pool rank
  churn, validator rank movers, source-mix by stake share). Reads
  `leaderboard-latest.json` + `validator-index.json` from both dirs.
  Use this to decide when shadow is stable enough to promote.

  ```sh
  bin/geo-shadow-diff.mjs              # human-readable, top 10 movers
  bin/geo-shadow-diff.mjs --top 20
  bin/geo-shadow-diff.mjs --json       # for piping to TG summary
  ```

  Country-name format and AS-prefix differences are surfaced as
  "raw" vs "real (normalised)" counts — a "real" change means MaxMind
  and Stakewiz actually disagreed on the country / city / asn after
  ISO-2-to-name expansion and AS-prefix stripping. Cosmetic-only diffs
  ("Netherlands" vs "NL", "AS24940" vs "24940") still affect bucketing
  and will need a single canonical format at promotion time — that's
  the next PR.

#### Daily TG diff summary

`sgdi-shadow-diff-tg.timer` fires `sgdi-shadow-diff-tg.service` once per
day (default 19:00 UTC ≈ 7 am NZ). The service runs
`scripts/post-shadow-diff-to-tg.ts`, which calls the diff CLI in `--json`
mode, formats a compact ~1 KB message, and posts it to the SGDI ops
chat via `sendSgdiAlert` from `src/lib/gdi/telegram.ts`.

Enable:
```sh
sudo cp deploy/sgdi-shadow-diff-tg.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sgdi-shadow-diff-tg.timer
```

Force a run (sends to TG immediately):
```sh
sudo systemctl start sgdi-shadow-diff-tg.service
journalctl -u sgdi-shadow-diff-tg.service -n 50 --no-pager
```

Preview the message without sending (no TG creds in env):
```sh
cd /var/www/sgdi/current
env -u TELEGRAM_BOT_TOKEN -u TELEGRAM_CHAT_ID \
  node --experimental-strip-types scripts/post-shadow-diff-to-tg.ts
```

Disable for the cutover (when shadow becomes canonical and the diff
goes to zero): `sudo systemctl disable --now sgdi-shadow-diff-tg.timer`.

Note: the prod `gdi-ingest.service` runs from
`/var/www/sgdi/current/scripts/gdi-ingest.ts` — staging deploys do
NOT change which ingest code runs. To test ingest changes, the prod
release must be updated (which means: merge to main, deploy prod).

## Geo data sources + merge logic

How `country` / `city` / `asn` / `asn_name` get resolved for every active
validator. Lives in `src/lib/gdi/data-sources/merge-geo.ts`; covered by
15 unit tests in `tests/merge-geo.test.ts`.

### Priority chain (per-dimension, first non-null wins)

| Priority | Source | What it is | Notes |
|---|---|---|---|
| 1 | **override** | Operator-confirmed value in `validator_geo_overrides` table | Highest trust — manually verified. CRUD via `bin/geo-override.mjs`. |
| 2 | **maxmind** | Locally-hosted GeoLite2-City + GeoLite2-ASN lookup against the validator's gossip IP | Refreshed weekly by `sgdi-geoip-refresh.timer` (Wed 03:00 UTC). Returns ISO-2 country, bare ASN. |
| 3 | **stakewiz** | The pre-cutover canonical row (which itself merged Stakewiz primary + Validators.app secondary at ingest time) | Returns display-name country, AS-prefixed ASN. |
| 4 | *validators-app* | Pre-merged into the canonical stakewiz row at ingest — never reached as a separate fall-through in current code. Kept in the API for completeness. | — |

**Per-dimension independence:** each of `country`, `city`, `asn`,
`asn_name` picks its winner independently. A partial override that only
sets `country` still lets MaxMind answer for `city`; a MaxMind result
that has `country` but missing `city` still lets Stakewiz answer for
`city`. The four fields on one validator can come from up to four
different sources, and that's intentional.

### Output normalization

Applied after picking the winner. The reason this happens **at merge
time** rather than at display time: the bucket keys for network-share
calculations use these strings directly. Without normalization,
validators whose country came from MaxMind (`"NL"`) would land in a
different bucket from ones from Stakewiz (`"Netherlands"`), splitting
the share and inflating GDI. Normalization fixes the math, not just
the UI.

| Field | Normalization | Examples |
|---|---|---|
| country | ISO-2 → English display name via `Intl.DisplayNames`. Plus two manual overrides for SAR codes where Intl's UN-formal name is worse UX | `"NL"` → `"Netherlands"`, `"HK"` → `"Hong Kong"` (not `"Hong Kong SAR China"`), `"MO"` → `"Macao"` |
| asn | Strip any `AS` prefix (case-insensitive), then prepend `AS` | `"24940"` → `"AS24940"`, `"as0"` → `"AS0"` |
| city | Trimmed, otherwise unchanged | `"  Amsterdam  "` → `"Amsterdam"` |
| asn_name | Trimmed, otherwise unchanged | Org names like `"Hetzner Online GmbH"` |

If you want to add another SAR / disputed-region override, edit
`COUNTRY_NAME_OVERRIDES` in `merge-geo.ts` — keep that list small,
it's an exception list, not a translation table.

### Provenance tracking

Every published validator row carries a `geo_sources` object recording
which source won each dimension. Surfaces in
`pools/<addr>/latest.json` (under `validators[].geo_sources`) and in
`validator-index.json` (under `validators[].geo_sources`). Useful for
drilling into "why did pool X's GDI change?" — the answer is usually
"validator Y's `country` source flipped from stakewiz to maxmind
because the IP changed".

### Disagreement logging

`mergeGeo()` accepts an optional `logger` argument. When passed, it
emits a `geo.merge.disagreement` WARN log line for any dimension where
two or more sources had non-null values that disagreed under the
field-aware normalisation. The publish pipeline intentionally omits
the logger to avoid drowning the journal in ~hundreds of warns per
ingest cycle; for ad-hoc investigation, run `bin/geo-shadow-report.mjs`
which surfaces aggregates instead.

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
