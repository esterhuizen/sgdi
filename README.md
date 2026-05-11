# Solana Stake Pool Decentralisation Index

A public, per-epoch leaderboard ranking Solana stake pools by **stake-weighted geographic decentralisation**. Live at [gdindex.app](https://gdindex.app).

The metric, the data, and the methodology are open. The numbers are independently reproducible from on-chain data and a small set of public APIs.

The score itself is called the **GDI** (Geographic Decentralisation Index). Current methodology version: **`gdi-1.1.0`** ([version history](https://gdindex.app/methodology#version-policy)).

## What it answers

> Which Solana stake pools are actually distributing stake across geographies, ASNs, and cities — and which are concentrating it?

For each pool, every Solana epoch (≈ 2–3 days), the index computes:

- **DC_country** — *Decentralisation Contribution* on country: stake-weighted average rarity of the countries the pool delegates to
- **DC_city** — same on cities
- **DC_ASN** — same on ASNs (network operators)
- **GDI** — geometric mean of the three (the headline number)

A **network baseline GDI** — the same formula applied to the entire actively-voting validator set — is computed each epoch and published at `/gdi/network-baseline.json` as a reference value.

The Stakewiz Network Impact Score (NIS) is a secondary signal — stake-weighted `wiz_score` across a pool's validators — and is shown on each pool's detail page, but is **not** mixed into the GDI itself. Decentralisation and operational quality are separate concerns and we keep them separate.

## For validators

Any operator can look up their own validator at **[gdindex.app/validator](https://gdindex.app/validator)** — search by vote pubkey, identity key, or validator name. The detail page shows:

- Composite rarity (geometric mean of country/city/ASN rarity)
- Network rank and percentile against the ~760 actively-voting validators
- Per-dimension breakdown: which dimensions strengthen the network, which reinforce concentration
- Which tracked pools currently delegate to that validator

This is the inverse of the leaderboard — pools look up the index to see how they rank; validators look up the index to see how they contribute.

## Why it exists

Stake concentration is a real risk to Solana — both at the validator and at the pool level. Most LST products compete on yield. This index exposes a different dimension: where, geographically and topologically, does each pool's stake actually live?

The methodology is named neutrally so it can credibly outlive any one publisher. It is initially built and maintained by Tielman ([@tielmane](https://x.com/tielmane) on X, [@realtielman](https://t.me/realtielman) on Telegram), with the explicit intent of handing stewardship to a neutral party (e.g. Stakewiz, Solana Compass, or the Solana Foundation) once the project has a track record. Repository is public, methodology is open, scores are reproducible — anyone can audit, fork, or run their own.

**Disclosure:** the maintainer also operates the [Definity](https://definity.finance) stake pool, which appears in this leaderboard. Scoring is mechanical and reproducible from public data — anyone can recompute a pool's GDI from the published methodology and raw inputs. The maintainer cannot privilege any one pool without that privilege being visible in the code and the published JSON.

## How to read the leaderboard

- **Default sort:** GDI descending. #1 is the pool whose validators sit in the most underweight country/city/ASN combinations in the current network.
- **Sub-score columns (country, city, ASN):** shown dim alongside the headline GDI. They're the three rarities the geometric mean composes.
- **Validators / Stake columns:** raw counts. Bigger validator set ≠ better GDI — a pool with 26 validators across rare cities can beat a 700-validator pool clustered in Frankfurt.
- **Below the table:** a single quiet line showing the network-wide average GDI for reference. The leaderboard ranks by GDI directly, not by deviation from baseline.

Click any pool name for the per-validator breakdown. Click any validator pubkey on the pool detail page to see that validator's individual rarity profile.

## Methodology in one screen

For each validator `v` in a pool with stake fraction `wᵥ` within the pool:

```
rarity_D(v)  =  -ln( network_share_D(category of v) )       D ∈ {country, city, ASN}

DC_D         =  Σᵥ wᵥ · rarity_D(v)                          stake-weighted avg rarity

GDI          =  ( DC_country · DC_city · DC_asn )^(1/3)      geometric mean
```

`network_share_D(category)` is the fraction of total active-voting stake currently delegated to validators in that category. A validator in NYC (popular) has a low rarity; a validator in Manila (underweight) has a high rarity. Pools with stake in rare places score higher.

The "active voting" set is defined as `!delinquent AND activated_stake > 0` — ~760 of ~1,955 Stakewiz records. Matches Solana's `getVoteAccounts.current` convention used by Stakewiz, Solana Beach, etc.

Geometric mean penalises being good on one dimension and poor on another — distinct decentralisation risk classes (a pool that's geographically diverse but everyone's on AWS still has a single-ASN failure mode).

Full methodology, sources, limitations, and version history at [gdindex.app/methodology](https://gdindex.app/methodology).

## Data sources

- **Helius RPC** — pool → validator → stake mapping (current epoch)
- **Stakewiz** — IP-derived validator country / city / ASN, activated stake, delinquency, `wiz_score`
- **Validators.app** — cross-reference + fallback for validator metadata
- **Jupiter LST token list** — name resolution for LST mints (used at watchlist discovery only)

Trust ordering: Stakewiz primary → Validators.app cross-reference → every disagreement logged.

## Project layout

```
sgdi/
├── README.md  CONTRIBUTING.md  LICENSE        Apache-2.0
├── package.json  next.config.js  tsconfig.json
├── scripts/
│   ├── gdi-ingest.ts            every 30 min — epoch detect + full pipeline
│   ├── gdi-publish.ts           SQLite → static JSON snapshot
│   ├── gdi-scenario.ts          what-if + optimisation CLI (per-pool stake plans)
│   └── gdi-watchdog.ts          heartbeat + staleness alerts (Telegram)
├── src/
│   ├── app/
│   │   ├── page.tsx             leaderboard landing
│   │   ├── pools/[address]/     per-pool detail
│   │   ├── validator/           validator search + per-validator detail
│   │   └── methodology/         the methodology page
│   ├── components/              UI (incl. hand-rolled SVG trend chart, theme toggle)
│   └── lib/gdi/
│       ├── data-sources/        rpc.ts · stakewiz.ts · validators-app.ts
│       ├── enrichment.ts        validator metadata refresh + dedup
│       ├── scoring.ts           PURE FUNCTION — rarity, DC, GDI, NIS
│       ├── scenario.ts          PURE — score & optimise a stake allocation
│       ├── storage.ts           thin SQLite repo (better-sqlite3, sync)
│       ├── telegram.ts          operational alerts (curl-via-execFile)
│       └── logger.ts            structured JSONL run logs
├── config/
│   └── pools-watchlist.json     top-20 SPL stake pools by TVL (manually curated)
├── deploy/                      systemd units, nginx vhost, deploy script
└── tests/
    ├── scoring.test.ts          pure-function unit tests for scoring
    └── scenario.test.ts         pure-function unit tests for the optimiser
```

## Running locally

```bash
cp .env.example .env
$EDITOR .env                       # add HELIUS_RPC_URL + VALIDATORS_APP_TOKEN
npm install
npm run ingest                     # capture current epoch (skips if already done)
npm run publish                    # generate public/gdi/*.json
npm run dev                        # http://localhost:3000
```

## Reproducing a published score

The index always captures the current Solana epoch, so the cleanest way to reproduce a published score is to run the pipeline yourself for the current epoch and compare against production:

```bash
git clone https://github.com/esterhuizen/sgdi.git && cd sgdi
npm install && cp .env.example .env && $EDITOR .env
npm run ingest                       # snapshot the current epoch into your SQLite
npm run publish                      # render to public/gdi/*.json
sqlite3 var/sgdi.db "select pool_address, gdi_composite from pool_scores where epoch = (select max(epoch) from pool_scores)"
```

The numbers you compute should match the corresponding entries on production at the same epoch (compare against [gdindex.app/gdi/leaderboard-latest.json](https://gdindex.app/gdi/leaderboard-latest.json)). If they don't, please [file an issue](https://github.com/esterhuizen/sgdi/issues) — that's a methodology drift we want to catch.

## Scenario / optimisation CLI

For pool operators: there's a CLI for what-if analysis and stake-allocation optimisation against the live GDI methodology.

```bash
# Show the current allocation + GDI score for a pool
npm run scenario -- --pool definity

# Find the best 20k SOL of stake redistribution this epoch
# (with operational constraints: 2k min / 30k max per validator, 3k max moved per validator)
npm run scenario -- --pool definity \
  --epoch-budget 20000 --min-stake 2000 --max-stake 30000 --max-move 3000
```

Used by Definity to plan its rarity-weighted allocation each epoch. Pure functions in [`src/lib/gdi/scenario.ts`](./src/lib/gdi/scenario.ts) — the same scoring logic the index uses, just running forward against trial allocations.

## Contributing

Methodology changes follow [CONTRIBUTING.md](./CONTRIBUTING.md) — tl;dr there's a versioned formula, bumping it is a deliberate process, and historical scores remain reproducible under their original version. The current `gdi-1.1.0` version-history is at [gdindex.app/methodology#version-policy](https://gdindex.app/methodology).

Operational improvements (better data sources, faster ingest, tighter UI) are welcome via PR. Open an issue first if it's a non-trivial change.

## License

Apache-2.0. See [LICENSE](./LICENSE).

---

Built and maintained by Tielman ([@tielmane](https://x.com/tielmane) on X, [@realtielman](https://t.me/realtielman) on Telegram). The methodology is named neutrally and the codebase is structured for handoff to a neutral steward (Stakewiz, Solana Compass, the Solana Foundation, or similar). Disclosure: the maintainer also operates the [Definity](https://definity.finance) stake pool, which appears in the leaderboard — see the README's "Why it exists" section for the full disclosure.
