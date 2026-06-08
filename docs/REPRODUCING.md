# Reproducing the GDI scores

The GDI is mechanical: one formula, applied to every pool, with no per-pool
privilege. This document gives a third party two ways to verify that — from
fastest/strongest to deepest.

The headline formula (`gdi-1.1.0`), for each validator `v` in a pool with
in-pool stake fraction `wᵥ`:

```
rarity_D(v) = -ln( network_share_D(category of v) )      D ∈ {country, city, ASN}
DC_D        = Σᵥ wᵥ · rarity_D(v)                         stake-weighted avg rarity
GDI         = ( DC_country · DC_city · DC_asn )^(1/3)     geometric mean
```

`network_share_D(category)` is that category's fraction of total **active-voting**
stake (`!delinquent AND activated_stake > 0`). The whole thing lives in one pure,
side-effect-free file: [`src/lib/gdi/scoring.ts`](../src/lib/gdi/scoring.ts).

---

## Level 1 — Verify the scoring (1 minute, zero credentials)

This is the strongest fairness proof and needs **no API keys, no MaxMind license,
and no database**. Every input the score consumes is already in the published
JSON, including the geo classification per validator (each value tagged with its
`geo_sources`: `maxmind` / `override` / `stakewiz`).

```bash
git clone https://github.com/esterhuizen/sgdi.git && cd sgdi
npm install
npm run verify
```

`npm run verify` ([`scripts/gdi-verify.ts`](../scripts/gdi-verify.ts)):

1. Rebuilds the network rarity denominator (stake share per country / city / ASN)
   from `validators.json` — the published active-voting set.
2. Recomputes `DC_country/city/asn` and the composite GDI for **every pool on the
   leaderboard** from that pool's published validator list, and compares to the
   published GDI.
3. Cross-checks every published per-validator rarity (`r_country/r_city/r_asn`)
   against `-ln(network_share)`.
4. Recomputes the network-baseline GDI and compares it.

It imports the **exact** scoring functions the live pipeline uses, so there is no
re-implementation drift — if any number had been hand-tuned for any pool, the
check would fail. Expected output ends with:

```
PASS — N pools, 0 GDI mismatches (max Δ=0.00e+0), 0 rarity mismatches
```

To pin a specific deployment or mirror, set `GDI_BASE_URL` (default
`https://gdindex.app`):

```bash
GDI_BASE_URL=https://gdindex.app npm run verify
```

What Level 1 proves: the published ranking is a deterministic function of the
published inputs, applied uniformly. The maintainer operates one of the ranked
pools (Definity / definSOL) and cannot privilege it without that showing up here.

---

## Level 2 — Audit the inputs (optional, deeper)

Level 1 takes the published per-validator geo + stake as given. To independently
check **those inputs**, re-derive them from source:

- **Pool → validator → stake** (the `stake_sol` per validator in each
  `pools/<addr>/latest.json`): read the stake-pool accounts on-chain via any
  Solana RPC for the same epoch. This is fully public.
- **Active-set stake + delinquency** (`validators.json`): `getVoteAccounts` from
  any RPC, or the Stakewiz API.
- **Validator geo** (`country` / `city` / `asn`): resolve each validator's gossip
  IP to a location. Production uses `override > MaxMind > Stakewiz`, recorded
  per-field in `geo_sources`:
  - `stakewiz` values are reproducible from the public Stakewiz API.
  - `maxmind` values require a MaxMind GeoLite2/GeoIP2 database (free GeoLite2
    account, or paid). Because MaxMind cannot be redistributed, these are the one
    input that needs the verifier's own license; spot-check any validator's IP
    against your own MaxMind lookup.
  - `override` values are manual corrections where every geo source was wrong
    (e.g. a validator IP that geolocates to the registrar's HQ, not the rack).
    The full override list is in the `validator_geo_overrides` table and is
    exported on request.

Any disagreement between your re-derived inputs and the published ones is exactly
the kind of thing to [file an issue](https://github.com/esterhuizen/sgdi/issues)
about — input provenance is meant to be auditable.

---

## Notes

- Scores always describe the **current** epoch. The leaderboard exposes
  `leaderboard-<epoch>.json` for history; `npm run verify` checks the latest.
- The pure scoring functions have unit tests: `npm test`.
- License: Apache-2.0. Fork it, run your own, or re-derive by hand — all three
  should land on the same numbers.
