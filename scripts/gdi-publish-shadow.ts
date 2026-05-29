// scripts/gdi-publish-shadow.ts
//
// PASS B of the publish step — same scoring methodology as the canonical
// pipeline, but applied to MERGED geo (override > maxmind > stakewiz/canonical).
// Writes to a parallel published directory; never touches OUTPUT_DIR.
//
// Pure invocation surface: callers pass in everything needed; this module
// owns no env vars and opens no I/O of its own beyond the JSON writes.
//
// Failure isolation: callers should wrap this in try/catch. If anything in
// here throws, the canonical pipeline (already complete by the time we run)
// is unaffected.

import { writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ModuleLogger } from '../src/lib/gdi/logger.ts';
import {
  type Storage, type PoolScore, type NetworkBaseline,
} from '../src/lib/gdi/storage.ts';
import {
  METHODOLOGY_VERSION,
  computePoolScores,
  computeNetworkBaseline,
  computeNetworkShares,
  type PoolStakeRow,
  type ValidatorMetadata,
  type NetworkShares,
} from '../src/lib/gdi/scoring.ts';
import { mergeGeo, type MergedGeo } from '../src/lib/gdi/data-sources/merge-geo.ts';

async function atomicWriteJson(path: string, obj: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  await rename(tmp, path);
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

export type ShadowPassInput = {
  storage: Storage;
  latestEpoch: number;
  shadowOutputDir: string;
  /** Tracked pools list (same shape Pass A uses). */
  pools: Array<{
    pool_address: string;
    pool_name: string | null;
    pool_program: string | null;
    pool_token_mint: string | null;
  }>;
  /** Per-pool client distribution snapshot — geo-independent, reused as-is. */
  clientDistByPool: Map<string, unknown>;
  /** Network-wide client distribution snapshot — same reason. */
  networkClientDistribution: unknown;
  log: ModuleLogger;
};

export type ShadowPassResult = {
  scored_pools: number;
  network_gdi: number | null;
  active_validators: number;
  active_stake_sol: number;
  output_dir: string;
};

/**
 * Run Pass B end-to-end. Writes:
 *
 *   <shadowOutputDir>/leaderboard-latest.json
 *   <shadowOutputDir>/leaderboard-<epoch>.json   (write-once on epoch advance)
 *   <shadowOutputDir>/network-baseline.json
 *   <shadowOutputDir>/pools/<addr>/latest.json   (per tracked pool)
 *
 * AND persists rows to pool_scores_shadow / network_baseline_shadow /
 * network_shares_shadow in the same SQLite the canonical tables live in.
 */
export async function runShadowPass(input: ShadowPassInput): Promise<ShadowPassResult> {
  const { storage, latestEpoch, shadowOutputDir, pools, clientDistByPool, networkClientDistribution, log } = input;

  // ── Inputs: overrides, shadow rows for this epoch, canonical validators ──
  const overrides = storage.listGeoOverrides();
  const overrideByPubkey = new Map(overrides.map((o) => [o.validator_pubkey, o]));
  const shadowRows = storage.listGeoShadowForEpoch(latestEpoch);
  const shadowByPubkey = new Map(shadowRows.map((r) => [r.validator_pubkey, r]));
  const allValidators = storage.listAllValidators();

  log.info('shadow.inputs', {
    overrides: overrides.length,
    shadow_rows: shadowRows.length,
    validators: allValidators.length,
  });

  // ── Per-validator merge: produce a MergedGeo for every known validator ──
  // The merge function falls through override → maxmind (from shadow_*) →
  // stakewiz (canonical row). validators-app is already merged into the
  // canonical row by enrichValidators(), so we treat the canonical row as
  // "stakewiz" — the disagreement detection still catches cases where the
  // override/maxmind disagree with whatever canonical resolved to.
  const mergedByPubkey = new Map<string, MergedGeo>();
  for (const v of allValidators) {
    const shadow = shadowByPubkey.get(v.validator_pubkey);
    const merged = mergeGeo({
      override: overrideByPubkey.get(v.validator_pubkey) ?? null,
      maxmind: shadow ? {
        country: shadow.shadow_country,
        city: shadow.shadow_city,
        asn: shadow.shadow_asn,
        asn_org: shadow.shadow_asn_name,
      } : null,
      stakewiz: { country: v.country, city: v.city, asn: v.asn, asn_name: v.asn_name },
      pubkey: v.validator_pubkey,
      // logger intentionally omitted here — disagreement WARNs from a full
      // 3500-validator merge would dominate the journal. The diff report
      // surfaces aggregates instead.
    });
    mergedByPubkey.set(v.validator_pubkey, merged);
  }

  // ── Build shadow network shares from the active set + merged geo ──
  // Active = not delinquent AND activated_stake > 0 (same definition the
  // canonical scorer uses).
  const baselineRows: PoolStakeRow[] = [];
  const baselineMeta = new Map<string, ValidatorMetadata>();
  for (const v of allValidators) {
    if (v.delinquent === 1) continue;
    if (v.activated_stake_lamports == null || v.activated_stake_lamports <= 0) continue;
    const merged = mergedByPubkey.get(v.validator_pubkey);
    baselineRows.push({
      pubkey: v.validator_pubkey,
      stakeLamports: BigInt(v.activated_stake_lamports as unknown as string),
    });
    baselineMeta.set(v.validator_pubkey, {
      pubkey: v.validator_pubkey,
      country: merged?.country ?? null,
      city: merged?.city ?? null,
      asn: merged?.asn ?? null,
      wizScore: v.stakewiz_wiz_score,
    });
  }
  const shadowShares: NetworkShares = computeNetworkShares(baselineRows, baselineMeta);
  log.info('shadow.shares.computed', {
    country_buckets: shadowShares.country.size,
    city_buckets: shadowShares.city.size,
    asn_buckets: shadowShares.asn.size,
  });

  // Persist shadow network_shares. Mirrors what gdi-ingest writes to
  // network_shares (the canonical version) so any cross-epoch tooling
  // can apples-to-apples.
  const sharesBucketCounts = {
    country: new Map<string, number>(),
    city: new Map<string, number>(),
    asn: new Map<string, number>(),
  };
  for (const [, meta] of baselineMeta) {
    if (meta.country) sharesBucketCounts.country.set(meta.country, (sharesBucketCounts.country.get(meta.country) ?? 0) + 1);
    if (meta.city)    sharesBucketCounts.city.set(meta.city,       (sharesBucketCounts.city.get(meta.city)       ?? 0) + 1);
    if (meta.asn)     sharesBucketCounts.asn.set(meta.asn,         (sharesBucketCounts.asn.get(meta.asn)         ?? 0) + 1);
  }
  const sharesRows: { dimension: 'country' | 'city' | 'asn'; bucket: string; share: number; validator_count: number }[] = [];
  for (const dim of ['country', 'city', 'asn'] as const) {
    for (const [bucket, share] of shadowShares[dim]) {
      sharesRows.push({ dimension: dim, bucket, share, validator_count: sharesBucketCounts[dim].get(bucket) ?? 0 });
    }
  }
  storage.replaceNetworkSharesShadowForEpoch(latestEpoch, sharesRows, nowSeconds());
  log.info('shadow.shares.persisted', { rows: sharesRows.length });

  // ── Shadow network baseline ──
  const shadowBaselineResult = computeNetworkBaseline(baselineRows, baselineMeta, shadowShares);
  const shadowBaselineRow: NetworkBaseline = {
    epoch: latestEpoch,
    dc_country: shadowBaselineResult.dc_country,
    dc_city: shadowBaselineResult.dc_city,
    dc_asn: shadowBaselineResult.dc_asn,
    gdi_composite: shadowBaselineResult.gdi,
    validator_count: shadowBaselineResult.validatorCount,
    total_stake_lamports: shadowBaselineResult.totalStakeLamports,
    computed_at: nowSeconds(),
    methodology_version: METHODOLOGY_VERSION,
  };
  storage.upsertNetworkBaselineShadow(shadowBaselineRow);

  const formatBaseline = (b: NetworkBaseline) => ({
    epoch: b.epoch,
    dc_country: b.dc_country,
    dc_city: b.dc_city,
    dc_asn: b.dc_asn,
    gdi: b.gdi_composite,
    validator_count: b.validator_count,
    total_stake_sol: b.total_stake_lamports == null ? null : Number(b.total_stake_lamports) / 1e9,
    methodology_version: b.methodology_version,
  });

  const allShadowBaselines = storage.listShadowBaselines();
  await atomicWriteJson(join(shadowOutputDir, 'network-baseline.json'), {
    latest: formatBaseline(shadowBaselineRow),
    history: allShadowBaselines.map(formatBaseline),
  });

  // ── Per-pool shadow scores ──
  const formatPoolScore = (s: PoolScore) => ({
    epoch: s.epoch,
    pool_address: s.pool_address,
    dc_country: s.dc_country,
    dc_city: s.dc_city,
    dc_asn: s.dc_asn,
    gdi: s.gdi_composite,
    nis: s.network_impact_score,
    placement_coverage: s.placement_coverage,
    validator_count: s.validator_count,
    total_stake_sol: s.total_stake_lamports == null ? null : Number(s.total_stake_lamports) / 1e9,
    methodology_version: s.methodology_version,
  });

  let poolsScored = 0;
  const shadowPoolScores: PoolScore[] = [];
  for (const pool of pools) {
    const snaps = storage.listSnapshotsForPoolEpoch(latestEpoch, pool.pool_address);
    if (snaps.length === 0) continue;

    const rows: PoolStakeRow[] = snaps.map((s) => ({
      pubkey: s.validator_pubkey,
      stakeLamports: BigInt(s.stake_lamports as unknown as string),
    }));
    const meta = new Map<string, ValidatorMetadata>();
    for (const s of snaps) {
      const merged = mergedByPubkey.get(s.validator_pubkey);
      if (!merged) continue;       // validator not in our directory — skip
      const v = storage.getValidator(s.validator_pubkey);
      meta.set(s.validator_pubkey, {
        pubkey: s.validator_pubkey,
        country: merged.country,
        city: merged.city,
        asn: merged.asn,
        wizScore: v?.stakewiz_wiz_score ?? null,
      });
    }
    const result = computePoolScores(rows, meta, shadowShares);
    const scoreRow: PoolScore = {
      epoch: latestEpoch,
      pool_address: pool.pool_address,
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
    };
    storage.upsertPoolScoreShadow(scoreRow);
    shadowPoolScores.push(scoreRow);
    poolsScored++;

    // Per-pool latest.json — include merged geo + sources per validator so
    // staging UI can render the provenance.
    const validatorsInline = snaps.map((s) => {
      const merged = mergedByPubkey.get(s.validator_pubkey) ?? null;
      const v = storage.getValidator(s.validator_pubkey);
      return {
        pubkey: s.validator_pubkey,
        stake_sol: Number(s.stake_lamports) / 1e9,
        country: merged?.country ?? null,
        city: merged?.city ?? null,
        asn: merged?.asn ?? null,
        asn_name: merged?.asn_name ?? null,
        geo_sources: merged?.sources ?? null,
        wiz_score: v?.stakewiz_wiz_score ?? null,
        client_name: v?.client_name ?? null,
        client_version: v?.client_version ?? null,
        is_jito: v?.is_jito == null ? null : v.is_jito === 1,
        is_dz:   v?.is_dz   == null ? null : v.is_dz   === 1,
        is_bam:  v?.is_bam  == null ? null : v.is_bam  === 1,
      };
    });
    await atomicWriteJson(join(shadowOutputDir, 'pools', pool.pool_address, 'latest.json'), {
      pool: {
        address: pool.pool_address,
        name: pool.pool_name,
        program: pool.pool_program,
        token_mint: pool.pool_token_mint,
      },
      score: formatPoolScore(scoreRow),
      network_baseline: formatBaseline(shadowBaselineRow),
      client_distribution: clientDistByPool.get(pool.pool_address) ?? null,
      validators: validatorsInline,
    });
  }

  // ── Shadow leaderboard ──
  // Rank by shadow GDI desc. Mirrors Pass A's inclusion rule (real GDI, ≥1 validator).
  const scoredLeaderboard = shadowPoolScores
    .filter((s) => s.gdi_composite != null && (s.validator_count ?? 0) >= 1)
    .sort((a, b) => (b.gdi_composite ?? 0) - (a.gdi_composite ?? 0));
  const poolMetaByAddr = new Map(pools.map((p) => [p.pool_address, p]));
  const leaderboard = {
    epoch: latestEpoch,
    last_published_at: new Date().toISOString(),
    methodology_version: METHODOLOGY_VERSION,
    network_baseline: formatBaseline(shadowBaselineRow),
    network_client_distribution: networkClientDistribution,
    pools: scoredLeaderboard.map((s) => {
      const meta = poolMetaByAddr.get(s.pool_address);
      return {
        ...formatPoolScore(s),
        pool_name: meta?.pool_name ?? null,
        pool_program: meta?.pool_program ?? null,
        pool_token_mint: meta?.pool_token_mint ?? null,
        client_distribution: clientDistByPool.get(s.pool_address) ?? null,
      };
    }),
  };
  await atomicWriteJson(join(shadowOutputDir, 'leaderboard-latest.json'), leaderboard);

  // Per-epoch frozen file — write-once on epoch advance, identical
  // semantics to Pass A.
  const perEpochPath = join(shadowOutputDir, `leaderboard-${latestEpoch}.json`);
  if (!existsSync(perEpochPath)) {
    await atomicWriteJson(perEpochPath, leaderboard);
    log.info('shadow.epoch_snapshot_frozen', { epoch: latestEpoch, path: perEpochPath });
  }

  return {
    scored_pools: poolsScored,
    network_gdi: shadowBaselineResult.gdi,
    active_validators: shadowBaselineResult.validatorCount,
    active_stake_sol: Number(shadowBaselineResult.totalStakeLamports) / 1e9,
    output_dir: shadowOutputDir,
  };
}
