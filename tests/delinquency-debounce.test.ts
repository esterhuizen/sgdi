// Delinquency hysteresis in the validators upsert (src/lib/gdi/storage.ts).
//
// Run via: node --test --experimental-strip-types tests/delinquency-debounce.test.ts
//
// Regression net for the 2026-06-10 incident: one bad Stakewiz sample flagged a
// 13.4M-SOL validator as delinquent, which emptied its ASN bucket from the
// active set and inflated its pools' GDI by +106% for a publish cycle. The
// effective flag therefore only flips after N consecutive raw=1 samples.
//
// N is a SAMPLE count, so it is tied to the gdi-ingest.timer cadence: 4 samples
// ≈ 1h at the 15-min timer (it was 2 when the timer fired every 30 min). If the
// timer changes again, this test and the SQL both need re-deriving.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { openStorage, type ValidatorRow } from '../src/lib/gdi/storage.ts';

const STREAK_TO_FLIP = 4;
const PUBKEY = 'Vote111111111111111111111111111111111111111';

function row(delinquent: number | null): ValidatorRow {
  return {
    validator_pubkey: PUBKEY,
    identity_pubkey: null,
    identity_name: 'Test Validator',
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
    activated_stake_lamports: 13_400_000 * 1_000_000_000,
    delinquent,
    image_url: null,
    client_name: 'Agave',
    client_version: '3.0.0',
    is_jito: 0,
    is_dz: 0,
    is_bam: 0,
    ibrl_score: null,
  };
}

type Storage = ReturnType<typeof openStorage>;

/** A validator already known to the DB and currently healthy. */
function seeded(): Storage {
  const storage = openStorage(':memory:');
  storage.upsertValidator(row(0));
  return storage;
}

function state(storage: Storage): { delinquent: number | null; streak: number | null } {
  const v = storage.getValidator(PUBKEY) as (ValidatorRow & { delinquent_raw_streak: number | null }) | undefined;
  assert.ok(v, 'validator row should exist');
  return { delinquent: v!.delinquent, streak: v!.delinquent_raw_streak };
}

test('debounce: a single bad sample does not flip the effective flag', () => {
  const storage = seeded();
  try {
    storage.upsertValidator(row(1));
    assert.deepEqual(state(storage), { delinquent: 0, streak: 1 });
  } finally {
    storage.close();
  }
});

test(`debounce: flips only on the ${STREAK_TO_FLIP}th consecutive bad sample`, () => {
  const storage = seeded();
  try {
    for (let n = 1; n < STREAK_TO_FLIP; n++) {
      storage.upsertValidator(row(1));
      assert.deepEqual(
        state(storage),
        { delinquent: 0, streak: n },
        `sample ${n} must not flip the flag`,
      );
    }
    storage.upsertValidator(row(1));
    assert.deepEqual(state(storage), { delinquent: 1, streak: STREAK_TO_FLIP });
  } finally {
    storage.close();
  }
});

test('debounce: one healthy sample clears the streak immediately', () => {
  const storage = seeded();
  try {
    storage.upsertValidator(row(1));
    storage.upsertValidator(row(1));
    storage.upsertValidator(row(1));
    assert.deepEqual(state(storage), { delinquent: 0, streak: 3 });

    // Recovery is immediate — a blip must not leave the counter primed.
    storage.upsertValidator(row(0));
    assert.deepEqual(state(storage), { delinquent: 0, streak: 0 });

    // ...so the count starts over.
    storage.upsertValidator(row(1));
    assert.deepEqual(state(storage), { delinquent: 0, streak: 1 });
  } finally {
    storage.close();
  }
});

test('debounce: a flipped flag clears on the first healthy sample', () => {
  const storage = seeded();
  try {
    for (let n = 0; n < STREAK_TO_FLIP; n++) storage.upsertValidator(row(1));
    assert.deepEqual(state(storage), { delinquent: 1, streak: STREAK_TO_FLIP });

    storage.upsertValidator(row(0));
    assert.deepEqual(state(storage), { delinquent: 0, streak: 0 });
  } finally {
    storage.close();
  }
});

test('debounce: a missing raw sample (null) leaves both fields untouched', () => {
  const storage = seeded();
  try {
    storage.upsertValidator(row(1));
    storage.upsertValidator(row(1));
    const before = state(storage);

    storage.upsertValidator(row(null));
    assert.deepEqual(state(storage), before);
  } finally {
    storage.close();
  }
});
