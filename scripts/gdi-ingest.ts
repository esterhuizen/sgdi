// scripts/gdi-ingest.ts
//
// Entry point fired by gdi-ingest.timer (every 30 min by default). Detects
// new epoch via RPC; if found, runs full pipeline:
//
//   1. detect epoch (bail if already ingested)
//   2. start ingestion_runs row
//   3. for each tracked pool: capture per-validator delegation snapshot
//   4. fetch Stakewiz + Validators.app validator metadata
//   5. enrich + upsert validators (logs every source disagreement)
//   6. compute pool scores (pure function from scoring.ts)
//   7. compute network baseline GDI
//   8. mark run success/partial/failed
//
// Idempotent: re-running for a given epoch is a no-op (step 1 bails).
//
// Run directly:    node --experimental-strip-types scripts/gdi-ingest.ts
// Run via npm:     npm run ingest
//
// Env required:
//   HELIUS_RPC_URL
//   VALIDATORS_APP_TOKEN  (optional — if absent, enrichment uses Stakewiz only)
//   SGDI_DB_PATH          (default: ./var/sgdi.db)
//   SGDI_LOG_DIR          (default: ./var/logs)

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLogger } from '../src/lib/gdi/logger.ts';
import { openStorage } from '../src/lib/gdi/storage.ts';
import { createRpc, fetchPoolDelegations } from '../src/lib/gdi/data-sources/rpc.ts';
import { createStakewiz } from '../src/lib/gdi/data-sources/stakewiz.ts';
import { createValidatorsApp } from '../src/lib/gdi/data-sources/validators-app.ts';
import { enrichValidators } from '../src/lib/gdi/enrichment.ts';
import {
  computePoolScores,
  computeNetworkBaseline,
  computeNetworkShares,
  METHODOLOGY_VERSION,
  type ValidatorMetadata,
  type PoolStakeRow,
} from '../src/lib/gdi/scoring.ts';

const WATCHLIST_PATH = resolve('./config/pools-watchlist.json');

type WatchlistEntry = {
  pool_address: string;
  name?: string;
  note?: string;
};

type Watchlist = {
  additions?: WatchlistEntry[];
};

function readWatchlist(): WatchlistEntry[] {
  let parsed: Watchlist;
  try {
    parsed = JSON.parse(readFileSync(WATCHLIST_PATH, 'utf8')) as Watchlist;
  } catch {
    return [];
  }
  return (parsed.additions || []).filter((a) => a && a.pool_address);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function main() {
  const logger = createLogger();
  const log = logger.forModule('ingest');

  const rpcUrl = process.env.HELIUS_RPC_URL;
  if (!rpcUrl) {
    log.error('config.missing', { var: 'HELIUS_RPC_URL' });
    process.exit(2);
  }

  const storage = openStorage();
  const rpc = createRpc({ url: rpcUrl, logger: logger.forModule('rpc') });
  const stakewiz = createStakewiz({ logger: logger.forModule('stakewiz') });
  const validatorsApp = createValidatorsApp({ logger: logger.forModule('validators-app') });

  log.info('start', { run_id: logger.runId });

  // 1. Detect current epoch on chain.
  const epochInfo = await rpc.getEpochInfo();
  const epoch = epochInfo.epoch;
  log.info('epoch.detected', {
    epoch,
    slot_index: epochInfo.slotIndex,
    slots_in_epoch: epochInfo.slotsInEpoch,
  });

  // 2. Bail if this epoch's already done.
  if (storage.isEpochAlreadyIngested(epoch)) {
    log.info('epoch.skipped', { epoch, reason: 'already_ingested' });
    storage.close();
    return;
  }

  const startedAt = nowSeconds();
  storage.startRun({
    run_id: logger.runId,
    epoch,
    started_at: startedAt,
    status: 'in_progress',
  });

  // Watchlist — bootstrap list of pools to track. Will be expanded later via
  // a SolanaCompass top-25 discovery script.
  const watchlist = readWatchlist();
  const pools = watchlist.map((w) => w.pool_address);
  const watchlistByAddress = new Map(watchlist.map((w) => [w.pool_address, w]));
  log.info('watchlist.read', { count: pools.length });
  if (pools.length === 0) {
    log.warn('watchlist.empty', {
      hint: 'add pool addresses to config/pools-watchlist.json:additions',
    });
    storage.finishRun({
      run_id: logger.runId,
      finished_at: nowSeconds(),
      status: 'failed',
      pools_processed: 0,
      pools_failed: 0,
      notes: 'watchlist empty',
    });
    storage.close();
    return;
  }

  let processed = 0;
  let failed = 0;
  const successfulPools: string[] = [];

  // 3. Per-pool snapshot.
  for (const poolAddress of pools) {
    try {
      const d = await fetchPoolDelegations(rpc, poolAddress);
      const watchlistEntry = watchlistByAddress.get(poolAddress);
      storage.upsertPool({
        pool_address: poolAddress,
        pool_name: watchlistEntry?.name ?? null,
        pool_token_mint: d.poolMint,
        pool_program: d.poolProgram,
        is_tracked: 1,
        added_at: startedAt,
      });
      storage.replaceSnapshotsForPoolEpoch(
        epoch,
        poolAddress,
        d.delegations.map((v) => ({
          validator_pubkey: v.votePubkey,
          stake_lamports: v.activeStakeLamports,
          captured_at: startedAt,
        })),
      );
      log.info('pool.snapshot.captured', {
        pool: poolAddress,
        program: d.poolProgram,
        validators: d.delegations.length,
        zero_stake_skipped: d.zeroStakeCount,
        total_sol: Number(d.totalLamports) / 1e9,
      });
      processed++;
      successfulPools.push(poolAddress);
    } catch (e) {
      failed++;
      log.error('pool.snapshot.failed', { pool: poolAddress, error: errMessage(e) });
    }
  }

  // 4. Fetch Stakewiz + Validators.app — once per ingest, both return the
  //    full active set (~1500 validators each). Cheap enough at our cadence.
  let stakewizData: Awaited<ReturnType<typeof stakewiz.fetchAllValidators>> = [];
  try {
    stakewizData = await stakewiz.fetchAllValidators();
  } catch (e) {
    log.error('stakewiz.fetch.failed', { error: errMessage(e) });
  }

  let vaData: Awaited<ReturnType<typeof validatorsApp.fetchAllValidators>> = [];
  if (validatorsApp.isConfigured()) {
    try {
      vaData = await validatorsApp.fetchAllValidators();
    } catch (e) {
      log.warn('validators_app.fetch.failed', { error: errMessage(e) });
    }
  } else {
    log.info('validators_app.skipped', { reason: 'no_token_configured' });
  }

  const stakewizMap = new Map(stakewizData.map((v) => [v.vote_identity, v]));
  const vaMap = new Map(vaData.map((v) => [v.vote_account, v]));

  // 5. Enrichment for the union of validators across all successful pools,
  //    PLUS all stakewiz validators (for the network-baseline computation).
  const poolPubkeys = new Set<string>();
  for (const pool of successfulPools) {
    for (const s of storage.listSnapshotsForPoolEpoch(epoch, pool)) {
      poolPubkeys.add(s.validator_pubkey);
    }
  }
  // Network baseline needs every active validator's metadata too.
  for (const v of stakewizData) poolPubkeys.add(v.vote_identity);

  const enriched = enrichValidators({
    pubkeys: Array.from(poolPubkeys),
    stakewiz: stakewizMap,
    validatorsApp: vaMap,
    logger: logger.forModule('enrichment'),
    now: nowSeconds(),
  });
  storage.upsertValidators(enriched);
  log.info('enrichment.upserted', { count: enriched.length });

  // 6. Network shares — computed once from the full Stakewiz validator set
  //    and reused for every pool score + the baseline. The "rarity" reference.
  let networkShares: ReturnType<typeof computeNetworkShares> | null = null;
  let baselineRows: PoolStakeRow[] = [];
  let baselineMeta: Map<string, ValidatorMetadata> = new Map();
  if (stakewizData.length > 0) {
    baselineRows = stakewizData
      .filter((v) => v.activated_stake != null && v.activated_stake > 0)
      .map((v) => ({
        pubkey: v.vote_identity,
        stakeLamports: BigInt(Math.floor((v.activated_stake as number) * 1e9)),
      }));
    baselineMeta = new Map<string, ValidatorMetadata>();
    for (const v of stakewizData) {
      baselineMeta.set(v.vote_identity, {
        pubkey: v.vote_identity,
        country: v.ip_country,
        city: v.ip_city,
        asn: v.ip_asn != null ? String(v.ip_asn) : null,
        wizScore: v.wiz_score,
      });
    }
    networkShares = computeNetworkShares(baselineRows, baselineMeta);
    log.info('network.shares.computed', {
      country_buckets: networkShares.country.size,
      city_buckets: networkShares.city.size,
      asn_buckets: networkShares.asn.size,
    });
  } else {
    log.error('network.shares.missing', {
      reason: 'stakewiz returned 0 validators; cannot compute scores',
    });
  }

  // 7. Per-pool scores — only if we have network shares to compute rarity against.
  let scoredPools = 0;
  if (networkShares) {
    for (const poolAddress of successfulPools) {
      try {
        const snaps = storage.listSnapshotsForPoolEpoch(epoch, poolAddress);
        const rows: PoolStakeRow[] = snaps.map((s) => ({
          pubkey: s.validator_pubkey,
          stakeLamports: BigInt(s.stake_lamports as unknown as string),
        }));
        const meta = new Map<string, ValidatorMetadata>();
        for (const s of snaps) {
          const v = storage.getValidator(s.validator_pubkey);
          if (!v) continue;
          meta.set(v.validator_pubkey, {
            pubkey: v.validator_pubkey,
            country: v.country,
            city: v.city,
            asn: v.asn,
            wizScore: v.stakewiz_wiz_score,
          });
        }
        const result = computePoolScores(rows, meta, networkShares);
        storage.upsertPoolScore({
          epoch,
          pool_address: poolAddress,
          dc_country: result.dc_country,
          dc_city: result.dc_city,
          dc_asn: result.dc_asn,
          gdi_composite: result.gdi,
          network_impact_score: Number.isNaN(result.nis) ? null : result.nis,
          placement_coverage: result.placementCoverage,
          validator_count: result.validatorCount,
          total_stake_lamports: result.totalStakeLamports,
          computed_at: nowSeconds(),
          methodology_version: METHODOLOGY_VERSION,
        });
        scoredPools++;
        log.info('pool.scored', {
          pool: poolAddress,
          gdi: round(result.gdi, 4),
          dc_country: round(result.dc_country, 3),
          dc_city: round(result.dc_city, 3),
          dc_asn: round(result.dc_asn, 3),
          nis: Number.isNaN(result.nis) ? null : round(result.nis, 2),
          placement_coverage: round(result.placementCoverage, 3),
          validators: result.validatorCount,
        });
      } catch (e) {
        failed++;
        log.error('pool.score.failed', { pool: poolAddress, error: errMessage(e) });
      }
    }
  }

  // 8. Network baseline — uses the same shares.
  if (networkShares && baselineRows.length > 0) {
    try {
      const baseline = computeNetworkBaseline(baselineRows, baselineMeta, networkShares);
      storage.upsertNetworkBaseline({
        epoch,
        dc_country: baseline.dc_country,
        dc_city: baseline.dc_city,
        dc_asn: baseline.dc_asn,
        gdi_composite: baseline.gdi,
        validator_count: baseline.validatorCount,
        total_stake_lamports: baseline.totalStakeLamports,
        computed_at: nowSeconds(),
        methodology_version: METHODOLOGY_VERSION,
      });
      log.info('baseline.computed', {
        gdi: round(baseline.gdi, 4),
        dc_country: round(baseline.dc_country, 3),
        dc_city: round(baseline.dc_city, 3),
        dc_asn: round(baseline.dc_asn, 3),
        validator_count: baseline.validatorCount,
      });
    } catch (e) {
      log.error('baseline.failed', { error: errMessage(e) });
    }
  }

  // 9. Finalise the run.
  const status =
    failed === 0 && scoredPools === pools.length ? 'success'
    : scoredPools > 0 ? 'partial'
    : 'failed';

  storage.upsertEpoch({
    epoch_number: epoch,
    ingested_at: nowSeconds(),
  });
  storage.finishRun({
    run_id: logger.runId,
    finished_at: nowSeconds(),
    status,
    pools_processed: scoredPools,
    pools_failed: failed,
  });
  log.info('finish', {
    epoch,
    status,
    pools_processed: scoredPools,
    pools_failed: failed,
    duration_s: nowSeconds() - startedAt,
  });

  storage.close();
}

function round(n: number, digits: number): number {
  if (!Number.isFinite(n)) return n;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
