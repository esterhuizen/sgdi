// Shared (country, city, ASN) tuple aggregation. Used by:
//   • /locations — the rarity / IBRL / Operator-score table
//   • /validator/<pubkey> — to surface rarer-but-equal-IBRL alternatives
//
// Pulled out of /locations/page.tsx so both consumers stay in sync on
// the aggregation formulas. If you change anything here, both pages
// update automatically.

import type { ValidatorIndexEntry } from '@/lib/data';

export type TupleRow = {
  /** Stable key (country|city|asn). */
  key: string;
  country: string;
  city: string;
  asnId: string;
  asnName: string;
  rarityCountry: number | null;
  rarityCity: number | null;
  rarityAsn: number | null;
  composite: number | null;
  validatorCount: number;
  dzCount: number;
  totalStakeSol: number;
  /** Simple (unweighted) mean of stakewiz wiz_score across the location's
   *  validators. null when nobody has a wiz_score. */
  avgWizScore: number | null;
  /** Simple (unweighted) mean of IBRL score across validators with a score
   *  this epoch. null when no validator at the location has one. */
  avgIbrlScore: number | null;
  /** Max IBRL across the location's validators with a score. Proxy for the
   *  location's capability ceiling (vs avg which is dragged down by weak
   *  operators). null when ≤1 IBRL data point (max == avg → no extra
   *  signal). */
  maxIbrlScore: number | null;
};

export function aggregateTuples(rows: readonly ValidatorIndexEntry[]): TupleRow[] {
  // Two-pass: first build buckets + per-validator sums, then compute means.
  type Agg = TupleRow & {
    _wizSum: number; _wizN: number;
    _ibrlSum: number; _ibrlN: number;
    _ibrlMax: number;
  };
  const tuples = new Map<string, Agg>();
  for (const v of rows) {
    if (!v.country || !v.city || !v.asn) continue;
    const key = `${v.country}|${v.city}|${v.asn}`;
    let t = tuples.get(key);
    if (!t) {
      t = {
        key,
        country: v.country,
        city: v.city,
        asnId: v.asn,
        asnName: v.asn_name || v.asn,
        rarityCountry: v.rarity_country,
        rarityCity: v.rarity_city,
        rarityAsn: v.rarity_asn,
        composite: v.composite_rarity,
        validatorCount: 0,
        dzCount: 0,
        totalStakeSol: 0,
        avgWizScore: null,
        avgIbrlScore: null,
        maxIbrlScore: null,
        _wizSum: 0,
        _wizN: 0,
        _ibrlSum: 0,
        _ibrlN: 0,
        _ibrlMax: 0,
      };
      tuples.set(key, t);
    }
    t.validatorCount += 1;
    if (v.is_dz === true) t.dzCount += 1;
    t.totalStakeSol += v.activated_stake_sol;
    // Simple unweighted mean — each validator at the location counts
    // equally. Validators with no score (e.g. no blocks produced this
    // epoch for IBRL) are excluded from the mean rather than counted
    // as zero.
    if (typeof v.wiz_score === 'number' && Number.isFinite(v.wiz_score)) {
      t._wizSum += v.wiz_score;
      t._wizN += 1;
    }
    if (typeof v.ibrl_score === 'number' && Number.isFinite(v.ibrl_score)) {
      t._ibrlSum += v.ibrl_score;
      t._ibrlN += 1;
      if (v.ibrl_score > t._ibrlMax) t._ibrlMax = v.ibrl_score;
    }
  }
  // Finalise: compute means, strip internal sums before returning.
  return [...tuples.values()].map(({ _wizSum, _wizN, _ibrlSum, _ibrlN, _ibrlMax, ...t }) => ({
    ...t,
    avgWizScore: _wizN > 0 ? _wizSum / _wizN : null,
    avgIbrlScore: _ibrlN > 0 ? _ibrlSum / _ibrlN : null,
    maxIbrlScore: _ibrlN > 1 ? _ibrlMax : null,
  }));
}
