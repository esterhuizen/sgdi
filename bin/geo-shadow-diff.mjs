#!/usr/bin/env node
// geo-shadow-diff — read-only CLI for diffing the canonical published tree
// vs the shadow (MaxMind+overrides merged) published tree.
//
// Where `geo-shadow-report` looks at raw per-validator agreement between
// MaxMind shadow values and the canonical Stakewiz row (input-side
// agreement), this one operates on the publish OUTPUTS — leaderboard
// rankings, per-pool GDI, per-validator rarity rank, source provenance.
//
// Use this to:
//   - Decide when the shadow output is stable enough to promote
//     (`pickField` swap in scoring.ts). Aim for ≥2 weeks of low-variance
//     daily summaries before flipping.
//   - Investigate "why did X change?" — drill from the leaderboard delta
//     into the per-pool / per-validator deltas.
//   - Feed the daily Telegram summary (post-shadow-diff-to-tg.mjs,
//     PR 6) via the `--json` mode.
//
// Inputs (read-only):
//   /var/lib/sgdi/published/leaderboard-latest.json     ← canonical
//   /var/lib/sgdi/published/validator-index.json        ← canonical
//   /var/lib/sgdi/published-shadow/leaderboard-latest.json ← shadow
//   /var/lib/sgdi/published-shadow/validator-index.json    ← shadow
//
// Usage:
//   bin/geo-shadow-diff.mjs                        # human-readable, top 10
//   bin/geo-shadow-diff.mjs --top 20               # show 20 movers per list
//   bin/geo-shadow-diff.mjs --json                 # machine-readable
//   bin/geo-shadow-diff.mjs --canonical-dir /tmp/foo --shadow-dir /tmp/bar

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const CANONICAL_DIR_DEFAULT = '/var/lib/sgdi/published';
const SHADOW_DIR_DEFAULT    = '/var/lib/sgdi/published-shadow';

function parseCli() {
  const { values } = parseArgs({
    options: {
      'canonical-dir': { type: 'string', default: CANONICAL_DIR_DEFAULT },
      'shadow-dir':    { type: 'string', default: SHADOW_DIR_DEFAULT },
      top:             { type: 'string', default: '10' },
      json:            { type: 'boolean', default: false },
      help:            { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  if (values.help) { printHelp(); process.exit(0); }
  return {
    canonicalDir: values['canonical-dir'],
    shadowDir:    values['shadow-dir'],
    top:          Number.parseInt(values.top, 10),
    json:         values.json,
  };
}

function printHelp() {
  console.log(`geo-shadow-diff — diff canonical vs shadow published trees

Usage:
  geo-shadow-diff [options]

Options:
  --canonical-dir <path>   Canonical published dir (default: ${CANONICAL_DIR_DEFAULT})
  --shadow-dir <path>      Shadow published dir    (default: ${SHADOW_DIR_DEFAULT})
  --top <N>                Show top N movers per list (default: 10)
  --json                   Output as JSON (for piping to TG summary)
  --help                   This help

Exit codes:
  0  diff produced
  2  one or both input trees missing required files (epoch mismatch, etc.)
`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function loadTree(dir) {
  const lbPath = join(dir, 'leaderboard-latest.json');
  const viPath = join(dir, 'validator-index.json');
  if (!existsSync(lbPath) || !existsSync(viPath)) {
    return null;
  }
  return {
    leaderboard:     readJson(lbPath),
    validatorIndex:  readJson(viPath),
  };
}

// ── Section 1: Network baseline delta ────────────────────────────────────
function diffNetwork(canonical, shadow) {
  const cb = canonical.leaderboard.network_baseline;
  const sb = shadow.leaderboard.network_baseline;
  return {
    epoch_canonical: cb.epoch,
    epoch_shadow:    sb.epoch,
    gdi:            { canonical: cb.gdi,             shadow: sb.gdi,             delta: sb.gdi - cb.gdi },
    dc_country:     { canonical: cb.dc_country,      shadow: sb.dc_country,      delta: sb.dc_country - cb.dc_country },
    dc_city:        { canonical: cb.dc_city,         shadow: sb.dc_city,         delta: sb.dc_city - cb.dc_city },
    dc_asn:         { canonical: cb.dc_asn,          shadow: sb.dc_asn,          delta: sb.dc_asn - cb.dc_asn },
    validator_count:{ canonical: cb.validator_count, shadow: sb.validator_count, delta: sb.validator_count - cb.validator_count },
  };
}

// ── Section 2: Pool leaderboard diff ─────────────────────────────────────
function diffPools(canonical, shadow, top) {
  // Index canonical pools by address; assign rank from position.
  const indexByAddr = (lb) => {
    const m = new Map();
    lb.pools.forEach((p, i) => m.set(p.pool_address, { ...p, rank: i + 1 }));
    return m;
  };
  const cMap = indexByAddr(canonical.leaderboard);
  const sMap = indexByAddr(shadow.leaderboard);

  const allAddrs = new Set([...cMap.keys(), ...sMap.keys()]);
  const rows = [];
  for (const addr of allAddrs) {
    const c = cMap.get(addr);
    const s = sMap.get(addr);
    rows.push({
      pool_address: addr,
      pool_name: (c ?? s)?.pool_name ?? null,
      canonical_rank: c?.rank ?? null,
      shadow_rank:    s?.rank ?? null,
      rank_delta: (c && s) ? c.rank - s.rank : null,  // positive = improved on shadow
      canonical_gdi: c?.gdi ?? null,
      shadow_gdi:    s?.gdi ?? null,
      gdi_delta: (c?.gdi != null && s?.gdi != null) ? s.gdi - c.gdi : null,
    });
  }

  const ranked = rows.filter((r) => r.canonical_rank != null && r.shadow_rank != null);
  const changedRank = ranked.filter((r) => r.rank_delta !== 0);
  const onlyCanonical = rows.filter((r) => r.shadow_rank == null);
  const onlyShadow    = rows.filter((r) => r.canonical_rank == null);

  // Movers by absolute rank change, ties broken by absolute gdi change.
  const sortedByRank = [...changedRank].sort((a, b) =>
    Math.abs(b.rank_delta) - Math.abs(a.rank_delta) ||
    Math.abs(b.gdi_delta ?? 0) - Math.abs(a.gdi_delta ?? 0),
  );
  const sortedByGdi = [...ranked]
    .filter((r) => r.gdi_delta != null)
    .sort((a, b) => Math.abs(b.gdi_delta) - Math.abs(a.gdi_delta));

  return {
    total_pools:        ranked.length,
    rank_changed_count: changedRank.length,
    only_in_canonical:  onlyCanonical.map((r) => ({ pool_address: r.pool_address, pool_name: r.pool_name })),
    only_in_shadow:     onlyShadow.map((r) => ({ pool_address: r.pool_address, pool_name: r.pool_name })),
    top_rank_movers:    sortedByRank.slice(0, top),
    top_gdi_movers:     sortedByGdi.slice(0, top),
  };
}

// ── Field-aware normalisation for comparison only ──
// We don't normalise the VALUES that get reported back to the user — those
// are the raw strings out of each tree. We only normalise FOR COMPARISON so
// "Netherlands" vs "NL" or "AS24940" vs "24940" don't show up as
// "geo changed" when they're really the same. Mirrors src/lib/gdi/data-sources/merge-geo.ts.
const isoToName = (() => {
  try {
    const dn = new Intl.DisplayNames(['en'], { type: 'region' });
    return (s) => s.length === 2 ? (dn.of(s.toUpperCase()) ?? s).toLowerCase() : s.toLowerCase();
  } catch {
    return (s) => s.toLowerCase();
  }
})();
const normCountry = (s) => s == null ? null : isoToName(s.trim());
const normCity    = (s) => s == null ? null : s.trim().toLowerCase();
const normAsn     = (s) => s == null ? null : s.trim().replace(/^AS/i, '');
const normAsnName = (s) => s == null ? null : s.trim().toLowerCase();
const NORM = { country: normCountry, city: normCity, asn: normAsn, asn_name: normAsnName };

// ── Section 3: Validator-index diff ──────────────────────────────────────
function diffValidators(canonical, shadow, top) {
  const cMap = new Map(canonical.validatorIndex.validators.map((v) => [v.vote_pubkey, v]));
  const sMap = new Map(shadow.validatorIndex.validators.map((v) => [v.vote_pubkey, v]));

  const both = [...sMap.keys()].filter((k) => cMap.has(k));
  let geoChanged = 0;
  let geoChangedNormalised = 0;
  const fieldChanged          = { country: 0, city: 0, asn: 0, asn_name: 0 };
  const fieldChangedNormalised = { country: 0, city: 0, asn: 0, asn_name: 0 };
  const sourceMix = {
    country:  { override: 0, maxmind: 0, stakewiz: 0, 'validators-app': 0, none: 0 },
    city:     { override: 0, maxmind: 0, stakewiz: 0, 'validators-app': 0, none: 0 },
    asn:      { override: 0, maxmind: 0, stakewiz: 0, 'validators-app': 0, none: 0 },
    asn_name: { override: 0, maxmind: 0, stakewiz: 0, 'validators-app': 0, none: 0 },
  };
  const rankMovers = [];

  for (const pk of both) {
    const c = cMap.get(pk);
    const s = sMap.get(pk);

    // Per-field geo deltas: track raw (literal string diff) AND normalised
    // (after country ISO-2↔name expansion, AS-prefix stripping, case-fold).
    // Normalised is what matters for "real" geo changes; raw is mostly cosmetic.
    let anyFieldDiff = false;
    let anyFieldDiffNorm = false;
    for (const f of ['country', 'city', 'asn', 'asn_name']) {
      const cv = c[f] ?? null;
      const sv = s[f] ?? null;
      if (cv !== sv) {
        fieldChanged[f]++;
        anyFieldDiff = true;
      }
      if (NORM[f](cv) !== NORM[f](sv)) {
        fieldChangedNormalised[f]++;
        anyFieldDiffNorm = true;
      }
    }
    if (anyFieldDiff) geoChanged++;
    if (anyFieldDiffNorm) geoChangedNormalised++;

    // Source mix counts (shadow side only — `geo_sources` is shadow-only)
    const srcs = s.geo_sources ?? {};
    for (const f of ['country', 'city', 'asn', 'asn_name']) {
      const src = srcs[f] ?? 'none';
      sourceMix[f][src] = (sourceMix[f][src] ?? 0) + 1;
    }

    // Rank delta (canonical rank − shadow rank, positive = improved)
    if (c.rank != null && s.rank != null) {
      rankMovers.push({
        vote_pubkey: pk,
        identity_name: s.identity_name,
        canonical_geo: [c.country, c.city, c.asn].join(' / '),
        shadow_geo:    [s.country, s.city, s.asn].join(' / '),
        canonical_rank: c.rank,
        shadow_rank:    s.rank,
        rank_delta:     c.rank - s.rank,
        canonical_composite: c.composite_rarity,
        shadow_composite:    s.composite_rarity,
      });
    }
  }

  const sortedByRank = [...rankMovers]
    .filter((r) => r.rank_delta !== 0)
    .sort((a, b) => Math.abs(b.rank_delta) - Math.abs(a.rank_delta));

  // Source share-of-stake (more useful than count of validators —
  // a single big validator landing on override matters more than 50 tiny ones).
  const totalStakeByField = { country: 0, city: 0, asn: 0, asn_name: 0 };
  const stakeBySource = {
    country:  { override: 0, maxmind: 0, stakewiz: 0, 'validators-app': 0, none: 0 },
    city:     { override: 0, maxmind: 0, stakewiz: 0, 'validators-app': 0, none: 0 },
    asn:      { override: 0, maxmind: 0, stakewiz: 0, 'validators-app': 0, none: 0 },
    asn_name: { override: 0, maxmind: 0, stakewiz: 0, 'validators-app': 0, none: 0 },
  };
  for (const s of sMap.values()) {
    const stake = s.activated_stake_sol ?? 0;
    const srcs = s.geo_sources ?? {};
    for (const f of ['country', 'city', 'asn', 'asn_name']) {
      const src = srcs[f] ?? 'none';
      stakeBySource[f][src] += stake;
      totalStakeByField[f] += stake;
    }
  }
  const stakeShareBySource = {};
  for (const f of ['country', 'city', 'asn', 'asn_name']) {
    stakeShareBySource[f] = {};
    for (const src of Object.keys(stakeBySource[f])) {
      stakeShareBySource[f][src] = totalStakeByField[f] > 0
        ? stakeBySource[f][src] / totalStakeByField[f]
        : 0;
    }
  }

  return {
    active_canonical: canonical.validatorIndex.active_count,
    active_shadow:    shadow.validatorIndex.active_count,
    rankable_canonical: canonical.validatorIndex.rankable_count,
    rankable_shadow:    shadow.validatorIndex.rankable_count,
    median_composite_rarity: {
      canonical: canonical.validatorIndex.median_composite_rarity,
      shadow:    shadow.validatorIndex.median_composite_rarity,
      delta: (canonical.validatorIndex.median_composite_rarity != null && shadow.validatorIndex.median_composite_rarity != null)
        ? shadow.validatorIndex.median_composite_rarity - canonical.validatorIndex.median_composite_rarity
        : null,
    },
    geo_changed_count: geoChanged,
    geo_changed_count_normalised: geoChangedNormalised,
    geo_changed_by_field: fieldChanged,
    geo_changed_by_field_normalised: fieldChangedNormalised,
    source_mix_count: sourceMix,
    source_mix_stake_share: stakeShareBySource,
    top_rank_movers: sortedByRank.slice(0, top),
  };
}

// ── Output formatting ────────────────────────────────────────────────────
function fmtNum(n, d = 3) {
  if (n == null || Number.isNaN(n)) return '—';
  return n.toFixed(d);
}
function fmtPct(n, d = 1) {
  if (n == null || Number.isNaN(n)) return '—';
  return `${(n * 100).toFixed(d)}%`;
}
function fmtSignedNum(n, d = 3) {
  if (n == null || Number.isNaN(n)) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(d);
}
function fmtSignedInt(n) {
  if (n == null) return '—';
  return (n >= 0 ? '+' : '') + n;
}

function printText(diff) {
  const { network, pools, validators } = diff;

  console.log('═══ Network baseline ═══');
  if (network.epoch_canonical !== network.epoch_shadow) {
    console.log(`  ⚠ EPOCH MISMATCH: canonical=${network.epoch_canonical}, shadow=${network.epoch_shadow}`);
  } else {
    console.log(`  epoch:                ${network.epoch_canonical}`);
  }
  console.log(`  GDI:                  ${fmtNum(network.gdi.canonical)} → ${fmtNum(network.gdi.shadow)}  (${fmtSignedNum(network.gdi.delta)})`);
  console.log(`  DC country:           ${fmtNum(network.dc_country.canonical)} → ${fmtNum(network.dc_country.shadow)}  (${fmtSignedNum(network.dc_country.delta)})`);
  console.log(`  DC city:              ${fmtNum(network.dc_city.canonical)} → ${fmtNum(network.dc_city.shadow)}  (${fmtSignedNum(network.dc_city.delta)})`);
  console.log(`  DC asn:               ${fmtNum(network.dc_asn.canonical)} → ${fmtNum(network.dc_asn.shadow)}  (${fmtSignedNum(network.dc_asn.delta)})`);
  console.log(`  validator_count:      ${network.validator_count.canonical} → ${network.validator_count.shadow}  (${fmtSignedInt(network.validator_count.delta)})`);

  console.log('\n═══ Pool leaderboard ═══');
  console.log(`  tracked pools:        ${pools.total_pools}`);
  console.log(`  rank-changed:         ${pools.rank_changed_count}`);
  if (pools.only_in_canonical.length > 0) {
    console.log(`  only in canonical:    ${pools.only_in_canonical.map((p) => p.pool_name ?? p.pool_address.slice(0, 8)).join(', ')}`);
  }
  if (pools.only_in_shadow.length > 0) {
    console.log(`  only in shadow:       ${pools.only_in_shadow.map((p) => p.pool_name ?? p.pool_address.slice(0, 8)).join(', ')}`);
  }
  if (pools.top_rank_movers.length > 0) {
    console.log('\n  top rank movers (canonical → shadow):');
    for (const r of pools.top_rank_movers) {
      console.log(`    ${(r.pool_name ?? r.pool_address.slice(0, 8)).padEnd(14)}  #${String(r.canonical_rank).padStart(2)} → #${String(r.shadow_rank).padStart(2)}  (${fmtSignedInt(r.rank_delta)})  GDI ${fmtNum(r.canonical_gdi, 2)} → ${fmtNum(r.shadow_gdi, 2)}`);
    }
  }
  if (pools.top_gdi_movers.length > 0) {
    console.log('\n  top GDI movers:');
    for (const r of pools.top_gdi_movers) {
      console.log(`    ${(r.pool_name ?? r.pool_address.slice(0, 8)).padEnd(14)}  GDI ${fmtNum(r.canonical_gdi, 2)} → ${fmtNum(r.shadow_gdi, 2)}  (${fmtSignedNum(r.gdi_delta, 2)})  rank ${r.canonical_rank} → ${r.shadow_rank}`);
    }
  }

  console.log('\n═══ Validator index ═══');
  console.log(`  active:               ${validators.active_canonical} → ${validators.active_shadow}`);
  console.log(`  rankable:             ${validators.rankable_canonical} → ${validators.rankable_shadow}`);
  console.log(`  median composite:     ${fmtNum(validators.median_composite_rarity.canonical, 3)} → ${fmtNum(validators.median_composite_rarity.shadow, 3)}  (${fmtSignedNum(validators.median_composite_rarity.delta, 3)})`);
  console.log(`  validators with geo Δ:   ${validators.geo_changed_count} raw  /  ${validators.geo_changed_count_normalised} after normalisation`);
  console.log(`    country differs:    ${validators.geo_changed_by_field.country} raw  /  ${validators.geo_changed_by_field_normalised.country} real`);
  console.log(`    city differs:       ${validators.geo_changed_by_field.city} raw  /  ${validators.geo_changed_by_field_normalised.city} real`);
  console.log(`    asn differs:        ${validators.geo_changed_by_field.asn} raw  /  ${validators.geo_changed_by_field_normalised.asn} real`);
  console.log(`    (normalisation: ISO-2 ↔ country name; strip "AS" prefix; case-fold)`);

  console.log('\n  source mix (by validator count):');
  for (const f of ['country', 'city', 'asn']) {
    const m = validators.source_mix_count[f];
    const total = Object.values(m).reduce((a, b) => a + b, 0);
    console.log(`    ${f.padEnd(7)} override=${m.override}  maxmind=${m.maxmind}  stakewiz=${m.stakewiz}  validators-app=${m['validators-app']}  none=${m.none}  (n=${total})`);
  }

  console.log('\n  source mix (by share of active stake):');
  for (const f of ['country', 'city', 'asn']) {
    const m = validators.source_mix_stake_share[f];
    console.log(`    ${f.padEnd(7)} override=${fmtPct(m.override)}  maxmind=${fmtPct(m.maxmind)}  stakewiz=${fmtPct(m.stakewiz)}  validators-app=${fmtPct(m['validators-app'])}  none=${fmtPct(m.none)}`);
  }

  if (validators.top_rank_movers.length > 0) {
    console.log('\n  top validator rank movers (canonical → shadow):');
    for (const r of validators.top_rank_movers) {
      const name = ((r.identity_name && r.identity_name.trim()) || r.vote_pubkey.slice(0, 8)).slice(0, 30);
      console.log(`    ${name.padEnd(30)}  #${String(r.canonical_rank).padStart(4)} → #${String(r.shadow_rank).padStart(4)}  (${fmtSignedInt(r.rank_delta).padStart(5)})  ${r.canonical_geo}  →  ${r.shadow_geo}`);
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────
function main() {
  const opts = parseCli();
  const canonical = loadTree(opts.canonicalDir);
  const shadow    = loadTree(opts.shadowDir);

  if (canonical == null) {
    console.error(`error: canonical tree missing leaderboard-latest.json or validator-index.json at ${opts.canonicalDir}`);
    process.exit(2);
  }
  if (shadow == null) {
    console.error(`error: shadow tree missing leaderboard-latest.json or validator-index.json at ${opts.shadowDir}`);
    process.exit(2);
  }

  const diff = {
    generated_at: new Date().toISOString(),
    canonical_dir: opts.canonicalDir,
    shadow_dir:    opts.shadowDir,
    network:    diffNetwork(canonical, shadow),
    pools:      diffPools(canonical, shadow, opts.top),
    validators: diffValidators(canonical, shadow, opts.top),
  };

  if (opts.json) {
    console.log(JSON.stringify(diff, null, 2));
  } else {
    printText(diff);
  }
}

main();
