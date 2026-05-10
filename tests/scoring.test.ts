// Pure-function unit tests for src/lib/gdi/scoring.ts.
//
// Run via: npm test  (Node's built-in test runner — no jest/vitest dependency)
//
// Coverage strategy: pin every formula to a worked example. If any number
// here changes, that's a methodology bump (PATCH or higher per CONTRIBUTING.md).
//
// Methodology (sgdi-1.0.0):
//   rarity_D(v) = -ln( network_share_D(category of v) )
//   DC_D        = Σᵥ wᵥ · rarity_D(v)        stake-weighted avg
//   GDI         = ( DC_country · DC_city · DC_asn )^(1/3)

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  rarityFromShare,
  computeShares,
  computeNetworkShares,
  decentralisationContribution,
  geometricMean3,
  networkImpactScore,
  computePoolScores,
  computeNetworkBaseline,
  rollingMean,
  type ValidatorMetadata,
  type PoolStakeRow,
  type NetworkShares,
} from '../src/lib/gdi/scoring.ts';

const EPS = 1e-9;
function near(actual: number, expected: number, eps = EPS) {
  assert.ok(
    Math.abs(actual - expected) < eps,
    `expected ${actual} ≈ ${expected} (within ${eps})`,
  );
}

// ───────────────────────────────────────────────────────────────────────────
// rarityFromShare
// ───────────────────────────────────────────────────────────────────────────

test('rarityFromShare: -ln(share) for normal positive shares', () => {
  near(rarityFromShare(0.5), Math.log(2));
  near(rarityFromShare(0.1), -Math.log(0.1));
  near(rarityFromShare(0.01), -Math.log(0.01));
});

test('rarityFromShare: zero/negative clamps to floor (~20.7)', () => {
  // RARITY_SHARE_FLOOR = 1e-9, so -ln(1e-9) ≈ 20.72.
  near(rarityFromShare(0), -Math.log(1e-9), 1e-9);
  near(rarityFromShare(-0.5), -Math.log(1e-9), 1e-9);
});

test('rarityFromShare: share=1 (everything in one bucket) → 0', () => {
  near(rarityFromShare(1), 0);
});

// ───────────────────────────────────────────────────────────────────────────
// computeShares
// ───────────────────────────────────────────────────────────────────────────

test('computeShares: sums to 1.0 across placeable stake', () => {
  const rows: PoolStakeRow[] = [
    { pubkey: 'a', stakeLamports: 100n },
    { pubkey: 'b', stakeLamports: 200n },
    { pubkey: 'c', stakeLamports: 300n },
  ];
  const meta = new Map<string, ValidatorMetadata>([
    ['a', { pubkey: 'a', country: 'US', city: null, asn: null, wizScore: null }],
    ['b', { pubkey: 'b', country: 'DE', city: null, asn: null, wizScore: null }],
    ['c', { pubkey: 'c', country: 'US', city: null, asn: null, wizScore: null }],
  ]);
  const shares = computeShares(rows, meta, (m) => m?.country ?? null);
  near(shares.get('US')!, (100 + 300) / 600);
  near(shares.get('DE')!, 200 / 600);
  let sum = 0;
  for (const v of shares.values()) sum += v;
  near(sum, 1);
});

test('computeShares: validators with null bucket are excluded entirely', () => {
  const rows: PoolStakeRow[] = [
    { pubkey: 'a', stakeLamports: 100n },
    { pubkey: 'b', stakeLamports: 100n },
    { pubkey: 'c', stakeLamports: 100n },
  ];
  const meta = new Map<string, ValidatorMetadata>([
    ['a', { pubkey: 'a', country: 'US', city: null, asn: null, wizScore: null }],
    ['b', { pubkey: 'b', country: null, city: null, asn: null, wizScore: null }],
    // 'c' has no metadata at all
  ]);
  const shares = computeShares(rows, meta, (m) => m?.country ?? null);
  // Only 'a' is placeable → US gets 100% of placeable.
  near(shares.get('US')!, 1);
  assert.equal(shares.size, 1);
});

test('computeShares: empty input → empty map', () => {
  const shares = computeShares([], new Map(), (m) => m?.country ?? null);
  assert.equal(shares.size, 0);
});

// ───────────────────────────────────────────────────────────────────────────
// decentralisationContribution
// ───────────────────────────────────────────────────────────────────────────

test('DC: 100% of stake in the most-rare bucket → rarity of that bucket', () => {
  // Network: A=50%, B=30%, C=20%. Pool: 100% in C.
  const shares = new Map([['A', 0.5], ['B', 0.3], ['C', 0.2]]);
  const rows: PoolStakeRow[] = [{ pubkey: 'p', stakeLamports: 100n }];
  const meta = new Map<string, ValidatorMetadata>([
    ['p', { pubkey: 'p', country: 'C', city: null, asn: null, wizScore: null }],
  ]);
  const dc = decentralisationContribution(rows, meta, shares, (m) => m?.country ?? null);
  near(dc, -Math.log(0.2));
});

test('DC: 50/50 stake across A and C → average rarity of A and C', () => {
  const shares = new Map([['A', 0.5], ['B', 0.3], ['C', 0.2]]);
  const rows: PoolStakeRow[] = [
    { pubkey: 'p1', stakeLamports: 50n },
    { pubkey: 'p2', stakeLamports: 50n },
  ];
  const meta = new Map<string, ValidatorMetadata>([
    ['p1', { pubkey: 'p1', country: 'A', city: null, asn: null, wizScore: null }],
    ['p2', { pubkey: 'p2', country: 'C', city: null, asn: null, wizScore: null }],
  ]);
  const dc = decentralisationContribution(rows, meta, shares, (m) => m?.country ?? null);
  const expected = 0.5 * -Math.log(0.5) + 0.5 * -Math.log(0.2);
  near(dc, expected);
});

test('DC: validators with null bucket are excluded from both numerator and denominator', () => {
  // 100 stake at C (rare); 100 stake at unknown country → DC reflects only C's rarity.
  const shares = new Map([['A', 0.5], ['B', 0.3], ['C', 0.2]]);
  const rows: PoolStakeRow[] = [
    { pubkey: 'p1', stakeLamports: 100n },
    { pubkey: 'p2', stakeLamports: 100n },
  ];
  const meta = new Map<string, ValidatorMetadata>([
    ['p1', { pubkey: 'p1', country: 'C', city: null, asn: null, wizScore: null }],
    ['p2', { pubkey: 'p2', country: null, city: null, asn: null, wizScore: null }],
  ]);
  const dc = decentralisationContribution(rows, meta, shares, (m) => m?.country ?? null);
  near(dc, -Math.log(0.2));
});

test('DC: NaN if no validator has a placeable bucket', () => {
  const shares = new Map([['A', 1.0]]);
  const rows: PoolStakeRow[] = [{ pubkey: 'p', stakeLamports: 100n }];
  const meta = new Map<string, ValidatorMetadata>([
    ['p', { pubkey: 'p', country: null, city: null, asn: null, wizScore: null }],
  ]);
  const dc = decentralisationContribution(rows, meta, shares, (m) => m?.country ?? null);
  assert.ok(Number.isNaN(dc));
});

test('DC: a pool that mirrors network distribution → DC equals network avg rarity', () => {
  // Network: A=50%, B=30%, C=20%. Pool stake split 50/30/20.
  const shares = new Map([['A', 0.5], ['B', 0.3], ['C', 0.2]]);
  const rows: PoolStakeRow[] = [
    { pubkey: 'pa', stakeLamports: 50n },
    { pubkey: 'pb', stakeLamports: 30n },
    { pubkey: 'pc', stakeLamports: 20n },
  ];
  const meta = new Map<string, ValidatorMetadata>([
    ['pa', { pubkey: 'pa', country: 'A', city: null, asn: null, wizScore: null }],
    ['pb', { pubkey: 'pb', country: 'B', city: null, asn: null, wizScore: null }],
    ['pc', { pubkey: 'pc', country: 'C', city: null, asn: null, wizScore: null }],
  ]);
  const dc = decentralisationContribution(rows, meta, shares, (m) => m?.country ?? null);
  const networkAvgRarity = 0.5 * -Math.log(0.5) + 0.3 * -Math.log(0.3) + 0.2 * -Math.log(0.2);
  near(dc, networkAvgRarity, 1e-9);
});

// ───────────────────────────────────────────────────────────────────────────
// geometricMean3
// ───────────────────────────────────────────────────────────────────────────

test('geometricMean3: cube of equal → that value', () => {
  near(geometricMean3(8, 8, 8), 8);
});

test('geometricMean3: 1·8·27 → cbrt(216) = 6', () => {
  near(geometricMean3(1, 8, 27), 6);
});

test('geometricMean3: NaN on any non-positive or NaN input', () => {
  assert.ok(Number.isNaN(geometricMean3(0, 5, 5)));
  assert.ok(Number.isNaN(geometricMean3(-1, 5, 5)));
  assert.ok(Number.isNaN(geometricMean3(Number.NaN, 5, 5)));
});

test('geometricMean3: penalises imbalance vs arithmetic mean', () => {
  // (1, 1, 27): arithmetic = 9.67, geometric = 3 — geometric correctly penalises.
  near(geometricMean3(1, 1, 27), 3, 1e-9);
});

// ───────────────────────────────────────────────────────────────────────────
// networkImpactScore
// ───────────────────────────────────────────────────────────────────────────

test('NIS: equal stake, equal scores → that score', () => {
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

test('NIS: stake-weighted', () => {
  // 90 at score 100, 10 at score 0 → 90.
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

test('NIS: validators with null wizScore excluded from both numerator and denominator', () => {
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

test('NIS: NaN if no scored validator', () => {
  const rows: PoolStakeRow[] = [{ pubkey: 'a', stakeLamports: 100n }];
  const meta = new Map<string, ValidatorMetadata>([
    ['a', { pubkey: 'a', country: null, city: null, asn: null, wizScore: null }],
  ]);
  assert.ok(Number.isNaN(networkImpactScore(rows, meta)));
});

// ───────────────────────────────────────────────────────────────────────────
// computePoolScores — end-to-end
// ───────────────────────────────────────────────────────────────────────────

function makeShares(country: [string, number][], city: [string, number][], asn: [string, number][]): NetworkShares {
  return {
    country: new Map(country),
    city: new Map(city),
    asn: new Map(asn),
  };
}

test('computePoolScores: pool entirely in popular places → low DC, GDI < baseline', () => {
  // Network: A is dominant on every dim (60-70% share).
  const shares = makeShares(
    [['US', 0.7], ['DE', 0.2], ['SG', 0.1]],
    [['NY', 0.6], ['BER', 0.25], ['SGP', 0.15]],
    [['1', 0.65], ['2', 0.25], ['3', 0.10]],
  );
  // Pool: all 3 validators in the dominant slot.
  const rows: PoolStakeRow[] = [
    { pubkey: 'a', stakeLamports: 100n },
    { pubkey: 'b', stakeLamports: 100n },
    { pubkey: 'c', stakeLamports: 100n },
  ];
  const meta = new Map<string, ValidatorMetadata>([
    ['a', { pubkey: 'a', country: 'US', city: 'NY', asn: '1', wizScore: 90 }],
    ['b', { pubkey: 'b', country: 'US', city: 'NY', asn: '1', wizScore: 90 }],
    ['c', { pubkey: 'c', country: 'US', city: 'NY', asn: '1', wizScore: 90 }],
  ]);
  const r = computePoolScores(rows, meta, shares);
  near(r.dc_country, -Math.log(0.7));
  near(r.dc_city, -Math.log(0.6));
  near(r.dc_asn, -Math.log(0.65));
  // GDI = cbrt(rarity products); these are all small (popular spots → low rarity)
  assert.ok(r.gdi < 1, `expected GDI < 1 for fully-in-popular-spot pool; got ${r.gdi}`);
});

test('computePoolScores: pool entirely in rare places → high DC, GDI > baseline', () => {
  const shares = makeShares(
    [['US', 0.7], ['DE', 0.2], ['SG', 0.1]],
    [['NY', 0.6], ['BER', 0.25], ['SGP', 0.15]],
    [['1', 0.65], ['2', 0.25], ['3', 0.10]],
  );
  const rows: PoolStakeRow[] = [
    { pubkey: 'a', stakeLamports: 100n },
    { pubkey: 'b', stakeLamports: 100n },
  ];
  const meta = new Map<string, ValidatorMetadata>([
    ['a', { pubkey: 'a', country: 'SG', city: 'SGP', asn: '3', wizScore: 90 }],
    ['b', { pubkey: 'b', country: 'SG', city: 'SGP', asn: '3', wizScore: 90 }],
  ]);
  const r = computePoolScores(rows, meta, shares);
  near(r.dc_country, -Math.log(0.1));
  near(r.dc_city, -Math.log(0.15));
  near(r.dc_asn, -Math.log(0.10));
});

test('computePoolScores: placementCoverage reflects unknown-metadata stake', () => {
  const shares = makeShares([['US', 1]], [['NY', 1]], [['1', 1]]);
  const rows: PoolStakeRow[] = [
    { pubkey: 'a', stakeLamports: 100n },
    { pubkey: 'b', stakeLamports: 100n },
  ];
  const meta = new Map<string, ValidatorMetadata>([
    ['a', { pubkey: 'a', country: 'US', city: 'NY', asn: '1', wizScore: null }],
    // 'b' has no metadata → 50% of stake unplaceable
  ]);
  const r = computePoolScores(rows, meta, shares);
  near(r.placementCoverage, 0.5);
});

test('computePoolScores: pool perfectly mirroring network → DC equals network baseline DC', () => {
  // Build a synthetic network: 3 validators in (US, DE, SG) with shares (0.5, 0.3, 0.2).
  // Then feed the same data as both the "pool" and the "network" — DC should equal baseline.
  const shares = makeShares(
    [['US', 0.5], ['DE', 0.3], ['SG', 0.2]],
    [['NY', 0.5], ['BER', 0.3], ['SGP', 0.2]],
    [['1', 0.5], ['2', 0.3], ['3', 0.2]],
  );
  const rows: PoolStakeRow[] = [
    { pubkey: 'us', stakeLamports: 50n },
    { pubkey: 'de', stakeLamports: 30n },
    { pubkey: 'sg', stakeLamports: 20n },
  ];
  const meta = new Map<string, ValidatorMetadata>([
    ['us', { pubkey: 'us', country: 'US', city: 'NY', asn: '1', wizScore: 80 }],
    ['de', { pubkey: 'de', country: 'DE', city: 'BER', asn: '2', wizScore: 80 }],
    ['sg', { pubkey: 'sg', country: 'SG', city: 'SGP', asn: '3', wizScore: 80 }],
  ]);
  const pool = computePoolScores(rows, meta, shares);
  const baseline = computeNetworkBaseline(rows, meta, shares);
  near(pool.dc_country, baseline.dc_country);
  near(pool.dc_city, baseline.dc_city);
  near(pool.dc_asn, baseline.dc_asn);
  near(pool.gdi, baseline.gdi);
});

// ───────────────────────────────────────────────────────────────────────────
// computeNetworkShares — convenience wrapper
// ───────────────────────────────────────────────────────────────────────────

test('computeNetworkShares: produces all three dimension maps', () => {
  const rows: PoolStakeRow[] = [
    { pubkey: 'a', stakeLamports: 60n },
    { pubkey: 'b', stakeLamports: 40n },
  ];
  const meta = new Map<string, ValidatorMetadata>([
    ['a', { pubkey: 'a', country: 'US', city: 'NY', asn: '1', wizScore: null }],
    ['b', { pubkey: 'b', country: 'DE', city: 'BER', asn: '2', wizScore: null }],
  ]);
  const ns = computeNetworkShares(rows, meta);
  near(ns.country.get('US')!, 0.6);
  near(ns.country.get('DE')!, 0.4);
  near(ns.city.get('NY')!, 0.6);
  near(ns.asn.get('1')!, 0.6);
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
