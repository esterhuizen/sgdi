// Fixture tests for parseValidatorListAccount (src/lib/gdi/data-sources/rpc.ts).
//
// Run via: node --test --experimental-strip-types tests/validator-list-decode.test.ts
//
// The decoder reads a packed SPL-stake-pool ValidatorList by byte offset, so
// nothing but a fixture catches an off-by-N. Layout per upstream
// (solana-program/stake-pool, program/src/state.rs — ValidatorStakeInfo):
//
//   active_stake_lamports    u64   0..8
//   transient_stake_lamports u64   8..16
//   last_update_epoch        u64  16..24   ← the settle gate's input
//   transient_seed_suffix    u64  24..32
//   unused                   u32  32..36
//   validator_seed_suffix    u32  36..40
//   status                   u8   40
//   vote_account_address     [32] 41..73
//
// Every field we do NOT read is filled with 0xFF here, so an offset that
// slipped would pull in that poison value instead of the expected one.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseValidatorListAccount } from '../src/lib/gdi/data-sources/rpc.ts';

const ITEM_SIZE = 73;
const HEADER_SIZE = 9;
const ACCOUNT_TYPE_VALIDATOR_LIST = 2;

function entryBuf(fields: {
  active: bigint;
  transient: bigint;
  lastUpdateEpoch: number;
  status: number;
  vote: Buffer;
}): Buffer {
  const b = Buffer.alloc(ITEM_SIZE, 0xff); // poison every unread byte
  b.writeBigUInt64LE(fields.active, 0);
  b.writeBigUInt64LE(fields.transient, 8);
  b.writeBigUInt64LE(BigInt(fields.lastUpdateEpoch), 16);
  // 24..40 (transient_seed_suffix, unused, validator_seed_suffix) stay 0xFF.
  b.writeUInt8(fields.status, 40);
  fields.vote.copy(b, 41);
  return b;
}

function listBuf(entries: Buffer[], opts: { maxValidators?: number; count?: number; accountType?: number } = {}): Buffer {
  const b = Buffer.alloc(HEADER_SIZE + entries.length * ITEM_SIZE);
  b.writeUInt8(opts.accountType ?? ACCOUNT_TYPE_VALIDATOR_LIST, 0);
  b.writeUInt32LE(opts.maxValidators ?? entries.length + 5, 1);
  b.writeUInt32LE(opts.count ?? entries.length, 5);
  entries.forEach((e, i) => e.copy(b, HEADER_SIZE + i * ITEM_SIZE));
  return b;
}

// 32 zero bytes base58-encode to 32 '1's (the System Program address); 31 zero
// bytes followed by 0x01 encode to 31 '1's then '2'. Both are hand-checkable,
// so the vote-account assertions don't lean on the encoder they're testing.
const VOTE_ZEROS = Buffer.alloc(32, 0x00);
const VOTE_ONE = Buffer.concat([Buffer.alloc(31, 0x00), Buffer.from([0x01])]);
const VOTE_ZEROS_B58 = '1'.repeat(32);
const VOTE_ONE_B58 = '1'.repeat(31) + '2';

test('parseValidatorListAccount: decodes every field at its own offset', () => {
  const buf = listBuf([
    entryBuf({
      active: 3_006_400_000_000n,
      transient: 0n,
      lastUpdateEpoch: 1007,
      status: 0,
      vote: VOTE_ZEROS,
    }),
  ]);
  const list = parseValidatorListAccount(buf);
  assert.equal(list.count, 1);
  assert.equal(list.validators.length, 1);
  const v = list.validators[0];
  assert.equal(v.activeStakeLamports, 3_006_400_000_000n);
  assert.equal(v.transientStakeLamports, 0n);
  assert.equal(v.lastUpdateEpoch, 1007);
  assert.equal(v.status, 0);
  assert.equal(v.votePubkey, VOTE_ZEROS_B58);
});

test('parseValidatorListAccount: the epoch-1007 pre-crank shape round-trips', () => {
  // The real defect: pool cranked in 1006, so the entry still reports the old
  // epoch with the stake parked in transient. This is exactly what the settle
  // gate keys on.
  const buf = listBuf([
    entryBuf({
      active: 1_000_000_000n,
      transient: 3_005_400_000_000n,
      lastUpdateEpoch: 1006,
      status: 0,
      vote: VOTE_ONE,
    }),
  ]);
  const v = parseValidatorListAccount(buf).validators[0];
  assert.equal(v.activeStakeLamports, 1_000_000_000n);
  assert.equal(v.transientStakeLamports, 3_005_400_000_000n);
  assert.equal(v.lastUpdateEpoch, 1006);
  assert.equal(v.votePubkey, VOTE_ONE_B58);
});

test('parseValidatorListAccount: entries are read at the right stride', () => {
  const buf = listBuf([
    entryBuf({ active: 1n, transient: 2n, lastUpdateEpoch: 1000, status: 0, vote: VOTE_ZEROS }),
    entryBuf({ active: 7n, transient: 8n, lastUpdateEpoch: 1007, status: 1, vote: VOTE_ONE }),
    entryBuf({ active: 9n, transient: 0n, lastUpdateEpoch: 1006, status: 4, vote: VOTE_ZEROS }),
  ]);
  const vs = parseValidatorListAccount(buf).validators;
  assert.equal(vs.length, 3);
  assert.deepEqual(vs.map((v) => v.activeStakeLamports), [1n, 7n, 9n]);
  assert.deepEqual(vs.map((v) => v.transientStakeLamports), [2n, 8n, 0n]);
  assert.deepEqual(vs.map((v) => v.lastUpdateEpoch), [1000, 1007, 1006]);
  assert.deepEqual(vs.map((v) => v.status), [0, 1, 4]);
  assert.deepEqual(vs.map((v) => v.votePubkey), [VOTE_ZEROS_B58, VOTE_ONE_B58, VOTE_ZEROS_B58]);
});

test('parseValidatorListAccount: rejects a non-ValidatorList account', () => {
  const buf = listBuf([entryBuf({ active: 1n, transient: 0n, lastUpdateEpoch: 1007, status: 0, vote: VOTE_ZEROS })], {
    accountType: 1, // StakePool
  });
  assert.throws(() => parseValidatorListAccount(buf), /account type byte = 1/);
});

test('parseValidatorListAccount: rejects count > max_validators', () => {
  const buf = listBuf([entryBuf({ active: 1n, transient: 0n, lastUpdateEpoch: 1007, status: 0, vote: VOTE_ZEROS })], {
    maxValidators: 1,
    count: 2,
  });
  assert.throws(() => parseValidatorListAccount(buf), /validators_count/);
});

test('parseValidatorListAccount: empty list decodes to no validators', () => {
  const list = parseValidatorListAccount(listBuf([], { maxValidators: 10 }));
  assert.equal(list.count, 0);
  assert.deepEqual(list.validators, []);
});
