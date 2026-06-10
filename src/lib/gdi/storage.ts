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
    // `delinquent` flag only flips to 1 after TWO consecutive samples (~1h at
    // the 30-min cadence); recovery is immediate on one healthy sample. A
    // single bad Stakewiz sample on 2026-06-10 (13.4M-SOL validator briefly
    // flagged) emptied its ASN bucket from the active set and inflated its
    // pools' GDI by +106% for one publish cycle — this hysteresis stops that
    // class of blip from ever reaching scoring.
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
        -- counter; the EFFECTIVE delinquent flag flips to 1 only on the 2nd
        -- consecutive raw=1 sample, and clears immediately on raw=0. NULL raw
        -- (source missing this cycle) leaves both untouched. SQLite evaluates
        -- both RHS against the pre-update row, so the delinquent expression
        -- sees the OLD streak; the same +1 therefore appears in both.
        delinquent_raw_streak       = CASE
                                        WHEN excluded.delinquent IS NULL THEN validators.delinquent_raw_streak
                                        WHEN excluded.delinquent = 0     THEN 0
                                        ELSE COALESCE(validators.delinquent_raw_streak, 0) + 1
                                      END,
        delinquent                  = CASE
                                        WHEN excluded.delinquent IS NULL THEN validators.delinquent
                                        WHEN excluded.delinquent = 0     THEN 0
                                        WHEN COALESCE(validators.delinquent_raw_streak, 0) + 1 >= 2 THEN 1
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
         stake_lamports, transient_stake_lamports, validator_status, captured_at)
      VALUES
        (@epoch, @pool_address, @validator_pubkey,
         @stake_lamports, @transient_stake_lamports, @validator_status, @captured_at)
    `),
    listSnapshotsForPoolEpoch: db.prepare(`
      SELECT * FROM pool_snapshots
      WHERE epoch = ? AND pool_address = ?
      ORDER BY stake_lamports DESC
    `),
    listSnapshotsForEpoch: db.prepare(`
      SELECT * FROM pool_snapshots WHERE epoch = ? ORDER BY pool_address, stake_lamports DESC
    `),

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
  };

  function replaceSnapshotsForPoolEpoch(
    epoch: number,
    poolAddress: string,
    snapshots: {
      validator_pubkey: string;
      stake_lamports: bigint;
      transient_stake_lamports: bigint;
      validator_status: number;
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
  };
}
