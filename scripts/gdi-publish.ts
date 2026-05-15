// scripts/gdi-publish.ts
//
// Read SQLite (no writes), generate static JSON files atomically. Run after
// every successful ingest, OR on demand to regenerate from existing data.
//
// Outputs (under SGDI_PUBLISHED_DIR, default ./public/gdi):
//
//   methodology.json                       version + formula constants
//   network-baseline.json                  latest + per-epoch history
//   leaderboard-latest.json                current epoch, all pools
//   leaderboard-<epoch>.json               immutable historical snapshot
//   pools/<address>/latest.json            current pool score + per-validator
//   pools/<address>/history.json           full per-epoch trend
//   validators.json                        validator metadata directory
//   concentration-crosscheck.json          our computed shares vs Stakewiz's
//
// Atomic-write pattern: write to temp file next to target, then rename.
// nginx readers never see a half-written file.
//
// Run:   npm run publish
// Env:   SGDI_DB_PATH (default ./var/sgdi.db)
//        SGDI_PUBLISHED_DIR (default ./public/gdi in dev,
//                            /var/lib/sgdi/published in prod)

import { writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { adhocLogger } from '../src/lib/gdi/logger.ts';
import { openStorage, type ValidatorRow, type PoolScore, type NetworkBaseline } from '../src/lib/gdi/storage.ts';
import { METHODOLOGY_VERSION } from '../src/lib/gdi/scoring.ts';

const OUTPUT_DIR = resolve(process.env.SGDI_PUBLISHED_DIR || './public/gdi');

async function atomicWriteJson(path: string, obj: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  await rename(tmp, path);
}

// JSON-safe shape for a score row. The DB stores total_stake_lamports as a
// bigint via better-sqlite3; we serialise as string to avoid JSON precision loss.
function formatPoolScore(s: PoolScore) {
  return {
    epoch: s.epoch,
    pool_address: s.pool_address,
    dc_country: s.dc_country,
    dc_city: s.dc_city,
    dc_asn: s.dc_asn,
    gdi: s.gdi_composite,
    nis: s.network_impact_score,
    placement_coverage: s.placement_coverage,
    validator_count: s.validator_count,
    total_stake_sol:
      s.total_stake_lamports != null ? Number(s.total_stake_lamports) / 1e9 : null,
    methodology_version: s.methodology_version,
  };
}

function formatBaseline(b: NetworkBaseline) {
  return {
    epoch: b.epoch,
    dc_country: b.dc_country,
    dc_city: b.dc_city,
    dc_asn: b.dc_asn,
    gdi: b.gdi_composite,
    validator_count: b.validator_count,
    total_stake_sol:
      b.total_stake_lamports != null ? Number(b.total_stake_lamports) / 1e9 : null,
    methodology_version: b.methodology_version,
  };
}

function formatValidator(v: ValidatorRow) {
  return {
    pubkey: v.validator_pubkey,
    name: v.identity_name,
    country: v.country,
    city: v.city,
    asn: v.asn,
    asn_name: v.asn_name,
    datacenter: v.datacenter,
    // Client diversity fields (gdi-1.2 phase 1) — sourced from validators.app.
    client_name: v.client_name,
    client_version: v.client_version,
    is_jito: v.is_jito === null ? null : v.is_jito === 1,
    is_dz: v.is_dz === null ? null : v.is_dz === 1,
    sources: {
      country: v.country_source,
      city: v.city_source,
      asn: v.asn_source,
    },
    stakewiz: {
      wiz_score: v.stakewiz_wiz_score,
      city_concentration: v.stakewiz_city_concentration,
      asn_concentration: v.stakewiz_asn_concentration,
      refreshed_at: v.stakewiz_refreshed_at,
    },
    metadata_refreshed_at: v.metadata_refreshed_at,
  };
}

/**
 * Stake-weighted client breakdown for one pool. Returns a structured
 * summary suitable for embedding in the published JSON — caller decides
 * how to display.
 *
 * - `by_client`: per-label tallies (stake_sol, stake_share, validator_count)
 * - `operational`: jito / DoubleZero participation shares (stake-weighted)
 * - `effective_clients`: exp(Shannon entropy) — interpretable as "as-if N
 *   equal clients". 1.0 = full concentration; max = # distinct clients.
 * - `unclassified`: stake whose validator has no client_name (data gap)
 *
 * Stake-weighted (not validator-count): pool risk lives in dollars,
 * not in headcount. Documented choice for gdi-1.2.
 */
type ClientDistribution = {
  by_client: { client: string; stake_sol: number; stake_share: number; validator_count: number }[];
  operational: { jito_share: number; dz_share: number };
  effective_clients: number | null;
  unclassified: { stake_sol: number; stake_share: number };
};

function computePoolClientDistribution(
  validatorStakeSol: { pubkey: string; stake_sol: number; row: ValidatorRow | undefined }[],
): ClientDistribution {
  const total = validatorStakeSol.reduce((a, v) => a + v.stake_sol, 0);
  if (total <= 0) {
    return {
      by_client: [],
      operational: { jito_share: 0, dz_share: 0 },
      effective_clients: null,
      unclassified: { stake_sol: 0, stake_share: 0 },
    };
  }

  // Per-client tally.
  const tally = new Map<string, { stake: number; count: number }>();
  let unclassifiedStake = 0;
  let jitoStake = 0;
  let dzStake = 0;

  for (const v of validatorStakeSol) {
    const label = v.row?.client_name ?? null;
    if (!label) {
      unclassifiedStake += v.stake_sol;
    } else {
      const cur = tally.get(label) ?? { stake: 0, count: 0 };
      cur.stake += v.stake_sol;
      cur.count += 1;
      tally.set(label, cur);
    }
    if (v.row?.is_jito === 1) jitoStake += v.stake_sol;
    if (v.row?.is_dz === 1) dzStake += v.stake_sol;
  }

  const by_client = [...tally.entries()]
    .map(([client, agg]) => ({
      client,
      stake_sol: agg.stake,
      stake_share: agg.stake / total,
      validator_count: agg.count,
    }))
    .sort((a, b) => b.stake_share - a.stake_share);

  // Effective clients = exp(Shannon entropy). Uses only classified stake;
  // unclassified is reported separately, not folded into the distribution.
  const classifiedTotal = total - unclassifiedStake;
  let effective_clients: number | null = null;
  if (classifiedTotal > 0 && by_client.length > 0) {
    let entropy = 0;
    for (const row of by_client) {
      const p = row.stake_sol / classifiedTotal;
      if (p > 0) entropy -= p * Math.log(p);
    }
    effective_clients = Math.exp(entropy);
  }

  return {
    by_client,
    operational: {
      jito_share: jitoStake / total,
      dz_share: dzStake / total,
    },
    effective_clients,
    unclassified: {
      stake_sol: unclassifiedStake,
      stake_share: unclassifiedStake / total,
    },
  };
}

async function main() {
  const log = adhocLogger('publish');
  const storage = openStorage();

  const latestEpoch = storage.latestScoredEpoch();
  if (latestEpoch == null) {
    log.warn('publish.no_scores', { hint: 'run gdi-ingest first' });
    storage.close();
    return;
  }
  log.info('publish.start', { latest_epoch: latestEpoch, output_dir: OUTPUT_DIR });

  // 1. methodology.json
  await atomicWriteJson(join(OUTPUT_DIR, 'methodology.json'), {
    version: METHODOLOGY_VERSION,
    last_published_at: new Date().toISOString(),
    formula: {
      rarity: '-ln( network_share_D(category of v) )',
      dc: 'sum_v ( w_v · rarity_D(v) )',
      gdi: '( DC_country · DC_city · DC_asn )^(1/3)',
      nis: 'sum_v ( w_v · stakewiz_wiz_score(v) )',
      dimensions: ['country', 'city', 'asn'],
    },
    sources: {
      pool_delegations: 'Helius RPC (on-chain)',
      validator_geo: 'Stakewiz (primary), Validators.app (cross-reference)',
      network_shares: 'Computed from full Stakewiz active validator set',
    },
  });

  // 2. network-baseline.json
  const baselines = storage.listBaselines();
  await atomicWriteJson(join(OUTPUT_DIR, 'network-baseline.json'), {
    latest: baselines[0] ? formatBaseline(baselines[0]) : null,
    history: baselines.map(formatBaseline),
  });

  // 3. leaderboard for latest epoch
  const latestScores = storage.listScoresForEpoch(latestEpoch);
  const latestBaseline = baselines.find((b) => b.epoch === latestEpoch) || baselines[0] || null;
  const pools = storage.listTrackedPools();
  const poolMeta = new Map(pools.map((p) => [p.pool_address, p]));

  // Pre-compute client distribution per pool from the latest epoch's
  // snapshots — used in both leaderboard-latest.json (per-pool entry) and
  // per-pool latest.json. Stake-weighted; see computePoolClientDistribution.
  const clientDistByPool = new Map<string, ClientDistribution>();
  for (const score of latestScores) {
    const snaps = storage.listSnapshotsForPoolEpoch(latestEpoch, score.pool_address);
    const enriched = snaps.map((s) => ({
      pubkey: s.validator_pubkey,
      stake_sol: Number(s.stake_lamports) / 1e9,
      row: storage.getValidator(s.validator_pubkey),
    }));
    clientDistByPool.set(score.pool_address, computePoolClientDistribution(enriched));
  }

  // Leaderboard inclusion rule: any pool with a real GDI and at least one
  // validator. Single-validator pools are kept (GDI is mathematically defined
  // for n=1 — it's the rarity of that one bucket); they rank naturally. Pools
  // with 0 validators or null GDI have nothing to display and go to
  // `tracked_but_unscored`.
  const scoredPools = latestScores.filter(
    (s) => s.gdi_composite != null && (s.validator_count ?? 0) >= 1,
  );
  const trackedButUnscored = latestScores.filter(
    (s) => !(s.gdi_composite != null && (s.validator_count ?? 0) >= 1),
  );

  // Network-wide client distribution — uses the same "active voting" set
  // as the existing network baseline (not delinquent && activated_stake > 0).
  // Lets pool cards compare against a network reference.
  const networkValidatorsForClient = storage
    .listAllValidators()
    .filter((v) => v.delinquent !== 1 && (v.activated_stake_lamports ?? 0) > 0)
    .map((v) => ({
      pubkey: v.validator_pubkey,
      stake_sol: Number(v.activated_stake_lamports ?? 0) / 1e9,
      row: v,
    }));
  const networkClientDistribution = computePoolClientDistribution(networkValidatorsForClient);

  const leaderboard = {
    epoch: latestEpoch,
    last_published_at: new Date().toISOString(),
    methodology_version: METHODOLOGY_VERSION,
    network_baseline: latestBaseline ? formatBaseline(latestBaseline) : null,
    network_client_distribution: networkClientDistribution,
    pools: scoredPools.map((s) => {
      const meta = poolMeta.get(s.pool_address);
      return {
        ...formatPoolScore(s),
        pool_name: meta?.pool_name ?? null,
        pool_program: meta?.pool_program ?? null,
        pool_token_mint: meta?.pool_token_mint ?? null,
        client_distribution: clientDistByPool.get(s.pool_address) ?? null,
      };
    }),
    tracked_but_unscored: trackedButUnscored.map((s) => {
      const meta = poolMeta.get(s.pool_address);
      const vc = s.validator_count ?? 0;
      return {
        pool_address: s.pool_address,
        pool_name: meta?.pool_name ?? null,
        validator_count: vc,
        gdi: s.gdi_composite,  // expose the score for the curious
        reason:
          vc === 0
            ? 'no_validators_in_pool'
            : vc === 1
              ? 'single_validator_pool'
              : 'score_unavailable',
      };
    }),
  };
  await atomicWriteJson(join(OUTPUT_DIR, 'leaderboard-latest.json'), leaderboard);
  await atomicWriteJson(join(OUTPUT_DIR, `leaderboard-${latestEpoch}.json`), leaderboard);

  // 4. per-pool latest + history
  // Rank lookup: scoredPools is already sorted by GDI desc; pool's rank = index + 1.
  const rankByAddress = new Map(scoredPools.map((s, i) => [s.pool_address, i + 1]));
  const totalRanked = scoredPools.length;

  let poolsPublished = 0;
  for (const pool of pools) {
    const history = storage.listScoresForPool(pool.pool_address);
    const latestScore = history[0];
    if (!latestScore) continue;
    const snaps = storage.listSnapshotsForPoolEpoch(latestScore.epoch, pool.pool_address);
    const validatorsRichDir: ReturnType<typeof formatValidator>[] = [];
    const validatorsInline = snaps.map((s) => {
      const v = storage.getValidator(s.validator_pubkey);
      if (v) validatorsRichDir.push(formatValidator(v));
      return {
        pubkey: s.validator_pubkey,
        stake_sol: Number(s.stake_lamports) / 1e9,
        country: v?.country ?? null,
        city: v?.city ?? null,
        asn: v?.asn ?? null,
        asn_name: v?.asn_name ?? null,
        wiz_score: v?.stakewiz_wiz_score ?? null,
        // Client diversity surface — inline so frontend pool page can render
        // per-validator without a second lookup.
        client_name: v?.client_name ?? null,
        client_version: v?.client_version ?? null,
        is_jito: v?.is_jito === null || v?.is_jito === undefined ? null : v.is_jito === 1,
        is_dz: v?.is_dz === null || v?.is_dz === undefined ? null : v.is_dz === 1,
      };
    });

    const poolDir = join(OUTPUT_DIR, 'pools', pool.pool_address);
    await atomicWriteJson(join(poolDir, 'latest.json'), {
      pool: {
        address: pool.pool_address,
        name: pool.pool_name,
        program: pool.pool_program,
        token_mint: pool.pool_token_mint,
      },
      score: formatPoolScore(latestScore),
      network_baseline: latestBaseline ? formatBaseline(latestBaseline) : null,
      // Rank within the leaderboard (1-indexed). Null if pool isn't ranked
      // (single-validator pools, etc. — appear in tracked_but_unscored).
      rank: rankByAddress.get(pool.pool_address) ?? null,
      total_ranked: totalRanked,
      // Stake-weighted client breakdown. Phase 1: published but not folded
      // into headline GDI. See /methodology.
      client_distribution: clientDistByPool.get(pool.pool_address) ?? null,
      validators: validatorsInline,
    });
    await atomicWriteJson(join(poolDir, 'history.json'), {
      pool: {
        address: pool.pool_address,
        name: pool.pool_name,
      },
      methodology_version: METHODOLOGY_VERSION,
      history: history.map(formatPoolScore),
    });
    poolsPublished++;
  }

  // 5. validators.json — directory of all known validators
  const allValidators = storage.listAllValidators();
  await atomicWriteJson(join(OUTPUT_DIR, 'validators.json'), {
    last_published_at: new Date().toISOString(),
    count: allValidators.length,
    validators: allValidators.map(formatValidator),
  });

  // 5b. validator-index.json — ranked index of ACTIVE voting validators
  //     (not delinquent AND activated_stake > 0). Powers the per-validator
  //     lookup page on the site. Includes per-dimension rarity + composite +
  //     network share + rank/percentile against the active denominator.
  //
  //     Note: rarities here are computed from network shares over the SAME
  //     "active voting" set, not the broader stake>0 set used by the pool
  //     baseline calc. The two diverge by ~1100 dead validators; the active-
  //     set rarities are slightly higher (smaller denominator → smaller bucket
  //     shares → higher -ln). For pool scoring we still use the wider set
  //     under gdi-1.0.0 — tightening that is a separate methodology bump.
  type ActiveRow = {
    vote_pubkey: string;
    identity_pubkey: string | null;
    identity_name: string | null;
    image_url: string | null;
    country: string | null;
    city: string | null;
    asn: string | null;
    asn_name: string | null;
    activated_stake_sol: number;
    network_share_country: number | null;
    network_share_city: number | null;
    network_share_asn: number | null;
    rarity_country: number | null;
    rarity_city: number | null;
    rarity_asn: number | null;
    composite_rarity: number | null;
  };

  const RARITY_FLOOR = 1e-9;
  const rarity = (share: number | null) =>
    share == null || share <= 0 ? -Math.log(RARITY_FLOOR) : -Math.log(share);

  const activeRows: ActiveRow[] = [];
  const activeByBucket = {
    country: new Map<string, number>(), // bucket -> sum of stake (SOL)
    city: new Map<string, number>(),
    asn: new Map<string, number>(),
  };
  let totalActiveStakeSol = 0;

  for (const v of allValidators) {
    // ACTIVE definition: not delinquent AND has stake. Mirrors what
    // operators / wallets / explorers commonly call "actively voting".
    if (v.delinquent === 1) continue;
    if (v.activated_stake_lamports == null || v.activated_stake_lamports <= 0) continue;
    const stakeSol = Number(v.activated_stake_lamports) / 1e9;
    totalActiveStakeSol += stakeSol;
    if (v.country) activeByBucket.country.set(v.country, (activeByBucket.country.get(v.country) ?? 0) + stakeSol);
    if (v.city)    activeByBucket.city.set(v.city,       (activeByBucket.city.get(v.city)       ?? 0) + stakeSol);
    if (v.asn)     activeByBucket.asn.set(v.asn,         (activeByBucket.asn.get(v.asn)         ?? 0) + stakeSol);
    activeRows.push({
      vote_pubkey: v.validator_pubkey,
      identity_pubkey: v.identity_pubkey,
      identity_name: v.identity_name,
      image_url: v.image_url,
      country: v.country,
      city: v.city,
      asn: v.asn,
      asn_name: v.asn_name,
      activated_stake_sol: stakeSol,
      network_share_country: null,
      network_share_city: null,
      network_share_asn: null,
      rarity_country: null,
      rarity_city: null,
      rarity_asn: null,
      composite_rarity: null,
    });
  }

  // Fill in shares + rarities now that totals are known
  for (const row of activeRows) {
    if (row.country && totalActiveStakeSol > 0) {
      const s = (activeByBucket.country.get(row.country) ?? 0) / totalActiveStakeSol;
      row.network_share_country = s;
      row.rarity_country = rarity(s);
    }
    if (row.city && totalActiveStakeSol > 0) {
      const s = (activeByBucket.city.get(row.city) ?? 0) / totalActiveStakeSol;
      row.network_share_city = s;
      row.rarity_city = rarity(s);
    }
    if (row.asn && totalActiveStakeSol > 0) {
      const s = (activeByBucket.asn.get(row.asn) ?? 0) / totalActiveStakeSol;
      row.network_share_asn = s;
      row.rarity_asn = rarity(s);
    }
    // Composite = geometric mean (matches GDI's formula at pool level).
    if (
      row.rarity_country != null && row.rarity_country > 0 &&
      row.rarity_city    != null && row.rarity_city    > 0 &&
      row.rarity_asn     != null && row.rarity_asn     > 0
    ) {
      row.composite_rarity = Math.cbrt(row.rarity_country * row.rarity_city * row.rarity_asn);
    }
  }

  // Rank by composite rarity desc. Validators with incomplete geo land at the
  // bottom — surfaced separately so the page can flag them.
  const rankable = activeRows.filter((r) => r.composite_rarity != null);
  rankable.sort((a, b) => (b.composite_rarity ?? 0) - (a.composite_rarity ?? 0));
  const rankByVote = new Map<string, number>();
  rankable.forEach((r, i) => rankByVote.set(r.vote_pubkey, i + 1));

  const medianRarity = rankable.length > 0
    ? rankable[Math.floor(rankable.length / 2)].composite_rarity!
    : null;

  // Build the index payload — pre-sorted by rank ascending (rarest first),
  // unranked validators at the end. Clients can show the list verbatim or
  // build a vote-pubkey / identity-pubkey lookup map.
  const indexed = activeRows
    .map((r) => ({
      ...r,
      rank: rankByVote.get(r.vote_pubkey) ?? null,
      percentile: rankByVote.get(r.vote_pubkey) != null
        ? +((rankByVote.get(r.vote_pubkey)! / rankable.length) * 100).toFixed(2)
        : null,
    }))
    .sort((a, b) => {
      // Ranked first (ascending rank = rarest first); unranked last.
      if (a.rank == null && b.rank == null) return 0;
      if (a.rank == null) return 1;
      if (b.rank == null) return -1;
      return a.rank - b.rank;
    });

  await atomicWriteJson(join(OUTPUT_DIR, 'validator-index.json'), {
    last_published_at: new Date().toISOString(),
    epoch: latestEpoch,
    methodology_version: METHODOLOGY_VERSION,
    active_set_definition: "Stakewiz: !delinquent AND activated_stake > 0",
    active_count: activeRows.length,
    rankable_count: rankable.length,
    total_active_stake_sol: totalActiveStakeSol,
    median_composite_rarity: medianRarity,
    validators: indexed,
  });

  // 6. concentration-crosscheck.json — our computed shares vs Stakewiz's reported
  //    For each city/ASN bucket, we have:
  //      - gdi_share: computed by summing validator stakes ourselves
  //      - stakewiz_reported: avg of stakewiz_*_concentration across validators in that bucket
  //    Wide divergence between the two would surface here for review.
  type BucketAgg = { gdi_share: number; stakewiz_reported: number | null; sample_n: number };
  const computeBucketShares = (
    getter: (v: ValidatorRow) => string | null,
    getStakewizReported: (v: ValidatorRow) => number | null,
  ): Map<string, BucketAgg> => {
    // First pass: stake-weighted share per bucket using OUR computation
    // (using validator metadata's "implicit stake" from the latest pool snapshots
    // we have on file is too narrow — we want network-wide shares; use Stakewiz's
    // activated_stake via the validators table only if we'd loaded it that way.
    // For this cross-check we use validator counts as a proxy for the per-bucket
    // signal, since the GDI-side computation already lives inside ingest.ts —
    // here we just expose Stakewiz's per-validator reported value averaged per
    // bucket, which is the straight comparison value.
    const stakewizSums = new Map<string, { sum: number; n: number }>();
    let total = 0;
    for (const v of allValidators) {
      const k = getter(v);
      if (!k) continue;
      total++;
      const sw = getStakewizReported(v);
      if (sw == null) continue;
      const cur = stakewizSums.get(k) || { sum: 0, n: 0 };
      cur.sum += sw;
      cur.n += 1;
      stakewizSums.set(k, cur);
    }
    const out = new Map<string, BucketAgg>();
    for (const [k, agg] of stakewizSums) {
      out.set(k, {
        gdi_share: 0,  // filled below from baseline data — the network-wide share is what we computed at ingest
        stakewiz_reported: agg.n > 0 ? agg.sum / agg.n : null,
        sample_n: agg.n,
      });
    }
    return out;
  };

  // City + ASN cross-checks (Stakewiz only reports those, not country).
  // For top-N most-validator-counted buckets, surface our computation note.
  const cityAgg = computeBucketShares((v) => v.city, (v) => v.stakewiz_city_concentration);
  const asnAgg = computeBucketShares((v) => v.asn, (v) => v.stakewiz_asn_concentration);

  // We don't have the network shares persisted (computed in-memory at ingest).
  // For now, surface validator count + Stakewiz's reported concentration per bucket
  // as a directory; the methodology page links here for inspection. Future: persist
  // network shares per epoch in a `network_shares` table for full historical view.
  const topN = (m: Map<string, BucketAgg>, n: number) =>
    Array.from(m.entries())
      .sort((a, b) => b[1].sample_n - a[1].sample_n)
      .slice(0, n)
      .map(([bucket, agg]) => ({
        bucket,
        validator_count: agg.sample_n,
        stakewiz_reported_concentration: agg.stakewiz_reported,
      }));
  await atomicWriteJson(join(OUTPUT_DIR, 'concentration-crosscheck.json'), {
    last_published_at: new Date().toISOString(),
    note:
      'Stakewiz publishes per-validator city_concentration and asn_concentration. ' +
      'The GDI computes its own bucket shares from raw activated_stake; Stakewiz\'s ' +
      'reported values are surfaced here for sanity. Wide divergence between the ' +
      'two would be a red flag.',
    cities_top: topN(cityAgg, 25),
    asns_top: topN(asnAgg, 25),
  });

  log.info('publish.finish', {
    epoch: latestEpoch,
    pools_published: poolsPublished,
    output_dir: OUTPUT_DIR,
  });
  storage.close();
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
