// Tests for scripts/gdi-snapshot.ts — the read-only DB snapshot + semantic view
// layer that feeds the (future) read-only Telegram helper bot.
//
// Runs against the committed miniature fixture (tests/fixtures/gdi-fixture.sqlite)
// and small purpose-built source DBs in a per-test tmp dir — NEVER prod.
//
//   node --test --experimental-strip-types tests/snapshot.test.ts

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runSnapshot } from '../scripts/gdi-snapshot.ts';
import { openStorage, type ValidatorRow } from '../src/lib/gdi/storage.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'gdi-fixture.sqlite');
const SOL = 1_000_000_000;

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'sgdi-snap-'));
}

/** Open the produced snapshot exactly as the bot would: read-only. */
function openSnap(path: string): Database.Database {
  return new Database(path, { readonly: true });
}

function count(db: Database.Database, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

function baseValidator(pubkey: string, over: Partial<ValidatorRow>): ValidatorRow {
  return {
    validator_pubkey: pubkey,
    identity_pubkey: null,
    identity_name: pubkey,
    country: 'Germany', city: 'Frankfurt', asn: 'AS24940', asn_name: 'Hetzner', datacenter: null,
    country_source: 'stakewiz', city_source: 'stakewiz', asn_source: 'stakewiz',
    metadata_refreshed_at: 1, stakewiz_wiz_score: 90,
    stakewiz_city_concentration: null, stakewiz_asn_concentration: null, stakewiz_refreshed_at: 1,
    activated_stake_lamports: 100_000 * SOL, delinquent: 0, image_url: null,
    client_name: 'Agave', client_version: '3.0.0', is_jito: 0, is_dz: 0, is_bam: 0, ibrl_score: null,
    ...over,
  };
}

/** Build a throwaway source DB with `active` healthy-staked and `dead`
 *  delinquent validators. Returns its path. */
function buildSource(dir: string, active: number, dead: number): string {
  const path = join(dir, 'src.db');
  const storage = openStorage(path);
  const rows: ValidatorRow[] = [];
  for (let i = 0; i < active; i++) rows.push(baseValidator(`A${i}`, { delinquent: 0 }));
  for (let i = 0; i < dead; i++) rows.push(baseValidator(`D${i}`, { delinquent: 1 }));
  storage.upsertValidators(rows);
  storage.db.pragma('wal_checkpoint(TRUNCATE)');
  storage.close();
  return path;
}

test('snapshot: publishes with correct view counts from the committed fixture', () => {
  const dir = tmpDir();
  const r = runSnapshot({ sourceDbPath: FIXTURE, publishedDir: dir });

  assert.equal(r.totalValidators, 10);
  assert.equal(r.activeValidators, 5); // 4 healthy-staked + 1 unknown-delinquent-staked
  assert.equal(r.currentPools, 2);
  assert.equal(r.latestEpoch, 101);
  assert.equal(r.path, join(dir, 'gdi-snapshot.db'));

  const db = openSnap(r.path);
  try {
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM v_validators_active'), 5);
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM v_validators_geo'), 10);
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM v_pools_current'), 2);
  } finally {
    db.close();
  }
});

test('snapshot: proves the 53-vs-7 distinction (total rows ≠ active) for Poland', () => {
  const dir = tmpDir();
  const r = runSnapshot({ sourceDbPath: FIXTURE, publishedDir: dir });
  const db = openSnap(r.path);
  try {
    // 5 Poland rows in the raw table...
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM validators WHERE country='Poland'`), 5);
    // ...but only 1 is actually running (the rest: 2 delinquent, 1 zero-stake,
    // 1 null-stake). This is the small-scale 53→7.
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM v_validators_active WHERE country='Poland'`), 1);
  } finally {
    db.close();
  }
});

test('snapshot: a NULL-delinquent staked validator counts as active', () => {
  const dir = tmpDir();
  const r = runSnapshot({ sourceDbPath: FIXTURE, publishedDir: dir });
  const db = openSnap(r.path);
  try {
    const row = db.prepare(`SELECT validator_pubkey FROM v_validators_active WHERE validator_pubkey='FR_unknown_deling'`).get();
    assert.ok(row, 'unknown-delinquency + staked validator must be treated as active (delinquent IS NOT 1)');
  } finally {
    db.close();
  }
});

test('snapshot: v_validators_geo flags full-geo vs null-geo correctly', () => {
  const dir = tmpDir();
  const r = runSnapshot({ sourceDbPath: FIXTURE, publishedDir: dir });
  const db = openSnap(r.path);
  try {
    const full = db.prepare(`SELECT has_full_geo, has_city, is_active FROM v_validators_geo WHERE validator_pubkey='US_active_1'`).get() as any;
    assert.equal(full.has_full_geo, 1);
    assert.equal(full.is_active, 1);
    const nullCity = db.prepare(`SELECT has_full_geo, has_city, is_active FROM v_validators_geo WHERE validator_pubkey='US_active_nullcity'`).get() as any;
    assert.equal(nullCity.has_city, 0);
    assert.equal(nullCity.has_full_geo, 0);
    assert.equal(nullCity.is_active, 1); // null geo does not make it inactive
  } finally {
    db.close();
  }
});

test('snapshot: v_pools_current returns only the latest epoch, GDI-ordered, with pool names', () => {
  const dir = tmpDir();
  const r = runSnapshot({ sourceDbPath: FIXTURE, publishedDir: dir });
  const db = openSnap(r.path);
  try {
    const rows = db.prepare('SELECT epoch, pool_address, pool_name, gdi_composite FROM v_pools_current').all() as any[];
    assert.equal(rows.length, 2);
    assert.ok(rows.every((x) => x.epoch === 101), 'only the latest epoch');
    assert.equal(rows[0].pool_address, 'POOL_A'); // higher GDI first
    assert.equal(rows[0].pool_name, 'Alpha Pool'); // joined from pools
    assert.ok(rows[0].gdi_composite > rows[1].gdi_composite);
  } finally {
    db.close();
  }
});

test('snapshot: source DB is never modified (checksum identical before/after)', () => {
  const dir = tmpDir();
  const src = buildSource(dir, 6, 2);
  const sha = (p: string) => execFileSync('sha256sum', [p]).toString().split(' ')[0];
  const before = sha(src);
  runSnapshot({ sourceDbPath: src, publishedDir: join(dir, 'out') });
  assert.equal(sha(src), before, 'VACUUM INTO must leave the source byte-identical');
});

test('snapshot: result is world-readable (0644) and has no WAL sidecars', () => {
  const dir = tmpDir();
  const r = runSnapshot({ sourceDbPath: FIXTURE, publishedDir: dir });
  assert.equal(statSync(r.path).mode & 0o777, 0o644);
  assert.ok(!existsSync(r.path + '-wal'), 'snapshot must be a single self-contained file');
  assert.ok(!existsSync(r.path + '-shm'));
  assert.ok(!existsSync(r.path + '.tmp'), 'the .tmp must be renamed away, not left behind');
});

test('sanity guard: refuses to publish when the active set is empty', () => {
  const dir = tmpDir();
  const src = buildSource(dir, 0, 5); // all delinquent
  assert.throws(
    () => runSnapshot({ sourceDbPath: src, publishedDir: join(dir, 'out') }),
    /active-validator count is 0/,
  );
  assert.ok(!existsSync(join(dir, 'out', 'gdi-snapshot.db')), 'nothing must be published');
});

test('sanity guard: refuses a >50% active-count collapse and keeps the previous snapshot', () => {
  const dir = tmpDir();
  const out = join(dir, 'out');

  // First publish: 10 active.
  const good = buildSource(join(dir, 'a'), 10, 0);
  const r1 = runSnapshot({ sourceDbPath: good, publishedDir: out });
  assert.equal(r1.activeValidators, 10);

  // Second attempt from a collapsed source: 3 active = 70% drop → must abort.
  const collapsed = buildSource(join(dir, 'b'), 3, 7);
  assert.throws(
    () => runSnapshot({ sourceDbPath: collapsed, publishedDir: out }),
    /dropped .* threshold 50%/,
  );

  // The previous good snapshot must still be intact (10 active), untouched.
  const db = openSnap(join(out, 'gdi-snapshot.db'));
  try {
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM v_validators_active'), 10);
  } finally {
    db.close();
  }
  assert.ok(!existsSync(join(out, 'gdi-snapshot.db.tmp')), 'the aborted .tmp must be cleaned up');
});

test('sanity guard: a first-ever snapshot has no baseline to drop against', () => {
  const dir = tmpDir();
  const src = buildSource(dir, 4, 1);
  // No previous snapshot exists → the drop guard is skipped, publish succeeds.
  const r = runSnapshot({ sourceDbPath: src, publishedDir: join(dir, 'out') });
  assert.equal(r.activeValidators, 4);
});
