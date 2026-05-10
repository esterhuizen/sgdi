// Scenario / what-if engine. PURE — zero I/O. Mirrors scoring.ts in spirit.
//
// Given a pool's validator set with FIXED rarity vectors (precomputed from
// network shares) and a stake allocation across them, we can:
//
//   - score an arbitrary allocation in O(n)
//   - find the allocation that maximises GDI subject to Σstake = totalStake,
//     stake_i ≥ minStake for each validator i
//
// Why is rarity treated as constant during analysis? Because the pool we're
// optimising is small relative to total Solana stake (Definity ≈ 254k of
// ~400M ≈ 0.06%) — its allocation choices barely move network shares, so
// rarities are effectively exogenous. This makes the math tractable and the
// optimum unique.
//
// Optimiser: entropic mirror descent (multiplicative weights). Step:
//   wᵢ ← wᵢ · exp(η · ∂log(GDI)/∂wᵢ);  then renormalise to Σwᵢ = 1.
// log(GDI) = (1/3)(log DC_c + log DC_city + log DC_asn) is concave on the
// simplex, so the algorithm converges to the unique global optimum.

export type RarityVector = {
  country: number;
  city: number;
  asn: number;
};

export type Scores = {
  dc_country: number;
  dc_city: number;
  dc_asn: number;
  gdi: number;
};

/**
 * Score an allocation given pre-computed rarities.
 * pubkeys, stake, and rarities are parallel arrays of length n.
 * Returns NaN scores if total stake is zero.
 */
export function scoreAllocation(
  stake: readonly number[],
  rarities: readonly RarityVector[],
): Scores {
  const n = stake.length;
  let total = 0;
  for (let i = 0; i < n; i++) total += stake[i];
  if (total <= 0) {
    return { dc_country: NaN, dc_city: NaN, dc_asn: NaN, gdi: NaN };
  }
  let dcc = 0, dcity = 0, dca = 0;
  for (let i = 0; i < n; i++) {
    const w = stake[i] / total;
    dcc += w * rarities[i].country;
    dcity += w * rarities[i].city;
    dca += w * rarities[i].asn;
  }
  return {
    dc_country: dcc,
    dc_city: dcity,
    dc_asn: dca,
    gdi: Math.cbrt(dcc * dcity * dca),
  };
}

export type OptimizeOptions = {
  /** Step size for the multiplicative-weights update. Default 0.05. */
  eta?: number;
  /** Max iterations before giving up. Default 20000. */
  maxIters?: number;
  /**
   * Convergence tolerance on log(GDI) per iteration. Default 1e-8 — well
   * below display precision (3 decimal places ⇒ ~1e-4 in GDI), so this is
   * effectively "until further iterations are pointless".
   */
  tol?: number;
  /**
   * Minimum stake fraction per validator (after optimisation). Use this to
   * avoid recommending a validator be reduced to ~0 SOL if the pool needs
   * operational floors. 0 means "no floor".
   */
  minWeight?: number;
  /**
   * Maximum stake fraction per validator (after optimisation). Use this to
   * cap concentration on any single operator. Must be ≥ 1/n for feasibility.
   * Default 1 (no cap).
   */
  maxWeight?: number;
};

export type OptimizeResult = {
  /** Optimal stake fraction per validator (Σ = 1). Parallel to rarities. */
  weights: number[];
  /** Scores at the optimum. */
  scores: Scores;
  /** Iterations actually run before convergence (or maxIters). */
  iters: number;
  /** True if the algorithm converged before maxIters. */
  converged: boolean;
};

/**
 * Find the stake-fraction allocation that maximises GDI on the box-simplex
 * { w ∈ ℝⁿ : Σwᵢ = 1, minWeight ≤ wᵢ ≤ maxWeight }.
 *
 * Algorithm: entropic mirror descent on the "free" residual (wᵢ − minWeight),
 * with a water-filling projection after each step to enforce the per-validator
 * ceiling (clip overflow + redistribute to uncapped validators, repeating
 * until no validator exceeds the cap).
 */
export function optimize(
  rarities: readonly RarityVector[],
  options: OptimizeOptions = {},
): OptimizeResult {
  const { eta = 0.05, maxIters = 20000, tol = 1e-8, minWeight = 0, maxWeight = 1 } = options;
  const n = rarities.length;
  if (n === 0) {
    return {
      weights: [],
      scores: { dc_country: NaN, dc_city: NaN, dc_asn: NaN, gdi: NaN },
      iters: 0,
      converged: true,
    };
  }

  // Reformulate { wᵢ ≥ minWeight, Σwᵢ = 1 } as { fᵢ ≥ 0, Σfᵢ = freeMass }
  // where wᵢ = minWeight + fᵢ and freeMass = 1 − n·minWeight.
  // We do MD on f over a simplex of total mass freeMass; w is reconstructed
  // each iteration to compute the gradient of log(GDI) at the actual weights.
  const floor = minWeight;
  const freeMass = 1 - n * floor;
  // Per-validator free-mass ceiling (free can range [0, ceilFree])
  const ceilFree = Math.max(0, maxWeight - floor);
  // Feasibility checks
  if (freeMass < 0 || maxWeight < minWeight || n * maxWeight < 1 - 1e-12) {
    // Infeasible (floor too high, or cap too low to sum to 1). Return uniform;
    // caller should relax the bounds.
    const uniform = new Array<number>(n).fill(1 / n);
    return { weights: uniform, scores: scoreAllocation(uniform, rarities), iters: 0, converged: false };
  }

  // Init f uniformly across the free mass. (Equivalent to w = uniform when
  // floor=0, which preserves the previous default behaviour.)
  let f = new Array<number>(n).fill(freeMass / n);

  let prevLog = -Infinity;
  let iter = 0;
  let converged = false;

  for (iter = 0; iter < maxIters; iter++) {
    let dcc = 0, dcity = 0, dca = 0;
    for (let i = 0; i < n; i++) {
      const w = floor + f[i];
      dcc += w * rarities[i].country;
      dcity += w * rarities[i].city;
      dca += w * rarities[i].asn;
    }
    // Guard: if any DC dimension collapses to ≤0 (no rarity in that dim
    // across all weighted validators), log(GDI) is -∞. Should not happen with
    // real Solana data; bail safely.
    if (dcc <= 0 || dcity <= 0 || dca <= 0) break;

    const logGDI = (Math.log(dcc) + Math.log(dcity) + Math.log(dca)) / 3;
    if (Math.abs(logGDI - prevLog) < tol) {
      converged = true;
      break;
    }
    prevLog = logGDI;

    // Gradient of log(GDI) wrt fᵢ is the same as wrt wᵢ (since wᵢ = floor + fᵢ):
    //   (r_c[i]/dc_c + r_city[i]/dc_city + r_asn[i]/dc_asn) / 3
    // MD on f with total mass freeMass; renormalise after each step.
    if (freeMass === 0) {
      // No free mass to allocate (n·floor == 1 exactly): w is forced uniform-equal.
      converged = true;
      break;
    }
    let sum = 0;
    const next = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      const grad = (rarities[i].country / dcc + rarities[i].city / dcity + rarities[i].asn / dca) / 3;
      // exp(eta·grad) keeps fᵢ strictly positive; need to seed f away from 0
      // (we did, with uniform init) so MD can explore.
      next[i] = (f[i] > 0 ? f[i] : freeMass / (n * 1000)) * Math.exp(eta * grad);
      sum += next[i];
    }
    // Renormalise to total mass = freeMass
    for (let i = 0; i < n; i++) next[i] = (next[i] / sum) * freeMass;

    // Water-fill projection for the per-validator ceiling: clip any free
    // weight above ceilFree and redistribute the overflow proportionally
    // among the uncapped weights. Iterate until no further violations
    // (typically 1-2 passes; bounded at n iters worst case).
    if (maxWeight < 1) {
      for (let pass = 0; pass < n; pass++) {
        let cappedSum = 0;
        let uncappedSum = 0;
        const uncapped: number[] = [];
        for (let i = 0; i < n; i++) {
          if (next[i] >= ceilFree - 1e-15) {
            next[i] = ceilFree;
            cappedSum += ceilFree;
          } else {
            uncappedSum += next[i];
            uncapped.push(i);
          }
        }
        const target = freeMass - cappedSum;
        if (uncapped.length === 0 || target <= 1e-15) break;
        const factor = uncappedSum > 0 ? target / uncappedSum : 0;
        let needAnother = false;
        if (uncappedSum > 0) {
          for (const i of uncapped) {
            next[i] *= factor;
            if (next[i] > ceilFree + 1e-15) needAnother = true;
          }
        } else {
          // Edge case: all uncapped weights are zero — distribute target equally
          for (const i of uncapped) next[i] = target / uncapped.length;
        }
        if (!needAnother) break;
      }
    }

    f = next;
  }

  // Final w = floor + f
  const w = f.map((fi) => floor + fi);

  return {
    weights: w,
    scores: scoreAllocation(w, rarities),
    iters: iter,
    converged,
  };
}
