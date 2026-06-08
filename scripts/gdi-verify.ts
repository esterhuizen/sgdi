// gdi-verify.ts — Independently reproduce every pool's GDI from the PUBLISHED
// JSON artifacts and confirm it matches what gdindex.app reports.
//
// WHY THIS EXISTS
// ---------------
// The GDI is meant to be mechanical and fair: the same formula applied to every
// pool, with no per-pool privilege. This script proves that, end to end, using
// ONLY public data:
//
//   • No API keys, no Helius, no Stakewiz token.
//   • No MaxMind license and no database — the geo classification that feeds the
//     score is already baked into the published JSON (and each value carries a
//     `geo_sources` provenance tag: maxmind / override / stakewiz).
//   • It imports the EXACT pure scoring functions the live pipeline uses
//     (src/lib/gdi/scoring.ts) — so there is zero re-implementation drift. If the
//     published numbers were hand-tuned for any pool, this check would fail.
//
// WHAT IT CHECKS
// --------------
//   1. Rebuilds the network rarity denominator (per country / city / ASN stake
//      share) from validators.json — the published active-voting set.
//   2. For every pool on the leaderboard, recomputes DC_country/city/asn and the
//      composite GDI from that pool's published validator list, and compares it
//      to the published GDI.
//   3. Cross-checks each published per-validator rarity (r_country/r_city/r_asn)
//      against -ln(network_share) computed in step 1.
//   4. Recomputes the network-baseline GDI and compares it to the published one.
//
// USAGE
// -----
//   node --experimental-strip-types scripts/gdi-verify.ts
//   GDI_BASE_URL=https://gdindex.app node --experimental-strip-types scripts/gdi-verify.ts
//
// Exits non-zero if any pool's recomputed GDI diverges from the published value.

import {
  computeNetworkShares,
  computePoolScores,
  computeNetworkBaseline,
  rarityFromShare,
} from '../src/lib/gdi/scoring.ts';
import type { PoolStakeRow, ValidatorMetadata, NetworkShares } from '../src/lib/gdi/scoring.ts';

const BASE = process.env.GDI_BASE_URL ?? 'https://gdindex.app';

// GDI values are dimensionless (nats). Recomputation differs from the published
// value only by IEEE-754 float noise + sub-lamport rounding of published
// stake_sol back to lamports — comfortably under this tolerance.
const TOLERANCE = 1e-6;

type AnyJson = Record<string, any>;

async function getJson(path: string): Promise<AnyJson> {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return res.json() as Promise<AnyJson>;
}

function lamportsFromSol(sol: number): bigint {
  return BigInt(Math.round(sol * 1e9));
}

function metaFrom(v: AnyJson, pubkey: string): ValidatorMetadata {
  return {
    pubkey,
    country: v.country ?? null,
    city: v.city ?? null,
    asn: v.asn ?? null,
    wizScore: v.wiz_score ?? null,
  };
}

async function main(): Promise<void> {
  // ── 1. Network active set → rarity denominator ───────────────────────────
  const vjson = await getJson('/gdi/validators.json');
  const active = (vjson.validators as AnyJson[]).filter(
    (v) => !v.delinquent && BigInt(v.activated_stake_lamports ?? '0') > 0n,
  );

  const baselineRows: PoolStakeRow[] = active.map((v) => ({
    pubkey: v.vote_pubkey,
    stakeLamports: BigInt(v.activated_stake_lamports),
  }));
  const baselineMeta = new Map<string, ValidatorMetadata>(
    active.map((v) => [v.vote_pubkey, metaFrom(v, v.vote_pubkey)]),
  );
  const shares: NetworkShares = computeNetworkShares(baselineRows, baselineMeta);

  // ── 2. Published leaderboard (pool list + published GDI + epoch) ──────────
  const lb = await getJson('/gdi/leaderboard-latest.json');
  const epoch: number = lb.epoch;

  console.log('────────────────────────────────────────────────────────────────────');
  console.log(`GDI reproduction check — epoch ${epoch}`);
  console.log(`source:      ${BASE}`);
  console.log(`methodology: ${lb.methodology_version}`);
  console.log(`active set:  ${active.length} validators (!delinquent && activated_stake > 0)`);
  console.log(`tolerance:   ${TOLERANCE}`);
  console.log('────────────────────────────────────────────────────────────────────\n');

  let maxPoolDiff = 0;
  let poolFails = 0;
  let rarityChecks = 0;
  let rarityFails = 0;
  let maxRarityDiff = 0;

  const lines: string[] = [];

  // ── 3. Recompute every pool from its published validator list ────────────
  for (const p of lb.pools as AnyJson[]) {
    const detail = await getJson(`/gdi/pools/${p.pool_address}/latest.json`);
    const vs = detail.validators as AnyJson[];

    const rows: PoolStakeRow[] = vs.map((v) => ({
      pubkey: v.pubkey,
      stakeLamports: lamportsFromSol(v.stake_sol),
    }));
    const meta = new Map<string, ValidatorMetadata>(
      vs.map((v) => [v.pubkey, metaFrom(v, v.pubkey)]),
    );

    const result = computePoolScores(rows, meta, shares);
    const published: number = p.gdi;
    const diff = Math.abs(result.gdi - published);
    maxPoolDiff = Math.max(maxPoolDiff, diff);
    const ok = diff <= TOLERANCE;
    if (!ok) poolFails++;

    const name = String(p.pool_name ?? p.pool_address.slice(0, 8)).padEnd(16);
    lines.push(
      `  ${ok ? 'OK  ' : 'FAIL'} ${name} published=${published.toFixed(6)}  ` +
        `recomputed=${result.gdi.toFixed(6)}  Δ=${diff.toExponential(2)}`,
    );

    // ── 4. Cross-check published per-validator rarities vs -ln(share) ──────
    for (const v of vs) {
      if (v.r_country == null) continue;
      const checks: Array<[number, number]> = [
        [v.r_country, rarityFromShare(shares.country.get(v.country) ?? 0)],
        [v.r_city, rarityFromShare(shares.city.get(v.city) ?? 0)],
        [v.r_asn, rarityFromShare(shares.asn.get(v.asn) ?? 0)],
      ];
      for (const [pub, recomputed] of checks) {
        rarityChecks++;
        const d = Math.abs(pub - recomputed);
        maxRarityDiff = Math.max(maxRarityDiff, d);
        if (d > TOLERANCE) rarityFails++;
      }
    }
  }

  // ── 5. Network baseline ──────────────────────────────────────────────────
  const baseline = computeNetworkBaseline(baselineRows, baselineMeta, shares);
  const publishedBaseline: number | undefined = lb.network_baseline?.gdi;
  const baselineDiff =
    publishedBaseline == null ? NaN : Math.abs(baseline.gdi - publishedBaseline);

  console.log('Per-pool GDI:');
  for (const l of lines) console.log(l);

  console.log('\nCross-checks:');
  console.log(
    `  per-validator rarity (-ln share): ${rarityChecks} checks, ` +
      `${rarityFails} mismatch, max Δ=${maxRarityDiff.toExponential(2)}`,
  );
  if (publishedBaseline != null) {
    console.log(
      `  network baseline GDI: published=${publishedBaseline.toFixed(6)} ` +
        `recomputed=${baseline.gdi.toFixed(6)} Δ=${baselineDiff.toExponential(2)}`,
    );
  }

  const baselineOk = publishedBaseline == null || baselineDiff <= TOLERANCE;
  const pass = poolFails === 0 && rarityFails === 0 && baselineOk;

  console.log('\n────────────────────────────────────────────────────────────────────');
  console.log(
    `${pass ? 'PASS' : 'FAIL'} — ${lb.pools.length} pools, ` +
      `${poolFails} GDI mismatches (max Δ=${maxPoolDiff.toExponential(2)}), ` +
      `${rarityFails} rarity mismatches`,
  );
  console.log('────────────────────────────────────────────────────────────────────');

  if (!pass) process.exitCode = 1;
}

main().catch((err) => {
  console.error('verify failed:', err);
  process.exitCode = 2;
});
