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
import { createLogger, type ModuleLogger } from '../src/lib/gdi/logger.ts';
import { openStorage } from '../src/lib/gdi/storage.ts';
import {
  createRpc,
  fetchPoolDelegations,
  discoverTopStakePoolsByTvl,
  SPL_STAKE_POOL_PROGRAM_ID,
  SANCTUM_SVSP_PROGRAM_ID,
  SANCTUM_MULTI_PROGRAM_ID,
} from '../src/lib/gdi/data-sources/rpc.ts';
import { createStakewiz } from '../src/lib/gdi/data-sources/stakewiz.ts';
import { createValidatorsApp } from '../src/lib/gdi/data-sources/validators-app.ts';
import { createIbrl } from '../src/lib/gdi/data-sources/ibrl.ts';
import { createJupiter, buildMintNameMap } from '../src/lib/gdi/data-sources/jupiter.ts';
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

// How many top-by-TVL pools we keep per ingest. ~100 covers the long tail of
// real liquid-staking products on Solana; raising further mostly adds tiny
// single-validator Sanctum pools.
const TOP_POOLS_BY_TVL = Number(process.env.SGDI_TOP_POOLS ?? 100);

// Pools below this raw TVL get filtered out. 20,000 SOL is the cutoff that
// separates real-product LSTs (smallest legitimate ones sit ~20-50k SOL) from
// dust / mass-delegation experiments that spread tiny stake across many
// validators and would otherwise dominate the GDI leaderboard.
const MIN_POOL_TVL_LAMPORTS = 20_000n * 1_000_000_000n; // 20,000 SOL

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

/**
 * Defensive sanitizer for validators.app payloads.
 *
 * validators.app has intermittently returned all-"SolanaLabs" responses
 * from some instances behind their load balancer — every label collapses
 * to a single value. If we ingest such a payload, the upsert overwrites
 * good DB labels with "SolanaLabs", breaking the CDI / client-distribution
 * surfaces until a subsequent good payload restores them.
 *
 * This function detects the collapse (>100 labeled validators, <3 distinct
 * software_client values), nulls out the client_* fields in the payload
 * so the upsert's COALESCE preserves last-good DB values, and fires a
 * Telegram alert with a file-based 6h cooldown so sustained outages
 * don't spam the channel every 30 minutes.
 *
 * Returns the (possibly sanitized) array. Geo / jito / is_dz / version
 * fields are independent and always pass through unaffected.
 */
async function sanitizeValidatorsAppPayload<T extends {
  software_client: string | null;
  software_client_id: number | null;
}>(
  vaData: T[],
  ctx: { epoch: number; log: ModuleLogger },
): Promise<T[]> {
  if (vaData.length === 0) return vaData;
  const labeled = vaData.filter((v) => v.software_client);
  const distinctClients = new Set(labeled.map((v) => v.software_client)).size;
  if (labeled.length <= 100 || distinctClients >= 3) return vaData;

  ctx.log.warn('validators_app.payload_rejected', {
    reason: 'too_few_distinct_software_client_labels',
    labeled_validators: labeled.length,
    distinct_labels: distinctClients,
    labels_seen: [...new Set(labeled.map((v) => v.software_client))],
  });

  // File-based 6h cooldown so a sustained outage doesn't spam alerts.
  const cooldownPath =
    (process.env.SGDI_DB_PATH ?? '/var/lib/sgdi/gdi.db').replace(/[^/]*$/, '') +
    '.alert-validators_app_payload_rejected';
  const sixHoursMs = 6 * 60 * 60 * 1000;
  const { existsSync, statSync, writeFileSync } = await import('node:fs');
  let onCooldown = false;
  try {
    if (existsSync(cooldownPath)) {
      const age = Date.now() - statSync(cooldownPath).mtimeMs;
      if (age < sixHoursMs) onCooldown = true;
    }
  } catch { /* fall through: send */ }

  if (onCooldown) {
    ctx.log.info('alert.skipped', { kind: 'validators_app_payload_rejected', reason: 'cooldown_active' });
  } else {
    const { sendSgdiAlert } = await import('../src/lib/gdi/telegram.ts');
    const result = await sendSgdiAlert(
      `⚠ validators.app payload rejected — software_client labels collapsed ` +
      `(${distinctClients} distinct across ${labeled.length} labeled validators). ` +
      `Holding last-good client_name values in DB. Epoch ${ctx.epoch}.`,
    );
    if (!result.ok) {
      ctx.log.warn('alert.skipped', { reason: result.reason, detail: result.detail });
    } else {
      ctx.log.info('alert.sent', { kind: 'validators_app_payload_rejected' });
      try { writeFileSync(cooldownPath, String(Date.now())); }
      catch (e) { ctx.log.warn('alert.cooldown_write_failed', { error: errMessage(e) }); }
    }
  }

  // Strip the client_* fields; geo + jito + is_dz + version pass through.
  return vaData.map((v) => ({ ...v, software_client: null, software_client_id: null }));
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
  const ibrl = createIbrl({ logger: logger.forModule('ibrl') });
  const jupiter = createJupiter({ logger: logger.forModule('jupiter') });

  log.info('start', { run_id: logger.runId });

  // 1. Detect current epoch on chain.
  const epochInfo = await rpc.getEpochInfo();
  const epoch = epochInfo.epoch;
  log.info('epoch.detected', {
    epoch,
    slot_index: epochInfo.slotIndex,
    slots_in_epoch: epochInfo.slotsInEpoch,
  });

  // 2. Bail if this epoch's already done — BUT still refresh validator
  //    metadata. Stakewiz updates delinquent / stake / IP geolocation
  //    intra-epoch; the per-validator lookup page needs this fresh.
  //    The pool snapshots / scores / baseline are left untouched (those
  //    are by-design per-epoch artifacts).
  if (storage.isEpochAlreadyIngested(epoch)) {
    log.info('epoch.skipped', { epoch, reason: 'already_ingested' });
    try {
      const swData = await stakewiz.fetchAllValidators();
      let vaData = await validatorsApp.fetchAllValidators().catch(() => []);
      // Same defensive sanitizer as the heavy path. Without this the skip-path
      // (which runs on every timer tick after the epoch is first ingested)
      // would happily overwrite good DB labels with broken collapsed labels
      // every 30 minutes.
      vaData = await sanitizeValidatorsAppPayload(vaData, { epoch, log });
      const ibrlData = await ibrl.fetchAllValidators().catch((e) => {
        log.warn('ibrl.fetch.failed', { error: errMessage(e) });
        return [];
      });
      const stakewizMap = new Map(swData.map((v) => [v.vote_identity, v]));
      const vaMap = new Map(vaData.map((v) => [v.vote_account, v]));
      const ibrlMap = new Map(ibrlData.map((v) => [v.identity, v]));
      const pubkeys = new Set<string>();
      for (const v of swData) pubkeys.add(v.vote_identity);
      const refreshed = enrichValidators({
        pubkeys: Array.from(pubkeys),
        stakewiz: stakewizMap,
        validatorsApp: vaMap,
        ibrl: ibrlMap,
        logger: logger.forModule('enrichment'),
        now: nowSeconds(),
      });
      storage.upsertValidators(refreshed);
      log.info('validators.refreshed', { count: refreshed.length, mode: 'skip-path' });
    } catch (e) {
      log.warn('validators.refresh.failed', { error: errMessage(e) });
    }
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

  // Discover the top-N stake pools on chain by TVL. Watchlist still loaded,
  // but its role is now name-override only — a curated alias for pools whose
  // Jupiter entry is missing or unhelpful (e.g. "Definity" — Sanctum-Multi
  // pool with no clean Jupiter symbol).
  const watchlist = readWatchlist();
  const watchlistByAddress = new Map(watchlist.map((w) => [w.pool_address, w]));
  log.info('watchlist.read', { count: watchlist.length });

  const discovered = await discoverTopStakePoolsByTvl(
    rpc,
    [SPL_STAKE_POOL_PROGRAM_ID, SANCTUM_SVSP_PROGRAM_ID, SANCTUM_MULTI_PROGRAM_ID],
    TOP_POOLS_BY_TVL,
    logger.forModule('discover'),
  );
  // Strip dust pools (≤1 SOL); they're either abandoned or zero-stake artefacts.
  const nontrivial = discovered.filter((p) => p.totalLamports >= MIN_POOL_TVL_LAMPORTS);
  log.info('pools.discovered', {
    raw_count: discovered.length,
    after_min_tvl: nontrivial.length,
    min_tvl_sol: Number(MIN_POOL_TVL_LAMPORTS) / 1e9,
  });

  if (nontrivial.length === 0) {
    log.error('pools.discovered.empty', {
      hint: 'discovery returned no pools above min TVL — RPC or filter issue',
    });
    storage.finishRun({
      run_id: logger.runId,
      finished_at: nowSeconds(),
      status: 'failed',
      pools_processed: 0,
      pools_failed: 0,
      notes: 'discovery returned no pools',
    });
    storage.close();
    return;
  }

  // Pull Jupiter's LST tag list to map pool mints → friendly names. Soft-fail:
  // [] on error → pools just get watchlist names or fall through to nameless.
  const jupiterEntries = await jupiter.fetchLstList();
  const mintToName = buildMintNameMap(jupiterEntries);
  log.info('jupiter.names', { lst_count: jupiterEntries.length });

  // Build the iteration list. Name precedence: watchlist (manual override) →
  // Jupiter (mint lookup) → null (frontend shows truncated address).
  type PoolToIngest = {
    address: string;
    program: string;
    poolMint: string;
    name: string | null;
  };
  const pools: PoolToIngest[] = nontrivial.map((p) => ({
    address: p.address,
    program: p.program,
    poolMint: p.poolMint,
    name:
      watchlistByAddress.get(p.address)?.name ??
      mintToName.get(p.poolMint) ??
      null,
  }));

  let processed = 0;
  let failed = 0;
  const successfulPools: string[] = [];

  // 3. Per-pool snapshot. Small delay between pools to be polite to the RPC
  // provider — at 100 pools × 3 calls each, bursty traffic trips Helius rate
  // limiting. 250ms between pools = ~25s added to a full ingest, negligible.
  const POOL_FETCH_DELAY_MS = 250;
  for (const [poolIdx, pool] of pools.entries()) {
    if (poolIdx > 0) await new Promise((r) => setTimeout(r, POOL_FETCH_DELAY_MS));
    try {
      const d = await fetchPoolDelegations(rpc, pool.address);
      storage.upsertPool({
        pool_address: pool.address,
        pool_name: pool.name,
        pool_token_mint: d.poolMint,
        pool_program: d.poolProgram,
        is_tracked: 1,
        added_at: startedAt,
      });
      storage.replaceSnapshotsForPoolEpoch(
        epoch,
        pool.address,
        d.delegations.map((v) => ({
          validator_pubkey: v.votePubkey,
          stake_lamports: v.activeStakeLamports,
          captured_at: startedAt,
        })),
      );
      log.info('pool.snapshot.captured', {
        pool: pool.address,
        name: pool.name,
        program: d.poolProgram,
        validators: d.delegations.length,
        zero_stake_skipped: d.zeroStakeCount,
        total_sol: Number(d.totalLamports) / 1e9,
      });
      processed++;
      successfulPools.push(pool.address);
    } catch (e) {
      failed++;
      log.error('pool.snapshot.failed', { pool: pool.address, error: errMessage(e) });
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

  // Validators.app — read endpoints accept anonymous requests, so we always
  // fetch. Setting VALIDATORS_APP_TOKEN gets the higher rate-limit tier.
  // Primary source for `software_client` labels (Agave / Frankendancer /
  // JitoLabs / …) and the `jito` / `is_dz` operational flags.
  let vaData: Awaited<ReturnType<typeof validatorsApp.fetchAllValidators>> = [];
  try {
    vaData = await validatorsApp.fetchAllValidators();
    log.info('validators_app.fetched', {
      count: vaData.length,
      authenticated: validatorsApp.isConfigured(),
    });
  } catch (e) {
    log.warn('validators_app.fetch.failed', { error: errMessage(e) });
  }

  // Same defensive sanitizer the skip-path uses. Keep the call in both
  // places — the heavy path runs once per epoch, the skip-path runs
  // every 30 min for the rest of the epoch.
  vaData = await sanitizeValidatorsAppPayload(vaData, { epoch, log });

  // IBRL (block-build quality, Jito). Failure is non-fatal — enrichment
  // tolerates a missing map.
  const ibrlData = await ibrl.fetchAllValidators().catch((e) => {
    log.warn('ibrl.fetch.failed', { error: errMessage(e) });
    return [];
  });

  const stakewizMap = new Map(stakewizData.map((v) => [v.vote_identity, v]));
  const vaMap = new Map(vaData.map((v) => [v.vote_account, v]));
  const ibrlMap = new Map(ibrlData.map((v) => [v.identity, v]));

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
    ibrl: ibrlMap,
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
    // gdi-1.1.0: "the network" = actively-voting validators with stake.
    // Delinquent / dust nodes still hold delegations but don't produce
    // votes; counting them in the denominator inflates the network size
    // and lowers rarity for popular buckets. Stakewiz's `delinquent` flag
    // is derived from Solana's getVoteAccounts RPC.
    baselineRows = stakewizData
      .filter((v) =>
        v.activated_stake != null
        && v.activated_stake > 0
        && !v.delinquent,
      )
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

  // Tripwire: alert on hard failures. 'partial' is intentionally NOT alerted
  // — most partials are 1-2 transient Helius hiccups that resolve on their
  // own (the next epoch's run replaces them). 'failed' means we got zero
  // pool scores for this epoch, which is the real "something broke" signal.
  if (status === 'failed') {
    const { sendSgdiAlert } = await import('../src/lib/gdi/telegram.ts');
    const result = await sendSgdiAlert(
      `⚠ Ingest FAILED for epoch ${epoch}\n` +
      `Pools attempted: ${pools.length}\n` +
      `Pools failed: ${failed}\n` +
      `Run ID: ${logger.runId}\n` +
      `Will retry on next 30-min timer fire.`,
    );
    if (!result.ok) {
      log.warn('alert.skipped', { reason: result.reason, detail: result.detail });
    } else {
      log.info('alert.sent', { kind: 'ingest_failed' });
    }
  }

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
