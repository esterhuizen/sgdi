// Tests for the scenario / what-if engine.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { scoreAllocation, optimize, type RarityVector } from '../src/lib/gdi/scenario.ts';

const close = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

test('scoreAllocation: equal stake on equal-rarity validators yields rarity == DC', () => {
  const r: RarityVector[] = [
    { country: 2, city: 3, asn: 4 },
    { country: 2, city: 3, asn: 4 },
  ];
  const s = scoreAllocation([100, 100], r);
  assert.ok(close(s.dc_country, 2));
  assert.ok(close(s.dc_city, 3));
  assert.ok(close(s.dc_asn, 4));
  assert.ok(close(s.gdi, Math.cbrt(2 * 3 * 4)));
});

test('scoreAllocation: stake weights matter', () => {
  const r: RarityVector[] = [
    { country: 1, city: 1, asn: 1 },
    { country: 5, city: 5, asn: 5 },
  ];
  // 50/50 → DC = 3 in every dim
  const s50 = scoreAllocation([50, 50], r);
  assert.ok(close(s50.dc_country, 3));
  // All stake on the rare validator → DC = 5
  const s100 = scoreAllocation([0, 100], r);
  assert.ok(close(s100.dc_country, 5));
});

test('scoreAllocation: zero total → NaN scores', () => {
  const r: RarityVector[] = [{ country: 1, city: 1, asn: 1 }];
  const s = scoreAllocation([0], r);
  assert.ok(Number.isNaN(s.gdi));
});

test('optimize: single rare validator → all stake to it', () => {
  // Three validators; the third is much rarer in every dim
  const r: RarityVector[] = [
    { country: 1, city: 1, asn: 1 },
    { country: 1, city: 1, asn: 1 },
    { country: 5, city: 5, asn: 5 },
  ];
  const opt = optimize(r, { maxIters: 10000, tol: 1e-12, eta: 0.1 });
  assert.ok(opt.converged);
  // Optimum is to put nearly all weight on validator 2 (index 2)
  assert.ok(opt.weights[2] > 0.95, `expected w[2] > 0.95, got ${opt.weights[2]}`);
  // GDI should be close to 5
  assert.ok(opt.scores.gdi > 4.9);
});

test('optimize: trade-off — different validators rare in different dims, mix wins', () => {
  // Three validators, each rare in exactly one dimension. The geometric-mean
  // objective prefers a mix (since putting all on one gives 0 in the others'
  // dims via floor 0 — but here we set the off-dim to 1 not 0 to keep finite).
  const r: RarityVector[] = [
    { country: 5, city: 1, asn: 1 },
    { country: 1, city: 5, asn: 1 },
    { country: 1, city: 1, asn: 5 },
  ];
  const opt = optimize(r, { maxIters: 20000, tol: 1e-12, eta: 0.05 });
  assert.ok(opt.converged);
  // By symmetry the optimum is the equal-mix
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(opt.weights[i] - 1 / 3) < 0.01,
      `expected w[${i}] ≈ 0.333, got ${opt.weights[i]}`);
  }
  // Optimum DC in each dim = (1/3)(5 + 1 + 1) = 7/3
  assert.ok(close(opt.scores.dc_country, 7 / 3, 1e-3));
  assert.ok(close(opt.scores.gdi, 7 / 3, 1e-3));
});

test('optimize: monotone — optimised GDI ≥ uniform GDI', () => {
  // Random rarities, check optimiser never makes things worse than uniform.
  const r: RarityVector[] = [];
  // Use a deterministic LCG so the test is reproducible
  let seed = 1;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  for (let i = 0; i < 30; i++) {
    r.push({ country: 0.5 + 5 * rand(), city: 0.5 + 5 * rand(), asn: 0.5 + 5 * rand() });
  }
  const uniform = scoreAllocation(new Array(30).fill(1), r);
  const opt = optimize(r, { maxIters: 5000, eta: 0.05 });
  assert.ok(opt.scores.gdi >= uniform.gdi - 1e-9,
    `optimised GDI ${opt.scores.gdi} < uniform ${uniform.gdi}`);
});

test('optimize: maxWeight ceiling → no weight above ceiling', () => {
  const r: RarityVector[] = [
    { country: 1, city: 1, asn: 1 },
    { country: 1, city: 1, asn: 1 },
    { country: 5, city: 5, asn: 5 },
  ];
  // Cap any one validator at 50%. Without cap, optimum puts ~all on validator 2;
  // with cap, validator 2 should be at exactly 50%, rest split among validators 0 & 1.
  const opt = optimize(r, { maxIters: 5000, eta: 0.05, maxWeight: 0.5 });
  for (let i = 0; i < 3; i++) {
    assert.ok(opt.weights[i] <= 0.5 + 1e-6,
      `expected w[${i}] <= 0.5, got ${opt.weights[i]}`);
  }
  assert.ok(close(opt.weights.reduce((a, b) => a + b), 1, 1e-9));
  // Validator 2 should be at the cap
  assert.ok(opt.weights[2] > 0.5 - 1e-3,
    `expected w[2] near 0.5 cap, got ${opt.weights[2]}`);
});

test('optimize: minWeight + maxWeight together', () => {
  const r: RarityVector[] = [
    { country: 1, city: 1, asn: 1 },
    { country: 1, city: 1, asn: 1 },
    { country: 5, city: 5, asn: 5 },
  ];
  // Each validator in [10%, 50%]. Validator 2 capped at 0.5; the other two
  // share the rest equally: (1 - 0.5) / 2 = 0.25 each.
  const opt = optimize(r, { maxIters: 5000, eta: 0.05, minWeight: 0.1, maxWeight: 0.5 });
  for (let i = 0; i < 3; i++) {
    assert.ok(opt.weights[i] >= 0.1 - 1e-6 && opt.weights[i] <= 0.5 + 1e-6,
      `expected w[${i}] ∈ [0.1, 0.5], got ${opt.weights[i]}`);
  }
  assert.ok(close(opt.weights.reduce((a, b) => a + b), 1, 1e-9));
});

test('optimize: minWeight floor → no weight below floor', () => {
  const r: RarityVector[] = [
    { country: 1, city: 1, asn: 1 },
    { country: 1, city: 1, asn: 1 },
    { country: 5, city: 5, asn: 5 },
  ];
  // Force at least 10% weight on every validator
  const opt = optimize(r, { maxIters: 5000, eta: 0.05, minWeight: 0.1 });
  for (let i = 0; i < 3; i++) {
    assert.ok(opt.weights[i] >= 0.1 - 1e-6,
      `expected w[${i}] >= 0.1, got ${opt.weights[i]}`);
  }
  // Sum = 1
  assert.ok(close(opt.weights.reduce((a, b) => a + b), 1, 1e-9));
});
