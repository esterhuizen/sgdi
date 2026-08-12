// Builds tests/fixtures/gdi-fixture.sqlite — a tiny, deterministic GDI database
// with KNOWN active / delinquent / zero-stake / null-geo rows, used by
// tests/snapshot.test.ts. Regenerate with:
//
//   node --experimental-strip-types tests/fixtures/build-fixture.ts
//
// The committed .sqlite is what the test actually reads (the handoff wants a
// committed fixture, not prod); this builder exists so that fixture is
// reviewable and reproducible. NOTE the .sqlite extension — the repo .gitignore
// ignores *.db, so the fixture deliberately avoids that suffix.
//
// Fixture design (mirrors the epoch-1015 prod shape at miniature scale):
//   • "Poland" has 5 rows but only 1 is active — the 53-vs-7 distinction in the
//     small: total-rows ≠ active-count, driven by delinquency + zero stake.
//   • one active validator with NULL city (null-geo coverage case)
//   • one delinquent-but-staked validator (excluded from active)
//   • one zero-stake, healthy validator (excluded from active)
//   • one NULL-stake validator (excluded — NULL > 0 is not true)
//   • pool_scores across two epochs so v_pools_current must pick the latest.

import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openStorage, type ValidatorRow } from '../../src/lib/gdi/storage.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, 'gdi-fixture.sqlite');

const SOL = 1_000_000_000;

function v(overrides: Partial<ValidatorRow> & { validator_pubkey: string }): ValidatorRow {
  return {
    validator_pubkey: overrides.validator_pubkey,
    identity_pubkey: null,
    identity_name: overrides.identity_name ?? 'Val ' + overrides.validator_pubkey,
    country: 'Germany',
    city: 'Frankfurt',
    asn: 'AS24940',
    asn_name: 'Hetzner',
    datacenter: null,
    country_source: 'stakewiz',
    city_source: 'stakewiz',
    asn_source: 'stakewiz',
    metadata_refreshed_at: 1_700_000_000,
    stakewiz_wiz_score: 90,
    stakewiz_city_concentration: null,
    stakewiz_asn_concentration: null,
    stakewiz_refreshed_at: 1_700_000_000,
    activated_stake_lamports: 100_000 * SOL,
    delinquent: 0,
    image_url: null,
    client_name: 'Agave',
    client_version: '3.0.0',
    is_jito: 0,
    is_dz: 0,
    is_bam: 0,
    ibrl_score: null,
    ...overrides,
  };
}

function build(): void {
  rmSync(FIXTURE_PATH, { force: true });
  rmSync(FIXTURE_PATH + '-wal', { force: true });
  rmSync(FIXTURE_PATH + '-shm', { force: true });

  const storage = openStorage(FIXTURE_PATH);

  // ── Validators ────────────────────────────────────────────────────────────
  const rows: ValidatorRow[] = [
    // Poland: 5 rows, exactly 1 active (mirrors 53→7 at small scale).
    v({ validator_pubkey: 'PL_active_1',      country: 'Poland', city: 'Warsaw',  asn: 'AS200000', delinquent: 0, activated_stake_lamports: 50_000 * SOL }),
    v({ validator_pubkey: 'PL_delinq_1',      country: 'Poland', city: 'Warsaw',  asn: 'AS200000', delinquent: 1, activated_stake_lamports: 50_000 * SOL }),
    v({ validator_pubkey: 'PL_delinq_2',      country: 'Poland', city: 'Krakow',  asn: 'AS200001', delinquent: 1, activated_stake_lamports: 40_000 * SOL }),
    v({ validator_pubkey: 'PL_zerostake_1',   country: 'Poland', city: 'Krakow',  asn: 'AS200001', delinquent: 0, activated_stake_lamports: 0 }),
    v({ validator_pubkey: 'PL_nullstake_1',   country: 'Poland', city: 'Gdansk',  asn: 'AS200002', delinquent: 0, activated_stake_lamports: null }),

    // Active elsewhere.
    v({ validator_pubkey: 'DE_active_1',      country: 'Germany', city: 'Frankfurt', asn: 'AS24940', delinquent: 0, activated_stake_lamports: 200_000 * SOL }),
    v({ validator_pubkey: 'US_active_1',      country: 'United States', city: 'Ashburn', asn: 'AS14618', delinquent: 0, activated_stake_lamports: 300_000 * SOL }),
    // Active but NULL city — null-geo coverage case (still counts as active).
    v({ validator_pubkey: 'US_active_nullcity', country: 'United States', city: null, asn: 'AS14618', delinquent: 0, activated_stake_lamports: 120_000 * SOL }),
    // delinquent NULL (unknown) + staked → active under `delinquent IS NOT 1`.
    v({ validator_pubkey: 'FR_unknown_deling', country: 'France', city: 'Paris', asn: 'AS16276', delinquent: null, activated_stake_lamports: 80_000 * SOL }),
    // healthy but zero stake → not active.
    v({ validator_pubkey: 'FI_zerostake_1',   country: 'Finland', city: 'Helsinki', asn: 'AS16276', delinquent: 0, activated_stake_lamports: 0 }),
  ];
  storage.upsertValidators(rows);

  // ── Pools ─────────────────────────────────────────────────────────────────
  const now = 1_700_000_100;
  storage.upsertPool({ pool_address: 'POOL_A', pool_name: 'Alpha Pool', pool_token_mint: 'mintA', pool_program: null, is_tracked: 1, added_at: now });
  storage.upsertPool({ pool_address: 'POOL_B', pool_name: 'Beta Pool',  pool_token_mint: 'mintB', pool_program: null, is_tracked: 1, added_at: now });

  // ── Pool scores across two epochs — v_pools_current must return only ep 101.
  const score = (epoch: number, pool: string, gdi: number) => ({
    epoch,
    pool_address: pool,
    dc_country: gdi,
    dc_city: gdi,
    dc_asn: gdi,
    gdi_composite: gdi,
    network_impact_score: gdi * 10,
    placement_coverage: 1,
    validator_count: 3,
    total_stake_lamports: BigInt(500_000 * SOL),
    computed_at: now,
    methodology_version: 'gdi-1.1.1',
  });
  storage.upsertPoolScore(score(100, 'POOL_A', 3.0));
  storage.upsertPoolScore(score(100, 'POOL_B', 2.0));
  storage.upsertPoolScore(score(101, 'POOL_A', 3.5)); // latest epoch
  storage.upsertPoolScore(score(101, 'POOL_B', 2.5)); // latest epoch

  // Fold WAL into the main file so the committed fixture is a single self-
  // contained file (no -wal/-shm sidecars to commit or clean up).
  storage.db.pragma('wal_checkpoint(TRUNCATE)');
  storage.db.pragma('journal_mode = DELETE');
  storage.close();

  console.log('built fixture:', FIXTURE_PATH);
}

build();
