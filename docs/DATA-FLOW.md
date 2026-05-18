# SGDI data flow — sources → metrics

Reference for which external source feeds each metric on the site. Companion
to [`MAINTENANCE.md`](./MAINTENANCE.md), which covers ops/deploy.

## Pipeline at a glance

```
                          ┌──────────────────────────────────────────┐
                          │   DATA SOURCES — refreshed every 30 min   │
                          └──────────────────────────────────────────┘

   ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐
   │   HELIUS / SOL    │  │     STAKEWIZ      │  │  VALIDATORS.APP   │
   │  Solana mainnet   │  │  api.stakewiz.com │  │    /api/v1/...    │
   ├───────────────────┤  ├───────────────────┤  ├───────────────────┤
   │ • getClusterNodes │  │ • wiz_score       │  │ • is_jito         │
   │   → version per   │  │ • geo (IP→city/   │  │ • datacenter      │
   │     identity pk   │  │     country/asn)  │  │ • software_client │
   │ • getEpochInfo    │  │ • identity_name   │  │   (BROKEN — not   │
   │ • stake-pool      │  │ • delinquent      │  │    used anymore)  │
   │   getProgramAcct  │  │ • activated_stake │  │ • geo (fallback)  │
   └─────────┬─────────┘  └─────────┬─────────┘  └─────────┬─────────┘
             │                      │                      │
   ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐
   │     IBRL API      │  │     BAM API       │  │   DOUBLEZERO      │
   │ explorer.bam.dev/ │  │ explorer.bam.dev/ │  │  ledger RPC (DZ   │
   │ api/v1/ibrl_vali. │  │ api/v1/validators │  │   mainnet-beta)   │
   ├───────────────────┤  ├───────────────────┤  ├───────────────────┤
   │ • ibrl_score 0-100│  │ • BAM-connected   │  │ • User accounts   │
   │   per identity pk │  │   IDENTITY pubkey │  │   on serviceabil. │
   │ • build_time,     │  │   set             │  │   program (borsh) │
   │   vote_packing,   │  │ • bam_node region │  │ • → set of active │
   │   non_vote_pack.. │  │                   │  │   DZ identity pks │
   └─────────┬─────────┘  └─────────┬─────────┘  └─────────┬─────────┘
             │                      │                      │
             └──────────┐  ┌────────┘                      │
                        ↓  ↓                               ↓

      ╔════════════════════════════════════════════════════════════════╗
      ║                  gdi-ingest.ts  (systemd timer)                ║
      ║                                                                ║
      ║  1. Pull all 6 sources in parallel.                            ║
      ║  2. enrichValidators():                                        ║
      ║       • country/city/asn:  Stakewiz primary, VA fallback       ║
      ║       • wiz_score:         Stakewiz                            ║
      ║       • ibrl_score:        IBRL (keyed by identity pk)         ║
      ║       • is_jito:           VA `jito` flag                      ║
      ║       • is_bam:            BAM identity set                    ║
      ║       • is_dz:             DoubleZero identity set             ║
      ║       • client_name:       classifyClient(version, is_jito,    ║
      ║                                           is_bam)              ║
      ║         → "Agave" / "Jito" / "BAM" / "Frankendancer" /         ║
      ║           "Firedancer" (5 buckets)                             ║
      ║  3. Upsert validators table with COALESCE → preserves last     ║
      ║     good value on per-source failure.                          ║
      ╚════════════════════════════╤═══════════════════════════════════╝
                                   ↓
                       ┌───────────────────────────┐
                       │   SQLite /var/lib/sgdi/   │
                       │          gdi.db           │
                       ├───────────────────────────┤
                       │ validators                │
                       │   ↳ geo, wiz_score,       │
                       │     ibrl_score, is_jito,  │
                       │     is_bam, is_dz,        │
                       │     client_name, version  │
                       │ pool_snapshots            │
                       │   ↳ stake per validator   │
                       │     per pool per epoch    │
                       │ pool_scores               │
                       │   ↳ GDI/NIS per pool      │
                       │ network_baseline          │
                       └─────────────┬─────────────┘
                                     ↓
      ╔════════════════════════════════════════════════════════════════╗
      ║                       gdi-publish.ts                           ║
      ║                                                                ║
      ║  • Per-pool client_distribution (stake-weighted):              ║
      ║      by_client[], jito_share, dz_share, bam_share              ║
      ║      effective_clients = exp(Shannon entropy of by_client)     ║
      ║  • Per-validator rarity:                                       ║
      ║      rarity = -ln(network_share)                               ║
      ║      composite = geomean(country, city, asn rarities)          ║
      ║  • Network baseline = same math, all active validators         ║
      ╚════════════════════════════╤═══════════════════════════════════╝
                                   ↓
       ┌─────────────────┬─────────┴──────────┬────────────────────┐
       ↓                 ↓                    ↓                    ↓
 ┌──────────────┐ ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐
 │ leaderboard- │ │  pools/X/    │  │  validator-  │  │  pools/X/        │
 │ latest.json  │ │  latest.json │  │  index.json  │  │  history.json    │
 └──────┬───────┘ └──────┬───────┘  └──────┬───────┘  └──────────────────┘
        │                │                 │
        ↓                ↓                 ↓
       /  (home)    /pools/<addr>    /validator/<x>
                                     /locations
```

## Metric → source mapping

| Metric (UI) | Page | DB column | Source |
|---|---|---|---|
| **GDI / NIS / pool rank** | `/`, `/pools` | `pool_scores` | snapshots × geo (Stakewiz/VA) |
| **Composite rarity** | `/`, `/locations`, `/validator` | derived in publish | `network_share_*` ← Stakewiz/VA geo |
| **Per-validator stake** | all | `activated_stake_lamports` | Stakewiz |
| **Country / City / ASN** | all | `country/city/asn` | Stakewiz primary, VA fallback |
| **Operator score** | `/locations`, `/validator` | `stakewiz_wiz_score` | **Stakewiz `wiz_score`** |
| **IBRL** | `/locations`, `/validator` | `ibrl_score` | **IBRL API** |
| **Client** (Agave/Jito/BAM/Frankendancer/Firedancer) | `/validator`, `/pools` `by_client` | `client_name` | **getClusterNodes version + is_jito + is_bam** |
| **client_version** | `/validator` | `client_version` | getClusterNodes |
| **is_jito flag** | `/pools` `jito_share`, `/validator` | `is_jito` | **validators.app `jito`** (only VA field still used) |
| **is_bam flag** | `/pools` `bam_share`, `/validator` | `is_bam` | **BAM API** |
| **is_dz flag** | `/pools` `dz_share`, `/locations` "On DZ", `/validator` pill | `is_dz` | **DoubleZero ledger** |
| **effective_clients** | `/pools` | derived in publish | Shannon entropy of `client_name` distribution |
| **datacenter** | `/validator` (via pool detail lookup) | `datacenter` | validators.app (unique to VA) |

## `classifyClient()` — 5-bucket client detection

```
input:   (version, is_jito, is_bam)
         from getClusterNodes / VA `jito` / BAM API

         version.startsWith("0.")?
           ├─ yes, minor ≥ 800  →  "Frankendancer"  (Jump hybrid; 0.820-0.999)
           └─ yes, minor < 800  →  "Firedancer"     (placeholder for pure FD)

         version is "2.x" / "3.x" / "4.x" (Agave-family)?
           ├─ is_bam   →  "BAM"   (BAM > Jito; more specific)
           ├─ is_jito  →  "Jito"
           └─ neither  →  "Agave"

         anything else  →  null
```

**Why BAM > Jito priority**: BAM-connected validators run a Jito-derived
stack, so `is_bam = true` implies `is_jito = true`. The more specific
label wins.

**HarmonicAgave / Rakurai / other vendor variants**: not distinguishable
from Anza Agave by version string alone. They collapse into "Agave",
"Jito", or "BAM" depending on operational flags. This is a deliberate
trade-off for accuracy over granularity — the prior validators.app
labels conflated software lineage with vendor branding.

## Failure handling

Every source has a per-source `.catch()` in `gdi-ingest.ts` that returns
`undefined` / `[]` on error. The `validators` table upsert uses COALESCE
across every column, so:

- A single bad fetch on **any one source** does NOT wipe the DB.
- The next successful cycle overwrites stale values.
- Per-cycle staleness is bounded at 30 minutes for healthy sources.

Persistent failures are visible in:

```
journalctl -u gdi-ingest -n 200 | grep -E 'fetch\.failed|warn'
```

Look for `doublezero.fetch.failed`, `bam.fetch.failed`,
`cluster_nodes.fetch.failed`, `ibrl.fetch.failed`,
`validators_app.fetch.failed`.

## Cadence

- `gdi-ingest.timer` fires every 30 min. Each cycle: ingest → publish.
- Next.js ISR `revalidate=60` — pages re-render within 60s of first
  request after a new publish.
- Worst-case staleness on UI: 30 min (ingest) + 60s (ISR) = ~31 min.

## Known caveats

- **validators.app `software_client` collapsed to "SolanaLabs"** since
  ~May 2026. We no longer read it. The `sgdi-patch-cdi.timer` workaround
  that grafted frozen client_distribution from `leaderboard-972.json` is
  now disabled (`systemctl disable --now sgdi-patch-cdi.timer`). Script
  and frozen snapshot remain on disk in case we ever need to re-enable.
- **DZ ledger RPC** uses a shared rpcpool.com token baked into the
  open-source DoubleZero CLI. If they rotate or rate-limit it, the
  `is_dz` column flat-lines (no error, just no fresh data). Mitigation:
  fall back to `fees_and_payments_consolidated.csv` from
  `doublezerofoundation/fees` (~14-day lag, 96.6% overlap).
- **DZ on-chain BGP status fields** exist in the User struct but are
  unpopulated on mainnet (all zeros). Can't be used for liveness check.
- **Unknown bucket** (currently ~19 validators / 0.2% stake): validators
  in our active set whose identity pubkey isn't in `getClusterNodes`
  at snapshot time. Usually transient (offline at the moment of gossip
  fetch). Next cycle resolves.
