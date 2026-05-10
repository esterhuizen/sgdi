// PURE SCORING MODULE — zero I/O.
//
// This is the soul of SGDI. It must remain side-effect-free, deterministic,
// and unit-testable without mocks. Every input is a value, every output is a
// value. If you ever feel like adding a `fetch` or `readFile` here, the
// design has failed — refactor instead.
//
// Spec §3:
//   eN_D  = exp( -Σ pᵢ · ln(pᵢ) )       per dimension D ∈ {country, city, ASN}
//   GDI   = ( eN_country · eN_city · eN_ASN )^(1/3)   geometric mean
//   NIS   = Σ wᵥ · stakewiz_wiz_score(v)              network impact

export const METHODOLOGY_VERSION = 'sgdi-1.0.0';

/** Bucket key for an unknown / missing-metadata value. */
export const UNKNOWN_BUCKET = 'Unknown';

// ───────────────────────────────────────────────────────────────────────────
// Inputs
// ───────────────────────────────────────────────────────────────────────────

/** Per-validator location + score metadata as enriched from data sources. */
export type ValidatorMetadata = {
  pubkey: string;
  country: string | null;
  city: string | null;
  asn: string | null;
  /** Stakewiz wiz_score, 0-100. Null if Stakewiz didn't return a score for this validator. */
  wizScore: number | null;
};

/**
 * Per-validator stake within a single pool, in lamports.
 * Validators with zero stake should not be included; they shouldn't influence the score.
 */
export type PoolStakeRow = {
  pubkey: string;
  stakeLamports: bigint;
};

export type DimensionScores = {
  eN_country: number;
  eN_city: number;
  eN_asn: number;
};

export type PoolScoreResult = DimensionScores & {
  gdi: number;
  /**
   * Stake-weighted Stakewiz wiz_score, scaled 0-100 (since wiz_score is 0-100).
   * NaN if no validator in the pool has a wiz_score (no score available).
   */
  nis: number;
  validatorCount: number;
  totalStakeLamports: bigint;
};

// ───────────────────────────────────────────────────────────────────────────
// Pure helpers
// ───────────────────────────────────────────────────────────────────────────

/**
 * Bucket-sum: returns Map(bucket → sum-of-stake).
 * `getBucket` chooses the bucket per row. Null/empty bucket values fall to
 * UNKNOWN_BUCKET so they're still counted (excluding them would inflate eN
 * by silently dropping stake from the denominator).
 */
export function bucketStake<T extends PoolStakeRow>(
  rows: readonly T[],
  meta: ReadonlyMap<string, ValidatorMetadata>,
  getBucket: (m: ValidatorMetadata | undefined) => string | null,
): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  for (const r of rows) {
    const m = meta.get(r.pubkey);
    const raw = getBucket(m);
    const bucket = raw && raw.trim() !== '' ? raw : UNKNOWN_BUCKET;
    totals.set(bucket, (totals.get(bucket) || 0n) + r.stakeLamports);
  }
  return totals;
}

/**
 * Stake-weighted Shannon entropy, in nats (natural log).
 * Returns 0 for empty input or single-bucket input. Convention: 0·ln(0) = 0.
 */
export function shannonEntropyNats(weights: ReadonlyMap<string, bigint>): number {
  let total = 0n;
  for (const w of weights.values()) total += w;
  if (total === 0n) return 0;

  const totalNum = Number(total);
  let h = 0;
  for (const w of weights.values()) {
    if (w === 0n) continue;
    const p = Number(w) / totalNum;
    h -= p * Math.log(p);
  }
  return h;
}

/**
 * Effective number of categories: exp(H).
 * eN = 1 means perfectly concentrated; eN = N means perfectly even across N buckets.
 */
export function effectiveNumber(weights: ReadonlyMap<string, bigint>): number {
  // Empty-or-zero special case: convention "no data → eN = 0" (callers must
  // decide whether to drop or to include in geometric mean).
  let total = 0n;
  for (const w of weights.values()) total += w;
  if (total === 0n) return 0;

  return Math.exp(shannonEntropyNats(weights));
}

/**
 * Geometric mean of three positive values.
 * If any value is 0 or negative, returns 0 (a pool with no diversity on any
 * one dimension is meaningfully bad on the composite).
 */
export function geometricMean3(a: number, b: number, c: number): number {
  if (a <= 0 || b <= 0 || c <= 0) return 0;
  return Math.cbrt(a * b * c);
}

/**
 * Stake-weighted Stakewiz wiz_score for a pool.
 *
 * Returns NaN if no validator in the pool has a non-null wizScore (signal:
 * "we don't have enough data to compute NIS for this pool"). Validators with
 * a missing wizScore are excluded from the average — but their stake is also
 * excluded from the denominator, so the result is the weighted average among
 * scored validators only. The caller should display NaN as "—" rather than 0.
 */
export function networkImpactScore(
  rows: readonly PoolStakeRow[],
  meta: ReadonlyMap<string, ValidatorMetadata>,
): number {
  let weightedSum = 0;
  let totalScored = 0n;
  for (const r of rows) {
    const m = meta.get(r.pubkey);
    if (m?.wizScore == null) continue;
    weightedSum += Number(r.stakeLamports) * m.wizScore;
    totalScored += r.stakeLamports;
  }
  if (totalScored === 0n) return Number.NaN;
  return weightedSum / Number(totalScored);
}

// ───────────────────────────────────────────────────────────────────────────
// Composite
// ───────────────────────────────────────────────────────────────────────────

/**
 * Compute all scores for one pool from its snapshots + enriched validator
 * metadata. Pure: same inputs → same outputs, no I/O, no clock.
 */
export function computePoolScores(
  rows: readonly PoolStakeRow[],
  meta: ReadonlyMap<string, ValidatorMetadata>,
): PoolScoreResult {
  let total = 0n;
  for (const r of rows) total += r.stakeLamports;

  const eN_country = effectiveNumber(bucketStake(rows, meta, (m) => m?.country ?? null));
  const eN_city    = effectiveNumber(bucketStake(rows, meta, (m) => m?.city    ?? null));
  const eN_asn     = effectiveNumber(bucketStake(rows, meta, (m) => m?.asn     ?? null));

  return {
    eN_country,
    eN_city,
    eN_asn,
    gdi: geometricMean3(eN_country, eN_city, eN_asn),
    nis: networkImpactScore(rows, meta),
    validatorCount: rows.length,
    totalStakeLamports: total,
  };
}

/**
 * Network-baseline GDI: same formula applied to the entire active validator
 * set, stake-weighted. Each row is one validator with its TOTAL active stake
 * (not pool-scoped).
 */
export function computeNetworkBaseline(
  rows: readonly PoolStakeRow[],
  meta: ReadonlyMap<string, ValidatorMetadata>,
): DimensionScores & { gdi: number; validatorCount: number; totalStakeLamports: bigint } {
  let total = 0n;
  for (const r of rows) total += r.stakeLamports;

  const eN_country = effectiveNumber(bucketStake(rows, meta, (m) => m?.country ?? null));
  const eN_city    = effectiveNumber(bucketStake(rows, meta, (m) => m?.city    ?? null));
  const eN_asn     = effectiveNumber(bucketStake(rows, meta, (m) => m?.asn     ?? null));

  return {
    eN_country,
    eN_city,
    eN_asn,
    gdi: geometricMean3(eN_country, eN_city, eN_asn),
    validatorCount: rows.length,
    totalStakeLamports: total,
  };
}

/**
 * Rolling mean over the last N values of a per-epoch series.
 * Returns NaN if the input has fewer than 1 value.
 */
export function rollingMean(values: readonly number[], window: number): number {
  if (values.length === 0) return Number.NaN;
  const slice = values.slice(-window);
  let sum = 0;
  for (const v of slice) sum += v;
  return sum / slice.length;
}
