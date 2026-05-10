// Pure-function unit tests for src/lib/gdi/scoring.ts.
//
// Run via: npm test  (Node's built-in test runner — no jest/vitest dependency)
//
// Coverage strategy: pin every formula to a worked example. If any number
// here changes, that's a methodology bump (PATCH or higher per CONTRIBUTING.md).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  shannonEntropyNats,
  effectiveNumber,
  bucketStake,
  geometricMean3,
  networkImpactScore,
  computePoolScores,
  rollingMean,
  UNKNOWN_BUCKET,
  type ValidatorMetadata,
  type PoolStakeRow,
} from '../src/lib/gdi/scoring.ts';

// Tolerance for floating-point comparisons.
const EPS = 1e-9;
function near(actual: number, expected: number, eps = EPS) {
  assert.ok(
    Math.abs(actual - expected) < eps,
    `expected ${actual} ≈ ${expected} (within ${eps})`,
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Shannon entropy
// ───────────────────────────────────────────────────────────────────────────

test('shannonEntropyNats: empty input → 0', () => {
  assert.equal(shannonEntropyNats(new Map()), 0);
});

test('shannonEntropyNats: single bucket → 0 (perfectly concentrated)', () => {
  const m = new Map([['US', 100n]]);
  assert.equal(shannonEntropyNats(m), 0);
});

test('shannonEntropyNats: two buckets evenly split → ln(2)', () => {
  const m = new Map([['US', 50n], ['DE', 50n]]);
  near(shannonEntropyNats(m), Math.log(2));
});

test('shannonEntropyNats: N buckets evenly split → ln(N)', () => {
  for (const n of [3, 5, 10, 25]) {
    const m = new Map<string, bigint>();
    for (let i = 0; i < n; i++) m.set(`b${i}`, 10n);
    near(shannonEntropyNats(m), Math.log(n), 1e-12);
  }
});

test('shannonEntropyNats: skewed two-bucket (90/10)', () => {
  // H = -(0.9 ln 0.9 + 0.1 ln 0.1)
  const m = new Map([['A', 90n], ['B', 10n]]);
  const expected = -(0.9 * Math.log(0.9) + 0.1 * Math.log(0.1));
  near(shannonEntropyNats(m), expected, 1e-12);
});

test('shannonEntropyNats: zero-weight bucket is ignored', () => {
  const m = new Map([['US', 50n], ['DE', 50n], ['empty', 0n]]);
  near(shannonEntropyNats(m), Math.log(2));
});

// ───────────────────────────────────────────────────────────────────────────
// effectiveNumber
// ───────────────────────────────────────────────────────────────────────────

test('effectiveNumber: empty → 0 (sentinel for "no data")', () => {
  assert.equal(effectiveNumber(new Map()), 0);
});

test('effectiveNumber: single bucket → 1 (exp(0))', () => {
  const m = new Map([['US', 100n]]);
  near(effectiveNumber(m), 1);
});

test('effectiveNumber: 5 buckets evenly split → 5', () => {
  const m = new Map<string, bigint>([
    ['US', 20n], ['DE', 20n], ['SG', 20n], ['JP', 20n], ['BR', 20n],
  ]);
  near(effectiveNumber(m), 5);
});

test('effectiveNumber: 10 buckets evenly split → 10', () => {
  const m = new Map<string, bigint>();
  for (let i = 0; i < 10; i++) m.set(`b${i}`, 1n);
  near(effectiveNumber(m), 10, 1e-9);
});

test('effectiveNumber: heavily skewed → close to 1', () => {
  const m = new Map([['A', 99n], ['B', 1n]]);
  // H = -0.99 ln 0.99 - 0.01 ln 0.01 ≈ 0.0560
  // eN = exp(H) ≈ 1.0577
  near(effectiveNumber(m), Math.exp(-0.99 * Math.log(0.99) - 0.01 * Math.log(0.01)), 1e-9);
});

// ───────────────────────────────────────────────────────────────────────────
// bucketStake
// ───────────────────────────────────────────────────────────────────────────

test('bucketStake: nulls fall into UNKNOWN_BUCKET', () => {
  const rows: PoolStakeRow[] = [
    { pubkey: 'a', stakeLamports: 10n },
    { pubkey: 'b', stakeLamports: 20n },
    { pubkey: 'c', stakeLamports: 30n },
  ];
  const meta = new Map<string, ValidatorMetadata>([
    ['a', { pubkey: 'a', country: 'US', city: null, asn: null, wizScore: null }],
    ['b', { pubkey: 'b', country: null, city: null, asn: null, wizScore: null }],
    // 'c' has no metadata at all
  ]);
  const buckets = bucketStake(rows, meta, (m) => m?.country ?? null);
  assert.equal(buckets.get('US'), 10n);
  assert.equal(buckets.get(UNKNOWN_BUCKET), 50n);
});

test('bucketStake: stake from same bucket sums', () => {
  const rows: PoolStakeRow[] = [
    { pubkey: 'a', stakeLamports: 100n },
    { pubkey: 'b', stakeLamports: 200n },
    { pubkey: 'c', stakeLamports: 50n },
  ];
  const meta = new Map<string, ValidatorMetadata>([
    ['a', { pubkey: 'a', country: 'US', city: null, asn: null, wizScore: null }],
    ['b', { pubkey: 'b', country: 'US', city: null, asn: null, wizScore: null }],
    ['c', { pubkey: 'c', country: 'DE', city: null, asn: null, wizScore: null }],
  ]);
  const buckets = bucketStake(rows, meta, (m) => m?.country ?? null);
  assert.equal(buckets.get('US'), 300n);
  assert.equal(buckets.get('DE'), 50n);
});

// ───────────────────────────────────────────────────────────────────────────
// geometricMean3
// ───────────────────────────────────────────────────────────────────────────

test('geometricMean3: cube of equal → that value', () => {
  near(geometricMean3(8, 8, 8), 8);
});

test('geometricMean3: 1×8×27 → 6 (cube root of 216)', () => {
  near(geometricMean3(1, 8, 27), 6);
});

test('geometricMean3: any zero → 0 (penalises one-dimension failure)', () => {
  assert.equal(geometricMean3(0, 5, 5), 0);
  assert.equal(geometricMean3(5, 0, 5), 0);
  assert.equal(geometricMean3(5, 5, 0), 0);
});

test('geometricMean3: penalises imbalance vs arithmetic mean', () => {
  // Arithmetic mean of (1, 1, 27) is ~9.67; geometric mean is 3.
  // The geometric mean correctly penalises being good on one dim, terrible on others.
  const am = (1 + 1 + 27) / 3;
  const gm = geometricMean3(1, 1, 27);
  assert.ok(gm < am, `expected gm (${gm}) < am (${am})`);
  near(gm, 3, 1e-9);
});

// ───────────────────────────────────────────────────────────────────────────
// networkImpactScore
// ───────────────────────────────────────────────────────────────────────────

test('networkImpactScore: equal stake, equal scores → that score', () => {
  const rows: PoolStakeRow[] = [
    { pubkey: 'a', stakeLamports: 100n },
    { pubkey: 'b', stakeLamports: 100n },
  ];
  const meta = new Map<string, ValidatorMetadata>([
    ['a', { pubkey: 'a', country: null, city: null, asn: null, wizScore: 80 }],
    ['b', { pubkey: 'b', country: null, city: null, asn: null, wizScore: 80 }],
  ]);
  near(networkImpactScore(rows, meta), 80);
});

test('networkImpactScore: stake-weighted', () => {
  // 90% of stake at score 100, 10% at score 0 → weighted avg = 90.
  const rows: PoolStakeRow[] = [
    { pubkey: 'a', stakeLamports: 90n },
    { pubkey: 'b', stakeLamports: 10n },
  ];
  const meta = new Map<string, ValidatorMetadata>([
    ['a', { pubkey: 'a', country: null, city: null, asn: null, wizScore: 100 }],
    ['b', { pubkey: 'b', country: null, city: null, asn: null, wizScore: 0 }],
  ]);
  near(networkImpactScore(rows, meta), 90);
});

test('networkImpactScore: validators with null wizScore are excluded from both numerator and denominator', () => {
  // 100 stake at score 80, 100 stake with no score → result is 80 (only scored
  // validator influences it). Caller can interpret "what fraction was scored?"
  // separately if they care.
  const rows: PoolStakeRow[] = [
    { pubkey: 'a', stakeLamports: 100n },
    { pubkey: 'b', stakeLamports: 100n },
  ];
  const meta = new Map<string, ValidatorMetadata>([
    ['a', { pubkey: 'a', country: null, city: null, asn: null, wizScore: 80 }],
    ['b', { pubkey: 'b', country: null, city: null, asn: null, wizScore: null }],
  ]);
  near(networkImpactScore(rows, meta), 80);
});

test('networkImpactScore: NaN if no validator has a wizScore', () => {
  const rows: PoolStakeRow[] = [{ pubkey: 'a', stakeLamports: 100n }];
  const meta = new Map<string, ValidatorMetadata>([
    ['a', { pubkey: 'a', country: null, city: null, asn: null, wizScore: null }],
  ]);
  assert.ok(Number.isNaN(networkImpactScore(rows, meta)));
});

// ───────────────────────────────────────────────────────────────────────────
// computePoolScores — end-to-end pure function
// ───────────────────────────────────────────────────────────────────────────

test('computePoolScores: 3 validators, perfectly diverse on all dims, equal stake', () => {
  const rows: PoolStakeRow[] = [
    { pubkey: 'a', stakeLamports: 100n },
    { pubkey: 'b', stakeLamports: 100n },
    { pubkey: 'c', stakeLamports: 100n },
  ];
  const meta = new Map<string, ValidatorMetadata>([
    ['a', { pubkey: 'a', country: 'US', city: 'NY',  asn: '111', wizScore: 90 }],
    ['b', { pubkey: 'b', country: 'DE', city: 'BER', asn: '222', wizScore: 90 }],
    ['c', { pubkey: 'c', country: 'SG', city: 'SGP', asn: '333', wizScore: 90 }],
  ]);
  const r = computePoolScores(rows, meta);
  near(r.eN_country, 3, 1e-9);
  near(r.eN_city, 3, 1e-9);
  near(r.eN_asn, 3, 1e-9);
  near(r.gdi, 3, 1e-9);  // cube root of 27
  near(r.nis, 90);
  assert.equal(r.validatorCount, 3);
  assert.equal(r.totalStakeLamports, 300n);
});

test('computePoolScores: all in one country, diverse cities, single ASN', () => {
  const rows: PoolStakeRow[] = [
    { pubkey: 'a', stakeLamports: 100n },
    { pubkey: 'b', stakeLamports: 100n },
    { pubkey: 'c', stakeLamports: 100n },
  ];
  const meta = new Map<string, ValidatorMetadata>([
    ['a', { pubkey: 'a', country: 'US', city: 'NY',  asn: '111', wizScore: 80 }],
    ['b', { pubkey: 'b', country: 'US', city: 'SF',  asn: '111', wizScore: 80 }],
    ['c', { pubkey: 'c', country: 'US', city: 'CHI', asn: '111', wizScore: 80 }],
  ]);
  const r = computePoolScores(rows, meta);
  near(r.eN_country, 1);
  near(r.eN_city, 3, 1e-9);
  near(r.eN_asn, 1);
  // GDI = cbrt(1 * 3 * 1) = cbrt(3) ≈ 1.4422
  near(r.gdi, Math.cbrt(3), 1e-9);
});

test('computePoolScores: stake-weighted skew matters', () => {
  // 90% of stake in US/NY/ASN1; 10% spread across two other countries/cities/ASNs.
  // eN_* should be close to 1 (heavily concentrated), not 3 (the count).
  const rows: PoolStakeRow[] = [
    { pubkey: 'a', stakeLamports: 90n },
    { pubkey: 'b', stakeLamports: 5n },
    { pubkey: 'c', stakeLamports: 5n },
  ];
  const meta = new Map<string, ValidatorMetadata>([
    ['a', { pubkey: 'a', country: 'US', city: 'NY',  asn: '1', wizScore: 80 }],
    ['b', { pubkey: 'b', country: 'DE', city: 'BER', asn: '2', wizScore: 80 }],
    ['c', { pubkey: 'c', country: 'SG', city: 'SGP', asn: '3', wizScore: 80 }],
  ]);
  const r = computePoolScores(rows, meta);
  // H = -(0.9 ln 0.9 + 0.05 ln 0.05 + 0.05 ln 0.05) ≈ 0.394
  // eN = exp(H) ≈ 1.483
  const H = -(0.9 * Math.log(0.9) + 0.05 * Math.log(0.05) + 0.05 * Math.log(0.05));
  near(r.eN_country, Math.exp(H), 1e-9);
  near(r.eN_city, Math.exp(H), 1e-9);
  near(r.eN_asn, Math.exp(H), 1e-9);
});

test('computePoolScores: missing metadata for a validator → falls into Unknown bucket', () => {
  const rows: PoolStakeRow[] = [
    { pubkey: 'a', stakeLamports: 50n },
    { pubkey: 'b', stakeLamports: 50n },
  ];
  // Only 'a' has metadata.
  const meta = new Map<string, ValidatorMetadata>([
    ['a', { pubkey: 'a', country: 'US', city: 'NY', asn: '1', wizScore: 90 }],
  ]);
  const r = computePoolScores(rows, meta);
  // 'b' bucketed as Unknown across all dims → 50/50 split.
  near(r.eN_country, 2);
  near(r.eN_city, 2);
  near(r.eN_asn, 2);
  // NIS: only 'a' is scored (50 stake), so weighted avg over scored = 90.
  near(r.nis, 90);
});

// ───────────────────────────────────────────────────────────────────────────
// rollingMean
// ───────────────────────────────────────────────────────────────────────────

test('rollingMean: empty → NaN', () => {
  assert.ok(Number.isNaN(rollingMean([], 5)));
});

test('rollingMean: shorter than window → mean of all values', () => {
  near(rollingMean([10, 20, 30], 5), 20);
});

test('rollingMean: takes last N values', () => {
  near(rollingMean([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3), 9);
  near(rollingMean([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5), 8);
  near(rollingMean([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 10), 5.5);
});
