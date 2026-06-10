// PURE SCORING MODULE — zero I/O.
//
// This is the soul of SGDI. It must remain side-effect-free, deterministic,
// and unit-testable without mocks. Stays pure or the design has failed.
//
// Methodology (gdi-1.1.1):
//
// Version history:
//   gdi-1.0.0  Initial. Network shares computed over { activated_stake > 0 } —
//              about 1929 validators including delinquent and dust nodes.
//   gdi-1.1.0  Tightened "the network" to actively-voting validators only:
//              { !delinquent AND activated_stake > 0 } — about 760 validators,
//              matching Solana's getVoteAccounts.current convention used by
//              Stakewiz, Solana Beach, etc. Inactive/delinquent nodes still
//              hold stake but don't vote and shouldn't count as part of the
//              network's stake-weighted denominator. Existing pool_scores
//              under gdi-1.0.0 remain unchanged; new ingest writes 1.1.0.
//   gdi-1.1.1  Pool members whose bucket is ABSENT from the network-share
//              denominator (e.g. a delinquent validator: excluded from the
//              active set, so its country/city/ASN may have zero share) are
//              now treated as NON-PLACEABLE — excluded from DC and reflected
//              in placementCoverage — instead of receiving the defensive
//              -ln(1e-9) ≈ 20.7 floor rarity. Exposed 2026-06-10: a transient
//              Stakewiz delinquency flag on a 13.4M-SOL validator emptied its
//              ASN bucket and inflated its pools' GDI by up to +106% for one
//              30-minute publish cycle. Delinquent stake contributes nothing
//              to network decentralisation; it must not raise a pool's score.
//
//
//   For each validator v in a pool with stake fraction wᵥ:
//     rarity_D(v) = -ln( network_share_D(category of v) )    D ∈ {country, city, ASN}
//
//   Pool's Decentralisation Contribution per dimension:
//     DC_D = Σᵥ wᵥ · rarity_D(v)            stake-weighted average rarity
//
//   Composite GDI:
//     GDI = ( DC_country · DC_city · DC_asn )^(1/3)    geometric mean
//
//   Network baseline = the same DC formula applied to the entire active
//   validator set with stake-weighted averaging. A pool above its
//   environment's baseline is preferentially delegating to less-popular
//   geographic / network positions — directly contributing to network
//   decentralisation.

export const METHODOLOGY_VERSION = 'gdi-1.1.1';

/**
 * Lower-bound on a category's network share when computing rarity. Prevents
 * -ln(0) when a validator's category isn't represented in network shares
 * (shouldn't happen, but defensive). At max-rarity = -ln(1e-9) ≈ 20.7.
 */
const RARITY_SHARE_FLOOR = 1e-9;

// ───────────────────────────────────────────────────────────────────────────
// Inputs
// ───────────────────────────────────────────────────────────────────────────

/** Per-validator location + score metadata as enriched from data sources. */
export type ValidatorMetadata = {
  pubkey: string;
  country: string | null;
  city: string | null;
  asn: string | null;
  /** Stakewiz wiz_score, 0-100. Null if Stakewiz didn't return a score. */
  wizScore: number | null;
};

/**
 * Per-validator stake within a single pool, in lamports.
 * Validators with zero stake should not be included.
 */
export type PoolStakeRow = {
  pubkey: string;
  stakeLamports: bigint;
};

/**
 * Per-dimension network shares: bucket name → fraction of network stake (0-1).
 * Computed from the entire active validator set (typically via Stakewiz's
 * activated_stake field). Used as the rarity reference.
 */
export type NetworkShares = {
  country: ReadonlyMap<string, number>;
  city: ReadonlyMap<string, number>;
  asn: ReadonlyMap<string, number>;
};

export type DimensionScores = {
  dc_country: number;
  dc_city: number;
  dc_asn: number;
};

export type PoolScoreResult = DimensionScores & {
  gdi: number;
  /**
   * Stake-weighted Stakewiz wiz_score among scored validators.
   * NaN if no validator in the pool has a wiz_score.
   */
  nis: number;
  validatorCount: number;
  totalStakeLamports: bigint;
  /**
   * Fraction of pool stake (0-1) that we could place geographically across
   * all three dimensions. < 1 means some validators had missing metadata
   * (their stake was excluded from the DC computation). Display alongside
   * the score so operators see data quality.
   */
  placementCoverage: number;
};

export type NetworkBaselineResult = DimensionScores & {
  gdi: number;
  validatorCount: number;
  totalStakeLamports: bigint;
};

// ───────────────────────────────────────────────────────────────────────────
// Network shares
// ───────────────────────────────────────────────────────────────────────────

/**
 * Compute per-bucket stake share over a full set of (validator, stake)
 * pairs and a bucket-getter. Validators with null bucket values are
 * EXCLUDED from both numerator and denominator — the result represents
 * "share of placeable stake," which is the right base for rarity comparisons.
 */
export function computeShares(
  rows: readonly PoolStakeRow[],
  meta: ReadonlyMap<string, ValidatorMetadata>,
  getBucket: (m: ValidatorMetadata | undefined) => string | null,
): Map<string, number> {
  const totals = new Map<string, bigint>();
  let placeableTotal = 0n;
  for (const r of rows) {
    const bucket = getBucket(meta.get(r.pubkey));
    if (bucket == null || bucket.trim() === '') continue;
    totals.set(bucket, (totals.get(bucket) || 0n) + r.stakeLamports);
    placeableTotal += r.stakeLamports;
  }
  const shares = new Map<string, number>();
  if (placeableTotal === 0n) return shares;
  const total = Number(placeableTotal);
  for (const [k, v] of totals) shares.set(k, Number(v) / total);
  return shares;
}

/** Convenience: build all three dimension shares at once. */
export function computeNetworkShares(
  rows: readonly PoolStakeRow[],
  meta: ReadonlyMap<string, ValidatorMetadata>,
): NetworkShares {
  return {
    country: computeShares(rows, meta, (m) => m?.country ?? null),
    city:    computeShares(rows, meta, (m) => m?.city    ?? null),
    asn:     computeShares(rows, meta, (m) => m?.asn     ?? null),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Rarity + Decentralisation Contribution
// ───────────────────────────────────────────────────────────────────────────

/**
 * Rarity of a category given its network share, in nats.
 * - share = 0.5 (popular) → rarity ≈ 0.693
 * - share = 0.01 (rare)   → rarity ≈ 4.6
 * - share = 0             → clamped to RARITY_SHARE_FLOOR ≈ 20.7
 */
export function rarityFromShare(share: number): number {
  const s = share > 0 ? share : RARITY_SHARE_FLOOR;
  return -Math.log(s);
}

/**
 * Pool's Decentralisation Contribution on a single dimension:
 *   DC = Σᵥ (wᵥ · rarity(v))   over validators with placeable bucket
 *
 * Weights are normalised over PLACEABLE stake (validators with non-null
 * bucket values), not total pool stake — so a pool with 50% unknown-city
 * stake gets a DC computed from the 50% we can place, not artificially
 * deflated by the unknowns. The caller separately reports placementCoverage
 * so operators see the data-quality proviso.
 *
 * Returns NaN if no validator has a placeable bucket value (signal: no data).
 */
export function decentralisationContribution(
  rows: readonly PoolStakeRow[],
  meta: ReadonlyMap<string, ValidatorMetadata>,
  shares: ReadonlyMap<string, number>,
  getBucket: (m: ValidatorMetadata | undefined) => string | null,
): number {
  // A bucket that is absent from the shares map is not part of the network
  // denominator (typically: the only validators in it are delinquent, so it
  // holds zero active stake). Validators in such buckets are NON-PLACEABLE —
  // skipped from numerator and denominator, like null-geo validators — rather
  // than scored at the -ln(1e-9) floor. (gdi-1.1.1; see version history.)
  let placeableTotal = 0n;
  let weighted = 0;
  for (const r of rows) {
    const bucket = getBucket(meta.get(r.pubkey));
    if (bucket == null || bucket.trim() === '') continue;
    if (!shares.has(bucket)) continue;
    placeableTotal += r.stakeLamports;
  }
  if (placeableTotal === 0n) return Number.NaN;
  const totalNum = Number(placeableTotal);
  for (const r of rows) {
    const bucket = getBucket(meta.get(r.pubkey));
    if (bucket == null || bucket.trim() === '') continue;
    const share = shares.get(bucket);
    if (share == null) continue;
    const w = Number(r.stakeLamports) / totalNum;
    weighted += w * rarityFromShare(share);
  }
  return weighted;
}

/**
 * Geometric mean of three positive values. Any non-positive (NaN, ≤ 0) → NaN
 * (signal: this dimension had no data or pathological input).
 */
export function geometricMean3(a: number, b: number, c: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) return Number.NaN;
  if (a <= 0 || b <= 0 || c <= 0) return Number.NaN;
  return Math.cbrt(a * b * c);
}

// ───────────────────────────────────────────────────────────────────────────
// Network Impact Score (unchanged from earlier draft)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Stake-weighted Stakewiz wiz_score for a pool. Validators without a
 * wizScore are excluded from numerator AND denominator (returns the
 * weighted average among scored validators). Result is 0-100 (since
 * wiz_score is 0-100). NaN if no validator in the pool has a wizScore.
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
// Composite (the public scoring entry points)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Compute all scores for one pool. Pure: same inputs → same outputs.
 *
 * `shares` is the network-wide stake-share map per dimension — typically
 * computed once per ingest from the full Stakewiz validator set, then
 * reused for every pool's score.
 */
export function computePoolScores(
  rows: readonly PoolStakeRow[],
  meta: ReadonlyMap<string, ValidatorMetadata>,
  shares: NetworkShares,
): PoolScoreResult {
  let total = 0n;
  let placeable = 0n;
  for (const r of rows) {
    total += r.stakeLamports;
    const m = meta.get(r.pubkey);
    // Placeable = geo known on all three dimensions AND every bucket present
    // in the network denominator. A delinquent-only bucket fails the second
    // condition, so the validator shows up as a coverage gap, not a score.
    if (
      m?.country != null && m.country.trim() !== '' && shares.country.has(m.country) &&
      m.city    != null && m.city.trim()    !== '' && shares.city.has(m.city) &&
      m.asn     != null && m.asn.trim()     !== '' && shares.asn.has(m.asn)
    ) {
      placeable += r.stakeLamports;
    }
  }

  const dc_country = decentralisationContribution(rows, meta, shares.country, (m) => m?.country ?? null);
  const dc_city    = decentralisationContribution(rows, meta, shares.city,    (m) => m?.city    ?? null);
  const dc_asn     = decentralisationContribution(rows, meta, shares.asn,     (m) => m?.asn     ?? null);

  return {
    dc_country,
    dc_city,
    dc_asn,
    gdi: geometricMean3(dc_country, dc_city, dc_asn),
    nis: networkImpactScore(rows, meta),
    validatorCount: rows.length,
    totalStakeLamports: total,
    placementCoverage: total === 0n ? 0 : Number(placeable) / Number(total),
  };
}

/**
 * Network-baseline GDI: same formula applied to the entire active validator
 * set, stake-weighted. The baseline is by construction the network's own
 * stake-weighted average rarity per dimension — pools with DC > baseline are
 * delegating to less-popular-than-average places.
 */
export function computeNetworkBaseline(
  rows: readonly PoolStakeRow[],
  meta: ReadonlyMap<string, ValidatorMetadata>,
  shares: NetworkShares,
): NetworkBaselineResult {
  let total = 0n;
  for (const r of rows) total += r.stakeLamports;

  const dc_country = decentralisationContribution(rows, meta, shares.country, (m) => m?.country ?? null);
  const dc_city    = decentralisationContribution(rows, meta, shares.city,    (m) => m?.city    ?? null);
  const dc_asn     = decentralisationContribution(rows, meta, shares.asn,     (m) => m?.asn     ?? null);

  return {
    dc_country,
    dc_city,
    dc_asn,
    gdi: geometricMean3(dc_country, dc_city, dc_asn),
    validatorCount: rows.length,
    totalStakeLamports: total,
  };
}

/**
 * Rolling mean over the last N values. NaN if input is empty.
 */
export function rollingMean(values: readonly number[], window: number): number {
  if (values.length === 0) return Number.NaN;
  const slice = values.slice(-window);
  let sum = 0;
  for (const v of slice) sum += v;
  return sum / slice.length;
}
