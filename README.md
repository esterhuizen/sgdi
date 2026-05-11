# Solana Stake Pool Decentralisation Index

A public, per-epoch leaderboard ranking Solana stake pools by **stake-weighted geographic decentralisation**. Live at [gdindex.app](https://gdindex.app).

The metric, the data, and the methodology are open. The numbers are independently reproducible from on-chain data and a small set of public APIs.

The score itself is called the **GDI** (Geographic Decentralisation Index).

## What it answers

> Which Solana stake pools are actually distributing stake across geographies, ASNs, and cities — and which are concentrating it?

For each pool, every Solana epoch (≈ 2–3 days), the index computes:

- **DC_country** — *Decentralisation Contribution* on country: stake-weighted average rarity of the countries the pool delegates to
- **DC_city** — same on cities
- **DC_ASN** — same on ASNs (network operators)
- **GDI** — geometric mean of the three (the headline number)
- **Network Impact Score** — stake-weighted Stakewiz `wiz_score`, captures whether the pool delegates to validators that strengthen the network as a whole

5-epoch and 10-epoch rolling averages are shown alongside per-epoch numbers (per-epoch is noisy; rolling is the trustworthy signal).

A **network baseline GDI** — the same formula applied to the entire active validator set — is computed each epoch. **A pool above the baseline is preferentially delegating to less-popular places than the network average — directly reducing concentration. Below baseline = reinforcing already-popular spots.**

## Why it exists

Stake concentration is a real risk to Solana — both at the validator and at the pool level. Most LST products compete on yield. This index exposes a different dimension: where, geographically and topologically, does each pool's stake actually live?

The methodology is named neutrally so it can credibly outlive any one publisher. It is initially built and maintained by [@realtielman](https://t.me/realtielman), with the explicit intent of handing stewardship to a neutral party (e.g. Stakewiz, Solana Compass, or the Solana Foundation) once the project has a track record. Repository is public, methodology is open, scores are reproducible — anyone can audit, fork, or run their own.

**Disclosure:** the maintainer also operates the [Definity](https://definity.finance) stake pool, which appears in this leaderboard. Scoring is mechanical and reproducible from public data — anyone can recompute a pool's GDI from the published methodology and raw inputs. The maintainer cannot privilege any one pool without that privilege being visible in the code and the published JSON.

## How to read the leaderboard

- **Default sort**: composite GDI, descending. Click any sub-score column to re-sort.
- **Trend arrow**: 5-epoch rolling change. Up = decentralisation improving over recent epochs.
- **Network baseline line**: pools above it are improving network decentralisation; pools below are actively concentrating stake into already-popular validators.

## Methodology in one screen

For each validator `v` in a pool with stake fraction `wᵥ` within the pool:

```
rarity_D(v)  =  -ln( network_share_D(category of v) )       D ∈ {country, city, ASN}

DC_D         =  Σᵥ wᵥ · rarity_D(v)                          stake-weighted avg rarity

GDI          =  ( DC_country · DC_city · DC_asn )^(1/3)      geometric mean

NIS          =  Σᵥ wᵥ · stakewiz_wiz_score(v)                 network impact, secondary
```

`network_share_D(category)` is the fraction of total network stake currently delegated to validators in that category. A validator in NYC (popular) has a low rarity; a validator in Manila (underweight) has a high rarity. Pools with stake in rare places score higher.

Geometric mean penalises being good on one dimension and poor on another — distinct decentralisation risk classes (a pool that's geographically diverse but everyone's on AWS still has a single-ASN failure mode).

Full methodology, sources, limitations, and version history at [gdindex.app/methodology](https://gdindex.app/methodology).

## Data sources

- **Helius RPC** — pool → validator → stake mapping (current epoch)
- **Stakewiz** — IP-derived validator country / city / ASN, plus `wiz_score`
- **Validators.app** — cross-reference + fallback for validator metadata

Trust ordering: Stakewiz primary → Validators.app cross-reference → every disagreement logged.

## Project layout

```
sgdi/
├── README.md  CONTRIBUTING.md  LICENSE        Apache-2.0
├── package.json  next.config.js  tsconfig.json
├── scripts/
│   ├── gdi-ingest.mjs           every-30-min epoch detection + full pipeline
│   ├── gdi-publish.mjs          SQLite → static JSON snapshot
│   ├── gdi-backfill.mjs         one-shot: walk back N epochs at launch
│   └── gdi-daily-report.mjs     nightly digest from run logs
├── src/
│   ├── app/                     leaderboard, pool detail, methodology
│   ├── components/              UI (incl. hand-rolled SVG trend chart)
│   └── lib/gdi/
│       ├── data-sources/        rpc.ts · stakewiz.ts · validators-app.ts
│       ├── enrichment.ts        validator metadata refresh + dedup
│       ├── scoring.ts           PURE FUNCTION — eN, GDI, NIS
│       ├── storage.ts           thin SQLite repo (better-sqlite3, sync)
│       └── logger.ts            structured JSONL run logs
├── config/
│   └── pools-watchlist.json     manual additions to the auto-detected top-25
├── deploy/                      systemd units, nginx vhost
└── tests/
    ├── scoring.test.ts          pure-function unit tests
    └── e2e/known-epoch.test.ts  ingest a fixture, assert scores
```

## Running locally

```bash
cp .env.example .env
$EDITOR .env                       # add HELIUS_RPC_URL + VALIDATORS_APP_TOKEN
npm install
npm run ingest                     # capture current epoch (no-op if already)
npm run publish                    # generate public/gdi/*.json
npm run dev                        # http://localhost:3000
```

## Reproducing a published score

```bash
git clone https://github.com/esterhuizen/sgdi.git && cd sgdi
npm install && cp .env.example .env && $EDITOR .env
npm run backfill -- --epoch=850   # or whichever epoch
sqlite3 var/sgdi.db "select * from pool_scores where epoch = 850"
```

The number you compute should match the corresponding entry in `public/gdi/leaderboard-850.json` on production. If it doesn't, please [file an issue](https://github.com/esterhuizen/sgdi/issues) — that's a methodology drift we want to catch.

## Contributing

Methodology changes follow [CONTRIBUTING.md](./CONTRIBUTING.md) — tl;dr there's a versioned formula, bumping it is a deliberate process, and historical scores remain reproducible under their original version.

Operational improvements (better data sources, faster ingest, tighter UI) are welcome via PR. Open an issue first if it's a non-trivial change.

## License

Apache-2.0. See [LICENSE](./LICENSE).

---

Built and maintained by [@realtielman](https://t.me/realtielman). The methodology is named neutrally and the codebase is structured for handoff to a neutral steward (Stakewiz, Solana Compass, the Solana Foundation, or similar). Disclosure: the maintainer also operates the [Definity](https://definity.finance) stake pool, which appears in the leaderboard — see the README's "Why it exists" section for the full disclosure.
