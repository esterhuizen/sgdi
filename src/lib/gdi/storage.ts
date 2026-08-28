// SQLite repository over better-sqlite3.
//
// All SQL lives in this module. Nothing else in the codebase touches the DB
// or writes raw SQL. Synchronous on purpose — better-sqlite3 is sync by design,
// embracing it removes a layer of async ceremony with zero perf cost at our scale.
//
// Schema is defined inline below. The first-time `init()` creates everything;
// subsequent calls are no-ops (CREATE IF NOT EXISTS). Future schema changes
// land via additive ALTER TABLE statements in a small migrations array.

import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULT_DB_PATH = process.env.SGDI_DB_PATH || './var/sgdi.db';

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS epochs (
  epoch_number INTEGER PRIMARY KEY,
  started_at   INTEGER,
  ended_at     INTEGER,
  ingested_at  INTEGER
);

CREATE TABLE IF NOT EXISTS pools (
  pool_address    TEXT PRIMARY KEY,
  pool_name       TEXT,
  pool_token_mint TEXT,
  pool_program    TEXT,
  is_tracked      INTEGER NOT NULL DEFAULT 1,
  added_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS validators (
  validator_pubkey            TEXT PRIMARY KEY,
  identity_pubkey             TEXT,
  identity_name               TEXT,
  country                     TEXT,
  city                        TEXT,
  asn                         TEXT,
  asn_name                    TEXT,
  datacenter                  TEXT,
  country_source              TEXT,
  city_source                 TEXT,
  asn_source                  TEXT,
  metadata_refreshed_at       INTEGER,
  stakewiz_wiz_score          REAL,
  stakewiz_city_concentration REAL,
  stakewiz_asn_concentration  REAL,
  stakewiz_refreshed_at       INTEGER,
  activated_stake_lamports    INTEGER,
  delinquent                  INTEGER,
  image_url                   TEXT
);

-- Forward-migration: existing installs need these columns added.
-- SQLite ignores duplicate-column errors via the catch in the migration runner.

CREATE TABLE IF NOT EXISTS pool_snapshots (
  epoch            INTEGER NOT NULL,
  pool_address     TEXT    NOT NULL,
  validator_pubkey TEXT    NOT NULL,
  stake_lamports   INTEGER NOT NULL,
  captured_at      INTEGER NOT NULL,
  PRIMARY KEY (epoch, pool_address, validator_pubkey)
);
CREATE INDEX IF NOT EXISTS idx_snapshots_epoch_pool ON pool_snapshots(epoch, pool_address);
CREATE INDEX IF NOT EXISTS idx_snapshots_validator   ON pool_snapshots(validator_pubkey);

CREATE TABLE IF NOT EXISTS pool_scores (
  epoch                INTEGER NOT NULL,
  pool_address         TEXT    NOT NULL,
  dc_country           REAL,
  dc_city              REAL,
  dc_asn               REAL,
  gdi_composite        REAL,
  network_impact_score REAL,
  placement_coverage   REAL,
  validator_count      INTEGER,
  total_stake_lamports INTEGER,
  computed_at          INTEGER NOT NULL,
  methodology_version  TEXT    NOT NULL,
  PRIMARY KEY (epoch, pool_address)
);
CREATE INDEX IF NOT EXISTS idx_scores_pool_epoch ON pool_scores(pool_address, epoch);

CREATE TABLE IF NOT EXISTS network_baseline (
  epoch                INTEGER PRIMARY KEY,
  dc_country           REAL,
  dc_city              REAL,
  dc_asn               REAL,
  gdi_composite        REAL,
  validator_count      INTEGER,
  total_stake_lamports INTEGER,
  computed_at          INTEGER NOT NULL,
  methodology_version  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS ingestion_runs (
  run_id          TEXT PRIMARY KEY,
  epoch           INTEGER NOT NULL,
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER,
  status          TEXT    NOT NULL,
  pools_processed INTEGER,
  pools_failed    INTEGER,
  notes           TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_epoch ON ingestion_runs(epoch, started_at);

-- Per-epoch frozen snapshot of the network's stake distribution across
-- each location dimension. Enables post-mortems of cross-epoch GDI swings
-- ("which buckets gained / lost stake between epoch N-1 and N?") without
-- depending on external historical data. ~600 rows per epoch.
CREATE TABLE IF NOT EXISTS network_shares (
  epoch           INTEGER NOT NULL,
  dimension       TEXT    NOT NULL,   -- 'country' | 'city' | 'asn'
  bucket          TEXT    NOT NULL,   -- e.g. 'United States', 'Frankfurt', '20473'
  share           REAL    NOT NULL,   -- 0..1 fraction of placeable network stake
  validator_count INTEGER NOT NULL,
  computed_at     INTEGER NOT NULL,
  PRIMARY KEY (epoch, dimension, bucket)
);
CREATE INDEX IF NOT EXISTS idx_network_shares_epoch ON network_shares(epoch);
CREATE INDEX IF NOT EXISTS idx_network_shares_dim_bucket ON network_shares(dimension, bucket);

-- Shadow IP→geo answers from the locally-hosted MaxMind pipeline, captured
-- per-validator per-epoch alongside whatever canonical (Stakewiz/VA-derived)
-- thought at the same epoch. Powers a side-by-side comparison while we
-- evaluate whether MaxMind is good enough to promote to canonical.
--
-- Nothing in the live scoring path reads this table. See scripts/gdi-ingest.ts
-- for the write site (separate pass after the canonical enrichment).
CREATE TABLE IF NOT EXISTS validator_geo_shadow (
  epoch                INTEGER NOT NULL,
  validator_pubkey     TEXT    NOT NULL,
  ip_used              TEXT,             -- the IP we looked up (gossip preferred, then tpu)

  -- Shadow side
  shadow_country       TEXT,
  shadow_city          TEXT,
  shadow_asn           TEXT,
  shadow_asn_name      TEXT,

  -- Snapshot of canonical at this epoch (for diff without a join later)
  canonical_country    TEXT,
  canonical_city       TEXT,
  canonical_asn        TEXT,
  canonical_asn_name   TEXT,

  -- Precomputed agreement flags: 1 = match, 0 = mismatch, NULL = one side null.
  -- Lets the comparison CLI do aggregate queries in O(rows) without
  -- recomputing string compares.
  country_match        INTEGER,
  city_match           INTEGER,
  asn_match            INTEGER,

  computed_at          INTEGER NOT NULL,
  PRIMARY KEY (epoch, validator_pubkey)
);
CREATE INDEX IF NOT EXISTS idx_geo_shadow_epoch ON validator_geo_shadow(epoch);
CREATE INDEX IF NOT EXISTS idx_geo_shadow_mismatch ON validator_geo_shadow(epoch, country_match, city_match, asn_match);

-- Operator-supplied corrections for cases where automated geo lookup
-- (MaxMind / Stakewiz / VA) gets the answer wrong. Partial overrides
-- are supported — any combination of country/city/asn may be set, and
-- a NULL field means "no override on this dimension, fall through".
--
-- Initially these only affect the shadow computation in validator_geo_shadow
-- (helps us evaluate the override workflow without changing live scoring).
-- Promotion of overrides into the canonical pipeline (pickField in
-- enrichment.ts) is a separate, single-line change down the line.
CREATE TABLE IF NOT EXISTS validator_geo_overrides (
  validator_pubkey TEXT PRIMARY KEY,
  country          TEXT,       -- nullable: partial overrides supported
  city             TEXT,
  asn              TEXT,
  asn_name         TEXT,
  reason           TEXT NOT NULL,   -- mandatory rationale
  source_evidence  TEXT,            -- optional URL / chat ref / email
  added_at         INTEGER NOT NULL,
  added_by         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_overrides_added_at ON validator_geo_overrides(added_at);

-- Parallel scoring tables for the MaxMind-driven shadow pipeline.
-- These mirror pool_scores / network_baseline / network_shares EXACTLY,
-- just populated from a different geo source mix: override > maxmind >
-- stakewiz > validators-app, per dimension. The canonical pipeline is
-- unchanged; the shadow pipeline writes here so we can render and compare
-- both worlds side-by-side without touching live production scoring.
--
-- Schema is intentionally identical to the canonical tables so the same
-- scoring.ts functions populate either one with no per-column drift.
-- When we promote MaxMind to canonical, these tables retire cleanly.
CREATE TABLE IF NOT EXISTS pool_scores_shadow (
  epoch                  INTEGER NOT NULL,
  pool_address           TEXT    NOT NULL,
  dc_country             REAL,
  dc_city                REAL,
  dc_asn                 REAL,
  gdi_composite          REAL,
  network_impact_score   REAL,
  placement_coverage     REAL,
  validator_count        INTEGER,
  total_stake_lamports   INTEGER,
  computed_at            INTEGER NOT NULL,
  methodology_version    TEXT    NOT NULL,
  PRIMARY KEY (epoch, pool_address)
);
CREATE INDEX IF NOT EXISTS idx_pool_scores_shadow_pool ON pool_scores_shadow(pool_address, epoch DESC);

CREATE TABLE IF NOT EXISTS network_baseline_shadow (
  epoch                INTEGER PRIMARY KEY,
  dc_country           REAL,
  dc_city              REAL,
  dc_asn               REAL,
  gdi_composite        REAL,
  validator_count      INTEGER,
  total_stake_lamports INTEGER,
  computed_at          INTEGER NOT NULL,
  methodology_version  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS network_shares_shadow (
  epoch           INTEGER NOT NULL,
  dimension       TEXT    NOT NULL,
  bucket          TEXT    NOT NULL,
  share           REAL    NOT NULL,
  validator_count INTEGER NOT NULL,
  computed_at     INTEGER NOT NULL,
  PRIMARY KEY (epoch, dimension, bucket)
);
CREATE INDEX IF NOT EXISTS idx_network_shares_shadow_epoch ON network_shares_shadow(epoch);
CREATE INDEX IF NOT EXISTS idx_network_shares_shadow_dim_bucket ON network_shares_shadow(dimension, bucket);

-- Continuously-refreshed per-validator geo with flap suppression. Written every
-- ingest tick (~15 min) by src/lib/gdi/geo-live.ts on BOTH the full-ingest and
-- the settled skip path. NO epoch column: current state, not a per-epoch
-- photograph (that is validator_geo_shadow). stable_* is the tuple money is
-- allowed to read; raw_* is the last observation, possibly a flap in progress.
--
-- INVARIANT (consumers rely on it): the stable tuple is written ATOMICALLY per
-- row and is consumed WHOLE — a consumer takes this row's stable_* tuple entire
-- (nulls included; partial tuples are legitimate: MaxMind can resolve ASN
-- without City) or falls back to the validator's whole frozen shadow row.
-- Per-dimension mixing across tiers is forbidden.
--
-- The debouncer treats NULL as a value: (HK, Hong Kong, AS46873) ->
-- (HK, NULL, AS46873) is a candidate transition and debounces like any other.
CREATE TABLE IF NOT EXISTS validator_geo_live (
  validator_pubkey     TEXT PRIMARY KEY,   -- VOTE account (same key as validator_geo_shadow)

  -- Last raw observation, canonicalised. NULL = no usable lookup this tick.
  raw_country          TEXT,
  raw_city             TEXT,
  raw_asn              TEXT,               -- "AS46873" (canonical form)
  raw_asn_name         TEXT,
  ip_used              TEXT,               -- gossip ?? tpu, port stripped. NEVER published to JSON.

  -- Promoted (stable) tuple — the value downstream consumers read.
  stable_country       TEXT,
  stable_city          TEXT,
  stable_asn           TEXT,
  stable_asn_name      TEXT,
  stable_since         INTEGER,            -- unix s: promotion/bootstrap time of the current stable tuple
  stable_observations  INTEGER NOT NULL DEFAULT 0,  -- counted obs agreeing with stable_*

  -- Pending change. cand_count = 0 ⇒ no pending change.
  cand_country         TEXT,
  cand_city            TEXT,
  cand_asn             TEXT,
  cand_asn_name        TEXT,
  cand_count           INTEGER NOT NULL DEFAULT 0,  -- counted obs agreeing with cand_*
  cand_first_seen      INTEGER,

  -- Observation bookkeeping
  first_observed_at    INTEGER NOT NULL,
  last_observed_at     INTEGER NOT NULL,   -- last tick this row was processed at all
  last_counted_at      INTEGER,            -- last tick an observation COUNTED toward the machine
  last_present_at      INTEGER,            -- last tick with a non-empty lookup
  missing_streak       INTEGER NOT NULL DEFAULT 0,
  bootstrap_source     TEXT                -- 'shadow-seed' | 'first-observation' | NULL
);
CREATE INDEX IF NOT EXISTS idx_geo_live_moving  ON validator_geo_live(cand_count);
CREATE INDEX IF NOT EXISTS idx_geo_live_present ON validator_geo_live(last_present_at);

-- One-row pass state. last_tick_at is THE freshness signal for every consumer;
-- it is the TICK time, never a publish time (a stalled writer whose consumer
-- re-stamps its output is invisible — the LIVE-TARGETS.md lesson).
--
-- The row is written ONLY when the tick cleared its stamp gate, and that gate
-- is measured against with_ip_count, NOT observed_count. Only ~688 of the
-- ~2,656 fleet validators advertise a resolvable gossip endpoint at all
-- (measured, stable across 46 epochs), so present/observed sits near 0.26
-- permanently and a gate on it would never stamp — the pass would look
-- perpetually broken. The two counts answer two different questions:
--   present / with_ip  →  "is MaxMind resolving what we can actually see?"
--                         (688/688 at epoch 1023)
--   with_ip            →  "did getClusterNodes degrade?" — a partial RPC
--                         return of 200 endpoints must not stamp even if all
--                         200 resolve perfectly.
CREATE TABLE IF NOT EXISTS geo_live_meta (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  last_tick_at       INTEGER NOT NULL,
  epoch              INTEGER,
  observed_count     INTEGER NOT NULL,
  with_ip_count      INTEGER NOT NULL DEFAULT 0,  -- observed validators carrying a gossip/TPU endpoint
  present_count      INTEGER NOT NULL,
  moving_count       INTEGER NOT NULL,
  promoted_count     INTEGER NOT NULL,
  bootstrapped_count INTEGER NOT NULL DEFAULT 0,
  mass_change_pct    REAL    NOT NULL,     -- 100 * promoted_count / max(1, present_count), PER TICK
  -- NOTE: the operational alert on promotions is the events-table rate check in
  -- gdi-watchdog (hourly sampling of this column misses most 15-min spikes);
  -- this stays as the per-tick record.
  city_mmdb_mtime_ms INTEGER,
  asn_mmdb_mtime_ms  INTEGER,
  stable_k           INTEGER NOT NULL,     -- K in force at this tick
  stable_min_dwell_s INTEGER NOT NULL
);

-- Append-only transition log. Sizes K empirically: candidate_abandoned.dwell_s
-- IS the flap-duration histogram, and K cannot be derived from
-- validator_geo_shadow (one capture per ~46h epoch, so a 5-minute flap and a
-- 2-day move are indistinguishable there).
--
-- Deliberately NO ip_used column: this table would otherwise ship in the
-- publicly-served gdi-snapshot.db as a per-validator IP-transition history.
CREATE TABLE IF NOT EXISTS validator_geo_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  at               INTEGER NOT NULL,
  validator_pubkey TEXT    NOT NULL,
  kind             TEXT    NOT NULL,  -- 'raw_change'|'promote'|'candidate_abandoned'|'missing'|'reappeared'|'bootstrap'
  from_country     TEXT, from_city TEXT, from_asn TEXT,
  to_country       TEXT, to_city   TEXT, to_asn   TEXT,
  cand_count       INTEGER,
  dwell_s          INTEGER,
  epoch            INTEGER
);
CREATE INDEX IF NOT EXISTS idx_geo_events_at  ON validator_geo_events(at);
CREATE INDEX IF NOT EXISTS idx_geo_events_val ON validator_geo_events(validator_pubkey, at);
`;

// ───────────────────────────────────────────────────────────────────────────
// Types (mirror the schema; small, hand-rolled, no codegen)
// ───────────────────────────────────────────────────────────────────────────

export type Pool = {
  pool_address: string;
  pool_name: string | null;
  pool_token_mint: string | null;
  pool_program: string | null;
  is_tracked: number;
  added_at: number;
};

export type ValidatorRow = {
  validator_pubkey: string;
  identity_pubkey: string | null;
  identity_name: string | null;
  country: string | null;
  city: string | null;
  asn: string | null;
  asn_name: string | null;
  datacenter: string | null;
  country_source: string | null;
  city_source: string | null;
  asn_source: string | null;
  metadata_refreshed_at: number | null;
  stakewiz_wiz_score: number | null;
  stakewiz_city_concentration: number | null;
  stakewiz_asn_concentration: number | null;
  stakewiz_refreshed_at: number | null;
  activated_stake_lamports: number | null;
  delinquent: number | null;       // 0 / 1; null = unknown
  image_url: string | null;
  // Client diversity. client_name + client_version now derived from
  // getClusterNodes (Solana RPC) instead of validators.app — covers 100% of
  // gossip-visible validators and is unaffected by VA's label collapse.
  client_name: string | null;      // "Agave" / "Jito" / "BAM" (v2/v3) | "Agave v4" / "Jito v4" / "BAM v4" (vN for N≥4) | "Frankendancer" / "Firedancer" (build < 40000) | "Frankendancer v4" / "Firedancer v4" (build ≥ 40000, vN follows the build number) | null
  client_version: string | null;   // raw version string from gossip
  is_jito: number | null;          // 0 / 1; null = unknown
  is_dz: number | null;            // 0 / 1; null = unknown — DoubleZero network participation
  is_bam: number | null;           // 0 / 1; null = unknown — BAM (Jito Block Assembly Marketplace) participation
  // IBRL block-build quality score (Jito explorer.bam.dev). 0-100, null when
  // the validator hasn't produced blocks in the current epoch.
  ibrl_score: number | null;
};

export type PoolSnapshot = {
  epoch: number;
  pool_address: string;
  validator_pubkey: string;
  /** Active stake on the validator's stake account at snapshot time (lamports). */
  stake_lamports: bigint;
  /** SPL stake pool transient stake — in-flight increase or decrease that
   *  settles at the next epoch boundary. NULL on rows pre-dating the
   *  migration. 0 means "no in-flight move". */
  transient_stake_lamports: bigint | null;
  /** SPL stake pool ValidatorStakeInfo.status byte:
   *    0 = Active            (transient>0 means an IncreaseValidatorStake is in flight)
   *    1 = DeactivatingTransient (transient is a DecreaseValidatorStake in flight)
   *    2 = ReadyForRemoval
   *    3 = DeactivatingValidator
   *    4 = DeactivatingAll
   *  NULL on rows pre-dating the migration. */
  validator_status: number | null;
  /** Epoch in which the pool last cranked this entry's stake fields. Lower than
   *  the snapshot's own epoch ⇒ stake_lamports is a pre-crank photo and the
   *  stake is still sitting in transient. NULL on rows pre-dating the migration. */
  last_update_epoch: number | null;
  captured_at: number;
};

export type PoolScore = {
  epoch: number;
  pool_address: string;
  dc_country: number | null;
  dc_city: number | null;
  dc_asn: number | null;
  gdi_composite: number | null;
  network_impact_score: number | null;
  placement_coverage: number | null;
  validator_count: number | null;
  total_stake_lamports: bigint | null;
  computed_at: number;
  methodology_version: string;
};

export type NetworkBaseline = {
  epoch: number;
  dc_country: number | null;
  dc_city: number | null;
  dc_asn: number | null;
  gdi_composite: number | null;
  validator_count: number | null;
  total_stake_lamports: bigint | null;
  computed_at: number;
  methodology_version: string;
};

export type IngestionRun = {
  run_id: string;
  epoch: number;
  started_at: number;
  finished_at: number | null;
  status: 'success' | 'partial' | 'failed' | 'in_progress';
  pools_processed: number | null;
  pools_failed: number | null;
  notes: string | null;
};

export type NetworkShareRow = {
  epoch: number;
  dimension: 'country' | 'city' | 'asn';
  bucket: string;
  share: number;
  validator_count: number;
  computed_at: number;
};

export type ValidatorGeoOverrideRow = {
  validator_pubkey: string;
  country: string | null;
  city: string | null;
  asn: string | null;
  asn_name: string | null;
  reason: string;
  source_evidence: string | null;
  added_at: number;
  added_by: string;
};

export type ValidatorGeoShadowRow = {
  epoch: number;
  validator_pubkey: string;
  ip_used: string | null;
  shadow_country: string | null;
  shadow_city: string | null;
  shadow_asn: string | null;
  shadow_asn_name: string | null;
  canonical_country: string | null;
  canonical_city: string | null;
  canonical_asn: string | null;
  canonical_asn_name: string | null;
  // 1 / 0 / null — null when one side is null (we can't really call match/mismatch)
  country_match: number | null;
  city_match: number | null;
  asn_match: number | null;
  computed_at: number;
};

/** One row of validator_geo_live — the debounced live-geo state machine's
 *  per-validator state. Written whole on every tick (see geo-live.ts). */
export type ValidatorGeoLiveRow = {
  validator_pubkey: string;
  raw_country: string | null;
  raw_city: string | null;
  raw_asn: string | null;
  raw_asn_name: string | null;
  /** Gossip (or TPU) IP, port stripped. Never leaves the DB — see geo-live.ts. */
  ip_used: string | null;
  stable_country: string | null;
  stable_city: string | null;
  stable_asn: string | null;
  stable_asn_name: string | null;
  stable_since: number | null;
  stable_observations: number;
  cand_country: string | null;
  cand_city: string | null;
  cand_asn: string | null;
  cand_asn_name: string | null;
  cand_count: number;
  cand_first_seen: number | null;
  first_observed_at: number;
  last_observed_at: number;
  last_counted_at: number | null;
  last_present_at: number | null;
  missing_streak: number;
  bootstrap_source: string | null;
};

/** The single geo_live_meta row (id = 1). */
export type GeoLiveMetaRow = {
  id: number;
  last_tick_at: number;
  epoch: number | null;
  observed_count: number;
  with_ip_count: number;
  present_count: number;
  moving_count: number;
  promoted_count: number;
  bootstrapped_count: number;
  mass_change_pct: number;
  city_mmdb_mtime_ms: number | null;
  asn_mmdb_mtime_ms: number | null;
  stable_k: number;
  stable_min_dwell_s: number;
};

/** An append-only validator_geo_events row. `id` is assigned by SQLite. */
export type ValidatorGeoEventRow = {
  at: number;
  validator_pubkey: string;
  kind: 'raw_change' | 'promote' | 'candidate_abandoned' | 'missing' | 'reappeared' | 'bootstrap';
  from_country: string | null;
  from_city: string | null;
  from_asn: string | null;
  to_country: string | null;
  to_city: string | null;
  to_asn: string | null;
  cand_count: number | null;
  dwell_s: number | null;
  epoch: number | null;
};

// ───────────────────────────────────────────────────────────────────────────
// Repo
// ───────────────────────────────────────────────────────────────────────────

export type Storage = ReturnType<typeof openStorage>;

export function openStorage(dbPath: string = DEFAULT_DB_PATH, opts: { readonly?: boolean } = {}) {
  // Read-only mode is for analysis tools (e.g. gdi-scenario) that should
  // never mutate the DB and may be invoked by users without write access
  // to the data directory.
  if (!opts.readonly) {
    mkdirSync(dirname(dbPath), { recursive: true });
  } else {
    // Even readonly callers need the schema migration to have happened —
    // prepared statements at the bottom of this function reference tables
    // that may not exist yet on a DB where no writable open has run since
    // the last schema bump. Best-effort: open writable, run the idempotent
    // migration, close. If the caller doesn't have write access we silently
    // skip — the prepare step will then fail on missing tables, which is the
    // same outcome as before.
    try {
      const migrationDb = new Database(dbPath, {});
      migrationDb.exec(SCHEMA_SQL);
      migrationDb.close();
    } catch {
      // No write access — proceed readonly; older tables still work.
    }
  }
  const db: Db = new Database(dbPath, opts.readonly ? { readonly: true } : {});
  if (!opts.readonly) {
    db.exec(SCHEMA_SQL);

    // Forward migrations for additive columns on the validators table.
    // SQLite has no IF NOT EXISTS on ALTER TABLE ADD COLUMN, so we catch
    // the "duplicate column" error on already-migrated installs. Cheap and
    // idempotent.
    const addColumn = (table: string, col: string, decl: string) => {
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
      } catch (e) {
        const msg = (e as Error).message || '';
        if (!/duplicate column name/i.test(msg)) throw e;
      }
    };
    addColumn('validators', 'identity_pubkey',          'TEXT');
    addColumn('validators', 'activated_stake_lamports', 'INTEGER');
    addColumn('validators', 'delinquent',               'INTEGER');
    // Consecutive raw delinquent=true samples from the source. The effective
    // `delinquent` flag only flips to 1 after FOUR consecutive samples (~1h at
    // the 15-min ingest cadence); recovery is immediate on one healthy sample.
    // A single bad Stakewiz sample on 2026-06-10 (13.4M-SOL validator briefly
    // flagged) emptied its ASN bucket from the active set and inflated its
    // pools' GDI by +106% for one publish cycle — this hysteresis stops that
    // class of blip from ever reaching scoring.
    //
    // The threshold counts SAMPLES, not time, so it has to be re-derived every
    // time gdi-ingest.timer changes cadence: it was 2 while the timer fired
    // every 30 min, and became 4 when the settle gate moved the timer to 15.
    addColumn('validators', 'delinquent_raw_streak',    'INTEGER');
    addColumn('validators', 'image_url',                'TEXT');
    // gdi-1.2 phase 1 — client diversity + operational columns. Additive;
    // existing installs migrate forward, fields stay null until next ingest fills them.
    addColumn('validators', 'client_name',              'TEXT');
    addColumn('validators', 'client_version',           'TEXT');
    addColumn('validators', 'is_jito',                  'INTEGER');
    addColumn('validators', 'is_dz',                    'INTEGER');
    // IBRL block-build quality score (Jito) — additive.
    addColumn('validators', 'ibrl_score',               'REAL');
    // BAM (Block Assembly Marketplace, Jito) participation flag — additive.
    addColumn('validators', 'is_bam',                   'INTEGER');
    // SPL stake pool transient stake + validator status — additive on
    // pool_snapshots. Lets the optimizer reason about in-flight stake moves
    // (active + transient activating; status disambiguates direction).
    addColumn('pool_snapshots', 'transient_stake_lamports', 'INTEGER');
    addColumn('pool_snapshots', 'validator_status',         'INTEGER');
    // Epoch the pool last cranked this entry. Proves whether a snapshot was
    // taken before or after the pool's per-epoch update — drives the settle
    // gate in gdi-ingest. Null on rows written before this column existed.
    addColumn('pool_snapshots', 'last_update_epoch',        'INTEGER');
    // Live-geo stamp gate moved from present/observed to present/with_ip —
    // additive on geo_live_meta so a DB written by an earlier build of the pass
    // migrates forward instead of failing the upsert. See the table comment.
    addColumn('geo_live_meta', 'with_ip_count', 'INTEGER NOT NULL DEFAULT 0');
  }

  const stmt = {
    upsertEpoch: db.prepare(`
      INSERT INTO epochs (epoch_number, started_at, ended_at, ingested_at)
      VALUES (@epoch_number, @started_at, @ended_at, @ingested_at)
      ON CONFLICT(epoch_number) DO UPDATE SET
        started_at  = COALESCE(excluded.started_at,  epochs.started_at),
        ended_at    = COALESCE(excluded.ended_at,    epochs.ended_at),
        ingested_at = COALESCE(excluded.ingested_at, epochs.ingested_at)
    `),
    listEpochs: db.prepare(`SELECT * FROM epochs ORDER BY epoch_number DESC`),
    getEpoch: db.prepare(`SELECT * FROM epochs WHERE epoch_number = ?`),

    upsertPool: db.prepare(`
      INSERT INTO pools (pool_address, pool_name, pool_token_mint, pool_program, is_tracked, added_at)
      VALUES (@pool_address, @pool_name, @pool_token_mint, @pool_program, @is_tracked, @added_at)
      ON CONFLICT(pool_address) DO UPDATE SET
        pool_name       = COALESCE(excluded.pool_name,       pools.pool_name),
        pool_token_mint = COALESCE(excluded.pool_token_mint, pools.pool_token_mint),
        pool_program    = COALESCE(excluded.pool_program,    pools.pool_program),
        is_tracked      = excluded.is_tracked
    `),
    listTrackedPools: db.prepare(
      `SELECT * FROM pools WHERE is_tracked = 1 ORDER BY pool_address`,
    ),
    getPool: db.prepare(`SELECT * FROM pools WHERE pool_address = ?`),

    upsertValidator: db.prepare(`
      INSERT INTO validators
        (validator_pubkey, identity_pubkey, identity_name, country, city, asn, asn_name, datacenter,
         country_source, city_source, asn_source, metadata_refreshed_at,
         stakewiz_wiz_score, stakewiz_city_concentration, stakewiz_asn_concentration, stakewiz_refreshed_at,
         activated_stake_lamports, delinquent, delinquent_raw_streak, image_url,
         client_name, client_version, is_jito, is_dz, ibrl_score, is_bam)
      VALUES
        (@validator_pubkey, @identity_pubkey, @identity_name, @country, @city, @asn, @asn_name, @datacenter,
         @country_source, @city_source, @asn_source, @metadata_refreshed_at,
         @stakewiz_wiz_score, @stakewiz_city_concentration, @stakewiz_asn_concentration, @stakewiz_refreshed_at,
         @activated_stake_lamports, @delinquent, CASE WHEN @delinquent = 1 THEN 1 ELSE 0 END, @image_url,
         @client_name, @client_version, @is_jito, @is_dz, @ibrl_score, @is_bam)
      ON CONFLICT(validator_pubkey) DO UPDATE SET
        -- Text fields use NULLIF(...,'') so an EMPTY value from a source never
        -- overwrites a real stored one — only genuinely-new non-empty values
        -- win, else keep what we have. (A Stakewiz outage that returned empty
        -- names for the whole active set wiped 600+ identity_names on
        -- 2026-05-31 because plain COALESCE treats empty-string as a value.
        -- NULLIF fixes that class of bug for every identity/geo text field.)
        identity_pubkey             = COALESCE(NULLIF(excluded.identity_pubkey, ''),  validators.identity_pubkey),
        identity_name               = COALESCE(NULLIF(excluded.identity_name, ''),    validators.identity_name),
        country                     = COALESCE(NULLIF(excluded.country, ''),          validators.country),
        city                        = COALESCE(NULLIF(excluded.city, ''),             validators.city),
        asn                         = COALESCE(NULLIF(excluded.asn, ''),              validators.asn),
        asn_name                    = COALESCE(NULLIF(excluded.asn_name, ''),         validators.asn_name),
        datacenter                  = COALESCE(NULLIF(excluded.datacenter, ''),       validators.datacenter),
        country_source              = COALESCE(NULLIF(excluded.country_source, ''),   validators.country_source),
        city_source                 = COALESCE(NULLIF(excluded.city_source, ''),      validators.city_source),
        asn_source                  = COALESCE(NULLIF(excluded.asn_source, ''),       validators.asn_source),
        metadata_refreshed_at       = COALESCE(excluded.metadata_refreshed_at,       validators.metadata_refreshed_at),
        stakewiz_wiz_score          = COALESCE(excluded.stakewiz_wiz_score,          validators.stakewiz_wiz_score),
        stakewiz_city_concentration = COALESCE(excluded.stakewiz_city_concentration, validators.stakewiz_city_concentration),
        stakewiz_asn_concentration  = COALESCE(excluded.stakewiz_asn_concentration,  validators.stakewiz_asn_concentration),
        stakewiz_refreshed_at       = COALESCE(excluded.stakewiz_refreshed_at,       validators.stakewiz_refreshed_at),
        activated_stake_lamports    = COALESCE(excluded.activated_stake_lamports,    validators.activated_stake_lamports),
        -- Delinquency hysteresis: the raw source flag bumps/clears a streak
        -- counter; the EFFECTIVE delinquent flag flips to 1 only on the 4th
        -- consecutive raw=1 sample, and clears immediately on raw=0. NULL raw
        -- (source missing this cycle) leaves both untouched. SQLite evaluates
        -- both RHS against the pre-update row, so the delinquent expression
        -- sees the OLD streak; the same +1 therefore appears in both.
        --
        -- 4 samples ≈ 1h at the 15-min gdi-ingest cadence, the same protection
        -- window the original 2-sample threshold bought at 30 min. Re-derive
        -- this number if deploy/gdi-ingest.timer changes again; see the note on
        -- the delinquent_raw_streak migration above.
        delinquent_raw_streak       = CASE
                                        WHEN excluded.delinquent IS NULL THEN validators.delinquent_raw_streak
                                        WHEN excluded.delinquent = 0     THEN 0
                                        ELSE COALESCE(validators.delinquent_raw_streak, 0) + 1
                                      END,
        delinquent                  = CASE
                                        WHEN excluded.delinquent IS NULL THEN validators.delinquent
                                        WHEN excluded.delinquent = 0     THEN 0
                                        WHEN COALESCE(validators.delinquent_raw_streak, 0) + 1 >= 4 THEN 1
                                        ELSE COALESCE(validators.delinquent, 0)
                                      END,
        image_url                   = COALESCE(NULLIF(excluded.image_url, ''),        validators.image_url),
        -- Client fields: refresh on every ingest (clients change more often than
        -- geo). excluded.* wins outright so operator-attestation updates flow through.
        client_name                 = COALESCE(NULLIF(excluded.client_name, ''),      validators.client_name),
        client_version              = COALESCE(NULLIF(excluded.client_version, ''),   validators.client_version),
        is_jito                     = COALESCE(excluded.is_jito,                     validators.is_jito),
        is_dz                       = COALESCE(excluded.is_dz,                       validators.is_dz),
        ibrl_score                  = COALESCE(excluded.ibrl_score,                  validators.ibrl_score),
        is_bam                      = COALESCE(excluded.is_bam,                      validators.is_bam)
    `),
    getValidator: db.prepare(`SELECT * FROM validators WHERE validator_pubkey = ?`),
    listAllValidators: db.prepare(`SELECT * FROM validators`),
    listValidatorsForRefresh: db.prepare(`
      SELECT * FROM validators
      WHERE metadata_refreshed_at IS NULL OR metadata_refreshed_at < ?
    `),

    deleteSnapshotsForPoolEpoch: db.prepare(
      `DELETE FROM pool_snapshots WHERE epoch = ? AND pool_address = ?`,
    ),
    insertSnapshot: db.prepare(`
      INSERT INTO pool_snapshots
        (epoch, pool_address, validator_pubkey,
         stake_lamports, transient_stake_lamports, validator_status,
         last_update_epoch, captured_at)
      VALUES
        (@epoch, @pool_address, @validator_pubkey,
         @stake_lamports, @transient_stake_lamports, @validator_status,
         @last_update_epoch, @captured_at)
    `),
    listSnapshotsForPoolEpoch: db.prepare(`
      SELECT * FROM pool_snapshots
      WHERE epoch = ? AND pool_address = ?
      ORDER BY stake_lamports DESC
    `),
    listSnapshotsForEpoch: db.prepare(`
      SELECT * FROM pool_snapshots WHERE epoch = ? ORDER BY pool_address, stake_lamports DESC
    `),
    minLastUpdateEpoch: db.prepare(
      `SELECT MIN(last_update_epoch) AS m FROM pool_snapshots WHERE epoch = ?`,
    ),

    upsertPoolScore: db.prepare(`
      INSERT INTO pool_scores
        (epoch, pool_address, dc_country, dc_city, dc_asn, gdi_composite, network_impact_score,
         placement_coverage, validator_count, total_stake_lamports, computed_at, methodology_version)
      VALUES
        (@epoch, @pool_address, @dc_country, @dc_city, @dc_asn, @gdi_composite, @network_impact_score,
         @placement_coverage, @validator_count, @total_stake_lamports, @computed_at, @methodology_version)
      ON CONFLICT(epoch, pool_address) DO UPDATE SET
        dc_country           = excluded.dc_country,
        dc_city              = excluded.dc_city,
        dc_asn               = excluded.dc_asn,
        gdi_composite        = excluded.gdi_composite,
        network_impact_score = excluded.network_impact_score,
        placement_coverage   = excluded.placement_coverage,
        validator_count      = excluded.validator_count,
        total_stake_lamports = excluded.total_stake_lamports,
        computed_at          = excluded.computed_at,
        methodology_version  = excluded.methodology_version
    `),
    listScoresForEpoch: db.prepare(`
      SELECT * FROM pool_scores WHERE epoch = ? ORDER BY gdi_composite DESC
    `),
    listScoresForPool: db.prepare(`
      SELECT * FROM pool_scores WHERE pool_address = ? ORDER BY epoch DESC
    `),
    latestScoreEpoch: db.prepare(
      `SELECT MAX(epoch) AS epoch FROM pool_scores`,
    ),

    upsertNetworkBaseline: db.prepare(`
      INSERT INTO network_baseline
        (epoch, dc_country, dc_city, dc_asn, gdi_composite, validator_count, total_stake_lamports,
         computed_at, methodology_version)
      VALUES
        (@epoch, @dc_country, @dc_city, @dc_asn, @gdi_composite, @validator_count, @total_stake_lamports,
         @computed_at, @methodology_version)
      ON CONFLICT(epoch) DO UPDATE SET
        dc_country           = excluded.dc_country,
        dc_city              = excluded.dc_city,
        dc_asn               = excluded.dc_asn,
        gdi_composite        = excluded.gdi_composite,
        validator_count      = excluded.validator_count,
        total_stake_lamports = excluded.total_stake_lamports,
        computed_at          = excluded.computed_at,
        methodology_version  = excluded.methodology_version
    `),
    listBaselines: db.prepare(`SELECT * FROM network_baseline ORDER BY epoch DESC`),

    upsertNetworkShare: db.prepare(`
      INSERT INTO network_shares (epoch, dimension, bucket, share, validator_count, computed_at)
      VALUES (@epoch, @dimension, @bucket, @share, @validator_count, @computed_at)
      ON CONFLICT(epoch, dimension, bucket) DO UPDATE SET
        share           = excluded.share,
        validator_count = excluded.validator_count,
        computed_at     = excluded.computed_at
    `),
    deleteNetworkSharesForEpoch: db.prepare(
      `DELETE FROM network_shares WHERE epoch = ?`,
    ),
    listNetworkSharesForEpoch: db.prepare(
      `SELECT * FROM network_shares WHERE epoch = ? ORDER BY dimension, share DESC`,
    ),
    listNetworkSharesForBucket: db.prepare(
      `SELECT * FROM network_shares WHERE dimension = ? AND bucket = ? ORDER BY epoch DESC`,
    ),

    // ── Shadow scoring (parallel pool_scores / network_baseline /
    //    network_shares for the MaxMind-driven pipeline). Statements
    //    mirror their canonical counterparts EXACTLY; only the table
    //    names differ. Centralised here so any tweak to the canonical
    //    upsert shape has an obvious matching change here too.
    upsertPoolScoreShadow: db.prepare(`
      INSERT INTO pool_scores_shadow
        (epoch, pool_address, dc_country, dc_city, dc_asn, gdi_composite,
         network_impact_score, placement_coverage, validator_count,
         total_stake_lamports, computed_at, methodology_version)
      VALUES
        (@epoch, @pool_address, @dc_country, @dc_city, @dc_asn, @gdi_composite,
         @network_impact_score, @placement_coverage, @validator_count,
         @total_stake_lamports, @computed_at, @methodology_version)
      ON CONFLICT(epoch, pool_address) DO UPDATE SET
        dc_country           = excluded.dc_country,
        dc_city              = excluded.dc_city,
        dc_asn               = excluded.dc_asn,
        gdi_composite        = excluded.gdi_composite,
        network_impact_score = excluded.network_impact_score,
        placement_coverage   = excluded.placement_coverage,
        validator_count      = excluded.validator_count,
        total_stake_lamports = excluded.total_stake_lamports,
        computed_at          = excluded.computed_at,
        methodology_version  = excluded.methodology_version
    `),
    listShadowScoresForEpoch: db.prepare(`
      SELECT * FROM pool_scores_shadow WHERE epoch = ? ORDER BY gdi_composite DESC
    `),
    listShadowScoresForPool: db.prepare(`
      SELECT * FROM pool_scores_shadow WHERE pool_address = ? ORDER BY epoch DESC
    `),

    upsertNetworkBaselineShadow: db.prepare(`
      INSERT INTO network_baseline_shadow
        (epoch, dc_country, dc_city, dc_asn, gdi_composite, validator_count, total_stake_lamports,
         computed_at, methodology_version)
      VALUES
        (@epoch, @dc_country, @dc_city, @dc_asn, @gdi_composite, @validator_count, @total_stake_lamports,
         @computed_at, @methodology_version)
      ON CONFLICT(epoch) DO UPDATE SET
        dc_country           = excluded.dc_country,
        dc_city              = excluded.dc_city,
        dc_asn               = excluded.dc_asn,
        gdi_composite        = excluded.gdi_composite,
        validator_count      = excluded.validator_count,
        total_stake_lamports = excluded.total_stake_lamports,
        computed_at          = excluded.computed_at,
        methodology_version  = excluded.methodology_version
    `),
    listShadowBaselines: db.prepare(
      `SELECT * FROM network_baseline_shadow ORDER BY epoch DESC`,
    ),

    upsertNetworkShareShadow: db.prepare(`
      INSERT INTO network_shares_shadow (epoch, dimension, bucket, share, validator_count, computed_at)
      VALUES (@epoch, @dimension, @bucket, @share, @validator_count, @computed_at)
      ON CONFLICT(epoch, dimension, bucket) DO UPDATE SET
        share           = excluded.share,
        validator_count = excluded.validator_count,
        computed_at     = excluded.computed_at
    `),
    deleteNetworkSharesShadowForEpoch: db.prepare(
      `DELETE FROM network_shares_shadow WHERE epoch = ?`,
    ),
    listNetworkSharesShadowForEpoch: db.prepare(
      `SELECT * FROM network_shares_shadow WHERE epoch = ? ORDER BY dimension, share DESC`,
    ),
    listNetworkSharesShadowForBucket: db.prepare(
      `SELECT * FROM network_shares_shadow WHERE dimension = ? AND bucket = ? ORDER BY epoch DESC`,
    ),

    upsertValidatorGeoShadow: db.prepare(`
      INSERT INTO validator_geo_shadow (
        epoch, validator_pubkey, ip_used,
        shadow_country, shadow_city, shadow_asn, shadow_asn_name,
        canonical_country, canonical_city, canonical_asn, canonical_asn_name,
        country_match, city_match, asn_match,
        computed_at
      ) VALUES (
        @epoch, @validator_pubkey, @ip_used,
        @shadow_country, @shadow_city, @shadow_asn, @shadow_asn_name,
        @canonical_country, @canonical_city, @canonical_asn, @canonical_asn_name,
        @country_match, @city_match, @asn_match,
        @computed_at
      )
      ON CONFLICT(epoch, validator_pubkey) DO UPDATE SET
        ip_used            = excluded.ip_used,
        shadow_country     = excluded.shadow_country,
        shadow_city        = excluded.shadow_city,
        shadow_asn         = excluded.shadow_asn,
        shadow_asn_name    = excluded.shadow_asn_name,
        canonical_country  = excluded.canonical_country,
        canonical_city     = excluded.canonical_city,
        canonical_asn      = excluded.canonical_asn,
        canonical_asn_name = excluded.canonical_asn_name,
        country_match      = excluded.country_match,
        city_match         = excluded.city_match,
        asn_match          = excluded.asn_match,
        computed_at        = excluded.computed_at
    `),
    listGeoShadowForEpoch: db.prepare(
      `SELECT * FROM validator_geo_shadow WHERE epoch = ? ORDER BY validator_pubkey`,
    ),
    listGeoShadowForValidator: db.prepare(
      `SELECT * FROM validator_geo_shadow WHERE validator_pubkey = ? ORDER BY epoch DESC`,
    ),
    /** Newest shadow row per validator — the live pass's bootstrap seed, so
     *  day-0 stable state is what the system already believed. */
    listLatestGeoShadow: db.prepare(`
      SELECT s.* FROM validator_geo_shadow s
      JOIN (
        SELECT validator_pubkey, MAX(epoch) AS epoch
        FROM validator_geo_shadow GROUP BY validator_pubkey
      ) m ON m.validator_pubkey = s.validator_pubkey AND m.epoch = s.epoch
    `),

    // ── Live geo (validator_geo_live / geo_live_meta / validator_geo_events).
    //    Full-row upsert: the state machine computes the next row in memory and
    //    writes it whole, so the stable tuple can never be half-updated.
    upsertGeoLive: db.prepare(`
      INSERT INTO validator_geo_live (
        validator_pubkey,
        raw_country, raw_city, raw_asn, raw_asn_name, ip_used,
        stable_country, stable_city, stable_asn, stable_asn_name,
        stable_since, stable_observations,
        cand_country, cand_city, cand_asn, cand_asn_name, cand_count, cand_first_seen,
        first_observed_at, last_observed_at, last_counted_at, last_present_at,
        missing_streak, bootstrap_source
      ) VALUES (
        @validator_pubkey,
        @raw_country, @raw_city, @raw_asn, @raw_asn_name, @ip_used,
        @stable_country, @stable_city, @stable_asn, @stable_asn_name,
        @stable_since, @stable_observations,
        @cand_country, @cand_city, @cand_asn, @cand_asn_name, @cand_count, @cand_first_seen,
        @first_observed_at, @last_observed_at, @last_counted_at, @last_present_at,
        @missing_streak, @bootstrap_source
      )
      ON CONFLICT(validator_pubkey) DO UPDATE SET
        raw_country         = excluded.raw_country,
        raw_city            = excluded.raw_city,
        raw_asn             = excluded.raw_asn,
        raw_asn_name        = excluded.raw_asn_name,
        ip_used             = excluded.ip_used,
        stable_country      = excluded.stable_country,
        stable_city         = excluded.stable_city,
        stable_asn          = excluded.stable_asn,
        stable_asn_name     = excluded.stable_asn_name,
        stable_since        = excluded.stable_since,
        stable_observations = excluded.stable_observations,
        cand_country        = excluded.cand_country,
        cand_city           = excluded.cand_city,
        cand_asn            = excluded.cand_asn,
        cand_asn_name       = excluded.cand_asn_name,
        cand_count          = excluded.cand_count,
        cand_first_seen     = excluded.cand_first_seen,
        last_observed_at    = excluded.last_observed_at,
        last_counted_at     = excluded.last_counted_at,
        last_present_at     = excluded.last_present_at,
        missing_streak      = excluded.missing_streak,
        bootstrap_source    = excluded.bootstrap_source
    `),
    listGeoLiveAll: db.prepare(`SELECT * FROM validator_geo_live`),
    getGeoLive: db.prepare(`SELECT * FROM validator_geo_live WHERE validator_pubkey = ?`),

    getGeoLiveMeta: db.prepare(`SELECT * FROM geo_live_meta WHERE id = 1`),
    upsertGeoLiveMeta: db.prepare(`
      INSERT INTO geo_live_meta (
        id, last_tick_at, epoch,
        observed_count, with_ip_count, present_count, moving_count, promoted_count, bootstrapped_count,
        mass_change_pct, city_mmdb_mtime_ms, asn_mmdb_mtime_ms,
        stable_k, stable_min_dwell_s
      ) VALUES (
        1, @last_tick_at, @epoch,
        @observed_count, @with_ip_count, @present_count, @moving_count, @promoted_count, @bootstrapped_count,
        @mass_change_pct, @city_mmdb_mtime_ms, @asn_mmdb_mtime_ms,
        @stable_k, @stable_min_dwell_s
      )
      ON CONFLICT(id) DO UPDATE SET
        last_tick_at       = excluded.last_tick_at,
        epoch              = excluded.epoch,
        observed_count     = excluded.observed_count,
        with_ip_count      = excluded.with_ip_count,
        present_count      = excluded.present_count,
        moving_count       = excluded.moving_count,
        promoted_count     = excluded.promoted_count,
        bootstrapped_count = excluded.bootstrapped_count,
        mass_change_pct    = excluded.mass_change_pct,
        city_mmdb_mtime_ms = excluded.city_mmdb_mtime_ms,
        asn_mmdb_mtime_ms  = excluded.asn_mmdb_mtime_ms,
        stable_k           = excluded.stable_k,
        stable_min_dwell_s = excluded.stable_min_dwell_s
    `),

    insertGeoEvent: db.prepare(`
      INSERT INTO validator_geo_events (
        at, validator_pubkey, kind,
        from_country, from_city, from_asn,
        to_country, to_city, to_asn,
        cand_count, dwell_s, epoch
      ) VALUES (
        @at, @validator_pubkey, @kind,
        @from_country, @from_city, @from_asn,
        @to_country, @to_city, @to_asn,
        @cand_count, @dwell_s, @epoch
      )
    `),
    deleteGeoEventsBefore: db.prepare(`DELETE FROM validator_geo_events WHERE at < ?`),
    /** Promotions in a recent window — the watchdog's mass-change signal.
     *  Counting EVENTS rather than sampling geo_live_meta.mass_change_pct is
     *  deliberate: the watchdog runs hourly against a column the pass rewrites
     *  every 15 min, so sampling it misses ~3 of every 4 spikes. */
    countGeoPromotesSince: db.prepare(
      `SELECT COUNT(*) AS n FROM validator_geo_events WHERE kind = 'promote' AND at > ?`,
    ),
    /** Newest last_observed_at across the live table. Lets a consumer detect
     *  row writes that happened AFTER the last freshness stamp — i.e. ticks
     *  that ran but failed their stamp gate. */
    maxGeoLiveObservedAt: db.prepare(
      `SELECT MAX(last_observed_at) AS t FROM validator_geo_live`,
    ),
    listGeoEventsForValidator: db.prepare(
      `SELECT * FROM validator_geo_events WHERE validator_pubkey = ? ORDER BY at, id`,
    ),
    countGeoEvents: db.prepare(`SELECT COUNT(*) AS n FROM validator_geo_events`),

    upsertGeoOverride: db.prepare(`
      INSERT INTO validator_geo_overrides
        (validator_pubkey, country, city, asn, asn_name, reason, source_evidence, added_at, added_by)
      VALUES
        (@validator_pubkey, @country, @city, @asn, @asn_name, @reason, @source_evidence, @added_at, @added_by)
      ON CONFLICT(validator_pubkey) DO UPDATE SET
        country         = excluded.country,
        city            = excluded.city,
        asn             = excluded.asn,
        asn_name        = excluded.asn_name,
        reason          = excluded.reason,
        source_evidence = excluded.source_evidence,
        added_at        = excluded.added_at,
        added_by        = excluded.added_by
    `),
    deleteGeoOverride: db.prepare(
      `DELETE FROM validator_geo_overrides WHERE validator_pubkey = ?`,
    ),
    getGeoOverride: db.prepare(
      `SELECT * FROM validator_geo_overrides WHERE validator_pubkey = ?`,
    ),
    listGeoOverrides: db.prepare(
      `SELECT * FROM validator_geo_overrides ORDER BY added_at DESC`,
    ),

    insertRun: db.prepare(`
      INSERT INTO ingestion_runs (run_id, epoch, started_at, status, pools_processed, pools_failed, notes)
      VALUES (@run_id, @epoch, @started_at, @status, NULL, NULL, NULL)
    `),
    finishRun: db.prepare(`
      UPDATE ingestion_runs
      SET finished_at = @finished_at,
          status = @status,
          pools_processed = @pools_processed,
          pools_failed = @pools_failed,
          notes = @notes
      WHERE run_id = @run_id
    `),
    listRuns: db.prepare(`SELECT * FROM ingestion_runs ORDER BY started_at DESC LIMIT ?`),
    getRun: db.prepare(`SELECT * FROM ingestion_runs WHERE run_id = ?`),
    isEpochIngested: db.prepare(`
      SELECT 1 FROM ingestion_runs WHERE epoch = ? AND status IN ('success', 'partial') LIMIT 1
    `),
    lastRunStatusForEpoch: db.prepare(`
      SELECT status FROM ingestion_runs
      WHERE epoch = ?
      ORDER BY started_at DESC, rowid DESC
      LIMIT 1
    `),
  };

  function replaceSnapshotsForPoolEpoch(
    epoch: number,
    poolAddress: string,
    snapshots: {
      validator_pubkey: string;
      stake_lamports: bigint;
      transient_stake_lamports: bigint;
      validator_status: number;
      last_update_epoch: number;
      captured_at: number;
    }[],
  ): void {
    const tx = db.transaction(() => {
      stmt.deleteSnapshotsForPoolEpoch.run(epoch, poolAddress);
      for (const s of snapshots) {
        stmt.insertSnapshot.run({
          epoch,
          pool_address: poolAddress,
          validator_pubkey: s.validator_pubkey,
          stake_lamports: s.stake_lamports,
          transient_stake_lamports: s.transient_stake_lamports,
          validator_status: s.validator_status,
          last_update_epoch: s.last_update_epoch,
          captured_at: s.captured_at,
        });
      }
    });
    tx();
  }

  return {
    db,
    close(): void {
      db.close();
    },

    // Epochs
    upsertEpoch(row: { epoch_number: number; started_at?: number | null; ended_at?: number | null; ingested_at?: number | null }): void {
      stmt.upsertEpoch.run({
        epoch_number: row.epoch_number,
        started_at: row.started_at ?? null,
        ended_at: row.ended_at ?? null,
        ingested_at: row.ingested_at ?? null,
      });
    },
    listEpochs(): { epoch_number: number; started_at: number | null; ended_at: number | null; ingested_at: number | null }[] {
      return stmt.listEpochs.all() as never;
    },
    getEpoch(n: number): { epoch_number: number; started_at: number | null; ended_at: number | null; ingested_at: number | null } | undefined {
      return stmt.getEpoch.get(n) as never;
    },

    // Pools
    upsertPool(row: Pool): void {
      stmt.upsertPool.run(row);
    },
    listTrackedPools(): Pool[] {
      return stmt.listTrackedPools.all() as Pool[];
    },
    getPool(address: string): Pool | undefined {
      return stmt.getPool.get(address) as Pool | undefined;
    },

    // Validators
    upsertValidator(row: ValidatorRow): void {
      stmt.upsertValidator.run(row);
    },
    upsertValidators(rows: ValidatorRow[]): void {
      const tx = db.transaction((items: ValidatorRow[]) => {
        for (const r of items) stmt.upsertValidator.run(r);
      });
      tx(rows);
    },
    getValidator(pubkey: string): ValidatorRow | undefined {
      return stmt.getValidator.get(pubkey) as ValidatorRow | undefined;
    },
    listAllValidators(): ValidatorRow[] {
      return stmt.listAllValidators.all() as ValidatorRow[];
    },
    listValidatorsForRefresh(staleBefore: number): ValidatorRow[] {
      return stmt.listValidatorsForRefresh.all(staleBefore) as ValidatorRow[];
    },

    // Snapshots
    replaceSnapshotsForPoolEpoch,
    listSnapshotsForPoolEpoch(epoch: number, poolAddress: string): PoolSnapshot[] {
      return stmt.listSnapshotsForPoolEpoch.all(epoch, poolAddress) as PoolSnapshot[];
    },
    listSnapshotsForEpoch(epoch: number): PoolSnapshot[] {
      return stmt.listSnapshotsForEpoch.all(epoch) as PoolSnapshot[];
    },
    /** Oldest crank epoch across this epoch's snapshots — the settle test: a
     *  value below `epoch` means at least one pool was photographed before it
     *  cranked. Null when no row carries the field (all rows pre-date the
     *  column, or there are none), which reads as "can't prove staleness".
     *  SQL MIN ignores NULLs, so a part-migrated epoch still reports the
     *  oldest known crank rather than going blind. */
    minLastUpdateEpochForEpoch(epoch: number): number | null {
      const r = stmt.minLastUpdateEpoch.get(epoch) as { m: number | null };
      return r?.m ?? null;
    },

    // Pool scores
    upsertPoolScore(row: PoolScore): void {
      stmt.upsertPoolScore.run(row);
    },
    listScoresForEpoch(epoch: number): PoolScore[] {
      return stmt.listScoresForEpoch.all(epoch) as PoolScore[];
    },
    listScoresForPool(poolAddress: string): PoolScore[] {
      return stmt.listScoresForPool.all(poolAddress) as PoolScore[];
    },
    latestScoredEpoch(): number | null {
      const r = stmt.latestScoreEpoch.get() as { epoch: number | null };
      return r?.epoch ?? null;
    },

    // Network baseline
    upsertNetworkBaseline(row: NetworkBaseline): void {
      stmt.upsertNetworkBaseline.run(row);
    },
    listBaselines(): NetworkBaseline[] {
      return stmt.listBaselines.all() as NetworkBaseline[];
    },

    /**
     * Persist a full per-epoch network-shares snapshot. Idempotent — replaces
     * any existing rows for the epoch (a re-ingest within the same epoch should
     * overwrite cleanly). Wrapped in a transaction so partial writes don't
     * leave the table in a mixed state.
     */
    replaceNetworkSharesForEpoch(
      epoch: number,
      rows: { dimension: 'country' | 'city' | 'asn'; bucket: string; share: number; validator_count: number }[],
      computedAt: number,
    ): void {
      const tx = db.transaction(() => {
        stmt.deleteNetworkSharesForEpoch.run(epoch);
        for (const r of rows) {
          stmt.upsertNetworkShare.run({
            epoch,
            dimension: r.dimension,
            bucket: r.bucket,
            share: r.share,
            validator_count: r.validator_count,
            computed_at: computedAt,
          });
        }
      });
      tx();
    },
    listNetworkSharesForEpoch(epoch: number): NetworkShareRow[] {
      return stmt.listNetworkSharesForEpoch.all(epoch) as NetworkShareRow[];
    },
    listNetworkSharesForBucket(dimension: 'country' | 'city' | 'asn', bucket: string): NetworkShareRow[] {
      return stmt.listNetworkSharesForBucket.all(dimension, bucket) as NetworkShareRow[];
    },

    // ─── Shadow scoring (parallel pool_scores / network_baseline /
    //     network_shares for the MaxMind-driven pipeline). Same
    //     row types as canonical — the schema is identical by design.
    upsertPoolScoreShadow(row: PoolScore): void {
      stmt.upsertPoolScoreShadow.run(row);
    },
    listShadowScoresForEpoch(epoch: number): PoolScore[] {
      return stmt.listShadowScoresForEpoch.all(epoch) as PoolScore[];
    },
    listShadowScoresForPool(poolAddress: string): PoolScore[] {
      return stmt.listShadowScoresForPool.all(poolAddress) as PoolScore[];
    },

    upsertNetworkBaselineShadow(row: NetworkBaseline): void {
      stmt.upsertNetworkBaselineShadow.run(row);
    },
    listShadowBaselines(): NetworkBaseline[] {
      return stmt.listShadowBaselines.all() as NetworkBaseline[];
    },

    /**
     * Bulk-write a full per-epoch shadow network_shares snapshot. Wrapped
     * in a transaction so a partial write can't leave half-populated rows.
     * Mirrors `replaceNetworkSharesForEpoch` for the canonical table.
     */
    replaceNetworkSharesShadowForEpoch(
      epoch: number,
      rows: { dimension: 'country' | 'city' | 'asn'; bucket: string; share: number; validator_count: number }[],
      computedAt: number,
    ): void {
      const tx = db.transaction(() => {
        stmt.deleteNetworkSharesShadowForEpoch.run(epoch);
        for (const r of rows) {
          stmt.upsertNetworkShareShadow.run({
            epoch,
            dimension: r.dimension,
            bucket: r.bucket,
            share: r.share,
            validator_count: r.validator_count,
            computed_at: computedAt,
          });
        }
      });
      tx();
    },
    listNetworkSharesShadowForEpoch(epoch: number): NetworkShareRow[] {
      return stmt.listNetworkSharesShadowForEpoch.all(epoch) as NetworkShareRow[];
    },
    listNetworkSharesShadowForBucket(dimension: 'country' | 'city' | 'asn', bucket: string): NetworkShareRow[] {
      return stmt.listNetworkSharesShadowForBucket.all(dimension, bucket) as NetworkShareRow[];
    },

    /**
     * Bulk-write a full per-epoch shadow snapshot. Wrapped in a transaction so
     * a partial write can't leave half-populated rows for the epoch.
     */
    replaceGeoShadowForEpoch(epoch: number, rows: ValidatorGeoShadowRow[]): void {
      const tx = db.transaction(() => {
        for (const r of rows) stmt.upsertValidatorGeoShadow.run(r);
      });
      tx();
    },
    listGeoShadowForEpoch(epoch: number): ValidatorGeoShadowRow[] {
      return stmt.listGeoShadowForEpoch.all(epoch) as ValidatorGeoShadowRow[];
    },
    listGeoShadowForValidator(pubkey: string): ValidatorGeoShadowRow[] {
      return stmt.listGeoShadowForValidator.all(pubkey) as ValidatorGeoShadowRow[];
    },
    /** Newest shadow row per validator (MAX(epoch)) — the live pass's bootstrap
     *  seed. One row per validator, ~2.6k rows. */
    listLatestGeoShadow(): ValidatorGeoShadowRow[] {
      return stmt.listLatestGeoShadow.all() as ValidatorGeoShadowRow[];
    },

    // ─── Live geo. See src/lib/gdi/geo-live.ts for the state machine that
    //     owns these tables; nothing else writes them.
    listGeoLiveAll(): ValidatorGeoLiveRow[] {
      return stmt.listGeoLiveAll.all() as ValidatorGeoLiveRow[];
    },
    getGeoLive(pubkey: string): ValidatorGeoLiveRow | undefined {
      return stmt.getGeoLive.get(pubkey) as ValidatorGeoLiveRow | undefined;
    },
    upsertGeoLiveRow(row: ValidatorGeoLiveRow): void {
      stmt.upsertGeoLive.run(row);
    },
    getGeoLiveMeta(): GeoLiveMetaRow | undefined {
      return stmt.getGeoLiveMeta.get() as GeoLiveMetaRow | undefined;
    },
    upsertGeoLiveMeta(row: Omit<GeoLiveMetaRow, 'id'>): void {
      stmt.upsertGeoLiveMeta.run(row);
    },
    insertGeoEvent(ev: ValidatorGeoEventRow): void {
      stmt.insertGeoEvent.run(ev);
    },
    deleteGeoEventsBefore(unixS: number): number {
      const r = stmt.deleteGeoEventsBefore.run(unixS) as { changes: number };
      return r.changes;
    },
    listGeoEventsForValidator(pubkey: string): (ValidatorGeoEventRow & { id: number })[] {
      return stmt.listGeoEventsForValidator.all(pubkey) as (ValidatorGeoEventRow & { id: number })[];
    },
    countGeoEvents(): number {
      return (stmt.countGeoEvents.get() as { n: number }).n;
    },
    /** Promotions recorded strictly after `unixS`. */
    countGeoPromotesSince(unixS: number): number {
      return (stmt.countGeoPromotesSince.get(unixS) as { n: number }).n;
    },
    /** Newest last_observed_at in validator_geo_live, or null when empty. */
    maxGeoLiveObservedAt(): number | null {
      const r = stmt.maxGeoLiveObservedAt.get() as { t: number | null };
      return r?.t ?? null;
    },
    /**
     * Run the whole live-geo tick as ONE transaction — every row update, every
     * event and the meta stamp land together or not at all. A partial commit
     * would leave the freshness stamp disagreeing with the rows it describes.
     */
    runGeoLiveTransaction(fn: () => void): void {
      db.transaction(fn)();
    },

    upsertGeoOverride(row: ValidatorGeoOverrideRow): void {
      stmt.upsertGeoOverride.run(row);
    },
    deleteGeoOverride(pubkey: string): number {
      const r = stmt.deleteGeoOverride.run(pubkey) as { changes: number };
      return r.changes;
    },
    getGeoOverride(pubkey: string): ValidatorGeoOverrideRow | undefined {
      return stmt.getGeoOverride.get(pubkey) as ValidatorGeoOverrideRow | undefined;
    },
    listGeoOverrides(): ValidatorGeoOverrideRow[] {
      return stmt.listGeoOverrides.all() as ValidatorGeoOverrideRow[];
    },

    // Ingestion runs
    startRun(row: { run_id: string; epoch: number; started_at: number; status: IngestionRun['status'] }): void {
      stmt.insertRun.run(row);
    },
    finishRun(row: {
      run_id: string;
      finished_at: number;
      status: IngestionRun['status'];
      pools_processed: number;
      pools_failed: number;
      notes?: string | null;
    }): void {
      stmt.finishRun.run({ notes: null, ...row });
    },
    listRecentRuns(limit = 50): IngestionRun[] {
      return stmt.listRuns.all(limit) as IngestionRun[];
    },
    getRun(runId: string): IngestionRun | undefined {
      return stmt.getRun.get(runId) as IngestionRun | undefined;
    },
    isEpochAlreadyIngested(epoch: number): boolean {
      return !!stmt.isEpochIngested.get(epoch);
    },
    /** Status of the most recent run for this epoch ('success' | 'partial' |
     *  'failed' | 'in_progress'), null when the epoch has never been run. */
    lastRunStatusForEpoch(epoch: number): string | null {
      const r = stmt.lastRunStatusForEpoch.get(epoch) as { status: string } | undefined;
      return r?.status ?? null;
    },
  };
}
