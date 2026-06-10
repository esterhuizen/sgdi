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

  // Shadow has only been running since Pass B was deployed; for older epochs
  // we don't have shadow baselines. Stitch in canonical baselines for the
  // pre-shadow epochs so /impact's network trend renders continuously.
  // Where both exist for the same epoch, shadow wins (it's the more
  // up-to-date "view of the world" for that epoch under shadow methodology).
  const allShadowBaselines = storage.listShadowBaselines();
  const shadowEpochs = new Set(allShadowBaselines.map((b) => b.epoch));
  const canonicalBaselines = storage.listBaselines().filter((b) => !shadowEpochs.has(b.epoch));
  const mergedBaselines = [...allShadowBaselines, ...canonicalBaselines]
    .sort((a, b) => b.epoch - a.epoch);
  await atomicWriteJson(join(shadowOutputDir, 'network-baseline.json'), {
    latest: formatBaseline(shadowBaselineRow),
    history: mergedBaselines.map(formatBaseline),
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
  // Collected in the scoring loop, written AFTER ranking is known so each
  // pool's latest.json carries rank/total_ranked (matching Pass A).
  const perPoolData: Array<{
    pool: (typeof pools)[number];
    scoreRow: PoolScore;
    validatorsInline: unknown[];
  }> = [];
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
    // the UI can render provenance, AND the per-validator gradient `g` the
    // pool page's g-distribution chart needs. Mirrors Pass A's computation
    // (gdi-publish.ts) exactly, but over MERGED geo + the merged active-set
    // shares (shadowShares). Two passes: gather per-validator rarities, then
    // the pool's stake-weighted dc_*_viz, then g per validator.
    //   g = ((r_country/dc_country) + (r_city/dc_city) + (r_asn/dc_asn)) / 3
    const RARITY_FLOOR = 1e-9;
    const rarityFromShareViz = (share: number) =>
      share > 0 ? -Math.log(share) : -Math.log(RARITY_FLOOR);
    // Buckets absent from the active-set shares (e.g. delinquent-only) render
    // as null, matching the gdi-1.1.1 scorer which excludes them from DC —
    // not as the alarming-looking 20.7 floor.
    const rarityViz = (dim: 'country' | 'city' | 'asn', bucket: string | null): number | null => {
      if (!bucket) return null;
      const share = shadowShares[dim].get(bucket);
      return share == null ? null : rarityFromShareViz(share);
    };

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
        r_country: rarityViz('country', merged?.country ?? null),
        r_city:    rarityViz('city',    merged?.city ?? null),
        r_asn:     rarityViz('asn',     merged?.asn ?? null),
        g: null as number | null, // filled below once pool dc_*_viz is known
      };
    });
    // Pool's stake-weighted dc_* over placeable validators (this pool only) —
    // intentionally the active-set viz rarities, matching Pass A's note that
    // this can drift a few % from the official scorer's dc_*.
    const dcViz = (rKey: 'r_country' | 'r_city' | 'r_asn'): number | null => {
      let weighted = 0, placeable = 0;
      for (const r of validatorsInline) {
        const ri = r[rKey];
        if (ri == null) continue;
        weighted += r.stake_sol * ri;
        placeable += r.stake_sol;
      }
      return placeable > 0 ? weighted / placeable : null;
    };
    const dcCViz = dcViz('r_country'), dcCityViz = dcViz('r_city'), dcAViz = dcViz('r_asn');
    for (const r of validatorsInline) {
      if (
        r.r_country != null && r.r_city != null && r.r_asn != null &&
        dcCViz   != null && dcCViz   > 0 &&
        dcCityViz != null && dcCityViz > 0 &&
        dcAViz   != null && dcAViz   > 0
      ) {
        r.g = ((r.r_country / dcCViz) + (r.r_city / dcCityViz) + (r.r_asn / dcAViz)) / 3;
      }
    }
    // Defer the latest.json write until ranks are known (after the loop).
    perPoolData.push({ pool, scoreRow, validatorsInline });

    // Stitch canonical pre-shadow scores into the shadow history.json for
    // this pool. Same rationale as the network-baseline merge above: shadow
    // has only been running since Pass B was deployed (epoch 978+), so
    // shadow's per-pool history would otherwise be a single point. The
    // pool detail page's trend chart needs continuity 969→978 to show the
    // shadow jump as a visible step. Shadow wins per-epoch where both exist.
    const shadowPoolHistory = storage.listShadowScoresForPool(pool.pool_address);
    const shadowEpochs = new Set(shadowPoolHistory.map((s) => s.epoch));
    const canonicalPoolHistory = storage.listScoresForPool(pool.pool_address)
      .filter((s) => !shadowEpochs.has(s.epoch));
    const mergedHistory = [...shadowPoolHistory, ...canonicalPoolHistory]
      .sort((a, b) => b.epoch - a.epoch);
    await atomicWriteJson(join(shadowOutputDir, 'pools', pool.pool_address, 'history.json'), {
      pool: {
        address: pool.pool_address,
        name: pool.pool_name,
      },
      methodology_version: METHODOLOGY_VERSION,
      history: mergedHistory.map(formatPoolScore),
    });
  }

  // ── Rank pools, then write per-pool latest.json ──
  // Single source of truth for ranking (reused by the leaderboard below).
  // Inclusion + order mirror Pass A: real GDI, ≥1 validator, GDI desc.
  const scoredLeaderboard = shadowPoolScores
    .filter((s) => s.gdi_composite != null && (s.validator_count ?? 0) >= 1)
    .sort((a, b) => (b.gdi_composite ?? 0) - (a.gdi_composite ?? 0));
  const rankByAddress = new Map(scoredLeaderboard.map((s, i) => [s.pool_address, i + 1]));
  const totalRanked = scoredLeaderboard.length;

  for (const { pool, scoreRow, validatorsInline } of perPoolData) {
    await atomicWriteJson(join(shadowOutputDir, 'pools', pool.pool_address, 'latest.json'), {
      pool: {
        address: pool.pool_address,
        name: pool.pool_name,
        program: pool.pool_program,
        token_mint: pool.pool_token_mint,
      },
      score: formatPoolScore(scoreRow),
      network_baseline: formatBaseline(shadowBaselineRow),
      // Leaderboard rank (1-indexed) + total ranked pools — Pass A parity;
      // the pool detail page rank badge + pool OG card read these.
      rank: rankByAddress.get(pool.pool_address) ?? null,
      total_ranked: totalRanked,
      client_distribution: clientDistByPool.get(pool.pool_address) ?? null,
      validators: validatorsInline,
    });
  }

  // ── Shadow validator-index.json + validators.json ──
  // Mirrors Pass A's lines 486-649 in gdi-publish.ts. Per-validator rarity
  // is recomputed against shadowShares (active-set fractions over merged
  // geo) so the /validator page on staging shows the shadow world's view
  // of who's rare. Without this, nginx falls through to the canonical file
  // and the page silently shows canonical rankings — defeating the point
  // of running shadow on staging.
  const totalActiveStakeSol = Number(shadowBaselineRow.total_stake_lamports ?? 0n) / 1e9;
  const rarityOf = (share: number | null): number | null =>
    share == null || share <= 0 ? null : -Math.log(share);

  type ShadowActiveRow = {
    vote_pubkey: string;
    identity_pubkey: string | null;
    identity_name: string | null;
    image_url: string | null;
    country: string | null;
    city: string | null;
    asn: string | null;
    asn_name: string | null;
    geo_sources: MergedGeo['sources'] | null;
    activated_stake_sol: number;
    network_share_country: number | null;
    network_share_city: number | null;
    network_share_asn: number | null;
    rarity_country: number | null;
    rarity_city: number | null;
    rarity_asn: number | null;
    composite_rarity: number | null;
    is_dz: boolean | null;
    is_jito: boolean | null;
    is_bam: boolean | null;
    client_name: string | null;
    client_version: string | null;
    wiz_score: number | null;
    ibrl_score: number | null;
  };

  const activeRows: ShadowActiveRow[] = [];
  for (const v of allValidators) {
    if (v.delinquent === 1) continue;
    if (v.activated_stake_lamports == null || v.activated_stake_lamports <= 0) continue;
    const merged = mergedByPubkey.get(v.validator_pubkey);
    const stakeSol = Number(v.activated_stake_lamports) / 1e9;
    const countryShare = merged?.country ? (shadowShares.country.get(merged.country) ?? null) : null;
    const cityShare    = merged?.city    ? (shadowShares.city.get(merged.city)       ?? null) : null;
    const asnShare     = merged?.asn     ? (shadowShares.asn.get(merged.asn)         ?? null) : null;
    const rCountry = rarityOf(countryShare);
    const rCity    = rarityOf(cityShare);
    const rAsn     = rarityOf(asnShare);
    const composite = (rCountry != null && rCountry > 0 && rCity != null && rCity > 0 && rAsn != null && rAsn > 0)
      ? Math.cbrt(rCountry * rCity * rAsn)
      : null;
    activeRows.push({
      vote_pubkey: v.validator_pubkey,
      identity_pubkey: v.identity_pubkey,
      identity_name: v.identity_name,
      image_url: v.image_url,
      country: merged?.country ?? null,
      city: merged?.city ?? null,
      asn: merged?.asn ?? null,
      asn_name: merged?.asn_name ?? null,
      geo_sources: merged?.sources ?? null,
      activated_stake_sol: stakeSol,
      network_share_country: countryShare,
      network_share_city: cityShare,
      network_share_asn: asnShare,
      rarity_country: rCountry,
      rarity_city: rCity,
      rarity_asn: rAsn,
      composite_rarity: composite,
      is_dz: v.is_dz == null ? null : v.is_dz === 1,
      is_jito: v.is_jito == null ? null : v.is_jito === 1,
      is_bam: v.is_bam == null ? null : v.is_bam === 1,
      client_name: v.client_name,
      client_version: v.client_version,
      wiz_score: v.stakewiz_wiz_score,
      ibrl_score: v.ibrl_score,
    });
  }

  const rankable = activeRows.filter((r) => r.composite_rarity != null);
  rankable.sort((a, b) => (b.composite_rarity ?? 0) - (a.composite_rarity ?? 0));
  const rankByVote = new Map<string, number>();
  rankable.forEach((r, i) => rankByVote.set(r.vote_pubkey, i + 1));
  const medianRarity = rankable.length > 0
    ? rankable[Math.floor(rankable.length / 2)].composite_rarity ?? null
    : null;

  const indexed = activeRows
    .map((r) => ({
      ...r,
      rank: rankByVote.get(r.vote_pubkey) ?? null,
      percentile: rankByVote.get(r.vote_pubkey) != null
        ? +((rankByVote.get(r.vote_pubkey)! / rankable.length) * 100).toFixed(2)
        : null,
    }))
    .sort((a, b) => {
      if (a.rank == null && b.rank == null) return 0;
      if (a.rank == null) return 1;
      if (b.rank == null) return -1;
      return a.rank - b.rank;
    });

  await atomicWriteJson(join(shadowOutputDir, 'validator-index.json'), {
    last_published_at: new Date().toISOString(),
    epoch: latestEpoch,
    methodology_version: METHODOLOGY_VERSION,
    active_set_definition: "Stakewiz: !delinquent AND activated_stake > 0 (shadow geo: override > maxmind > stakewiz)",
    active_count: activeRows.length,
    rankable_count: rankable.length,
    total_active_stake_sol: totalActiveStakeSol,
    median_composite_rarity: medianRarity,
    validators: indexed,
  });

  // validators.json — full directory using merged geo. The /validator/[pk]
  // detail page reads this for image_url + identity_name; we want shadow
  // geo to flow into it too so the detail page is consistent with the index.
  await atomicWriteJson(join(shadowOutputDir, 'validators.json'), {
    last_published_at: new Date().toISOString(),
    count: allValidators.length,
    validators: allValidators.map((v) => {
      const merged = mergedByPubkey.get(v.validator_pubkey);
      return {
        vote_pubkey: v.validator_pubkey,
        identity_pubkey: v.identity_pubkey,
        identity_name: v.identity_name,
        image_url: v.image_url,
        country: merged?.country ?? null,
        city: merged?.city ?? null,
        asn: merged?.asn ?? null,
        asn_name: merged?.asn_name ?? null,
        geo_sources: merged?.sources ?? null,
        activated_stake_lamports: v.activated_stake_lamports == null
          ? null
          : String(v.activated_stake_lamports),
        delinquent: v.delinquent === 1,
        client_name: v.client_name,
        client_version: v.client_version,
        wiz_score: v.stakewiz_wiz_score,
        ibrl_score: v.ibrl_score,
      };
    }),
  });
  log.info('shadow.validator_index.written', {
    active: activeRows.length,
    rankable: rankable.length,
    median_composite_rarity: medianRarity,
  });

  // ── Shadow leaderboard ──
  // Reuses `scoredLeaderboard` computed above (same ranking the per-pool
  // latest.json files were stamped with).
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

  // ── Geo-moves artifact ──
  // Country-level relocation diff between the previous epoch's geo snapshot
  // and this one. Published as a public artifact so downstream consumers (the
  // auto-poster's per-epoch "validators moved to rarer places" post, future
  // UI panels) read verifiable JSON instead of querying the DB. ip_changed
  // distinguishes real relocations (new gossip IP) from same-IP geo-database
  // reclassifications. Additive output; nothing existing changes.
  {
    const prevShadowRows = storage.listGeoShadowForEpoch(latestEpoch - 1);
    if (prevShadowRows.length > 0) {
      const prevByPubkey = new Map(prevShadowRows.map((r) => [r.validator_pubkey, r]));
      const currShadowRows = storage.listGeoShadowForEpoch(latestEpoch);
      type Relocation = {
        vote_pubkey: string;
        name: string | null;
        from: string;
        to: string;
        from_share: number | null;
        to_share: number | null;
        stake_sol: number;
        ip_changed: boolean;
      };
      const relocations: Relocation[] = [];
      let changedStakeSol = 0;
      for (const curr of currShadowRows) {
        const prev = prevByPubkey.get(curr.validator_pubkey);
        if (!prev) continue;
        const from = prev.canonical_country;
        const to = curr.canonical_country;
        if (!from || !to || from === to) continue;
        const v = storage.getValidator(curr.validator_pubkey);
        const stakeSol =
          v?.activated_stake_lamports != null ? Number(v.activated_stake_lamports) / 1e9 : 0;
        if (stakeSol <= 0) continue;
        changedStakeSol += stakeSol;
        relocations.push({
          vote_pubkey: curr.validator_pubkey,
          name: v?.identity_name ?? null,
          from,
          to,
          from_share: shadowShares.country.get(from) ?? null,
          to_share: shadowShares.country.get(to) ?? null,
          stake_sol: stakeSol,
          ip_changed:
            prev.ip_used != null && curr.ip_used != null && prev.ip_used !== curr.ip_used,
        });
      }
      relocations.sort((a, b) => b.stake_sol - a.stake_sol);

      // "Rare" = a real relocation (IP changed) into a country holding < 1%
      // of active network stake — the decentralisation-positive subset.
      const RARE_SHARE_MAX = 0.01;
      const rare = relocations.filter(
        (r) => r.ip_changed && r.to_share != null && r.to_share < RARE_SHARE_MAX,
      );
      const destByCountry = new Map<string, { country: string; share: number | null; validators: number; stake_sol: number }>();
      for (const r of rare) {
        const d = destByCountry.get(r.to) ?? { country: r.to, share: r.to_share, validators: 0, stake_sol: 0 };
        d.validators += 1;
        d.stake_sol += r.stake_sol;
        destByCountry.set(r.to, d);
      }

      await atomicWriteJson(join(shadowOutputDir, 'geo-moves-latest.json'), {
        epoch: latestEpoch,
        prev_epoch: latestEpoch - 1,
        last_published_at: new Date().toISOString(),
        note:
          'Country-level geo changes between consecutive epoch snapshots (merged geo). ' +
          'ip_changed=true means the gossip IP also changed (a real relocation, not a ' +
          'geo-database reclassification). rare_relocations = ip_changed moves into ' +
          'countries holding < 1% of active network stake.',
        country_changes: { count: relocations.length, stake_sol: changedStakeSol },
        relocations,
        rare_relocations: {
          count: rare.length,
          stake_sol: rare.reduce((s, r) => s + r.stake_sol, 0),
          destinations: [...destByCountry.values()].sort((a, b) => b.stake_sol - a.stake_sol),
        },
      });
      log.info('shadow.geo_moves.written', {
        epoch: latestEpoch,
        country_changes: relocations.length,
        rare_relocations: rare.length,
      });
    }
  }

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
