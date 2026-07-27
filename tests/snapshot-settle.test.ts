// Settle gate: the rule that decides whether the current epoch gets
// re-captured, plus the two storage reads that feed it.
//
// Run via: node --test --experimental-strip-types tests/snapshot-settle.test.ts
//
// Why this matters: the first ingest after an epoch boundary usually lands
// before the stake pools crank transient stake into active, so its snapshot is
// a pre-crank photo. The gate keeps re-capturing until every pool reports a
// crank epoch equal to the current one, then freezes for the rest of the epoch.
// Both directions are bugs — never refreshing publishes wrong stake for ~2
// days, always refreshing hammers RPC and re-scores forever.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  shouldRefreshEpoch,
  settleWindowState,
  SETTLE_WINDOW_SECONDS,
} from '../src/lib/gdi/epoch-gate.ts';
import { openStorage } from '../src/lib/gdi/storage.ts';

const EPOCH = 1007;
const YOUNG = 20 * 60;              // 20 min into the epoch
const OLD   = SETTLE_WINDOW_SECONDS + 60;

// Defaults describe a settled epoch; each test overrides just what it exercises.
const gate = (over: Partial<Parameters<typeof shouldRefreshEpoch>[0]> = {}) =>
  shouldRefreshEpoch({
    alreadyIngested: true,
    lastRunStatus: 'success',
    minLastUpdateEpoch: EPOCH,
    epoch: EPOCH,
    epochAgeSeconds: YOUNG,
    ...over,
  });

// ───────────────────────────────────────────────────────────────────────────
// shouldRefreshEpoch
// ───────────────────────────────────────────────────────────────────────────

test('gate: epoch never ingested → full path', () => {
  assert.equal(gate({ alreadyIngested: false, lastRunStatus: null, minLastUpdateEpoch: null }), true);
  // Age is irrelevant on a first ingest — a late boundary run still runs.
  assert.equal(
    gate({ alreadyIngested: false, lastRunStatus: null, minLastUpdateEpoch: null, epochAgeSeconds: OLD }),
    true,
  );
});

test('gate: ingested, a pool photographed pre-crank, epoch young → refresh', () => {
  assert.equal(gate({ minLastUpdateEpoch: EPOCH - 1 }), true);
});

test('gate: ingested, pre-crank photo, past the settle window → freeze', () => {
  // A pool that never cranks must not cause refreshes for the whole epoch.
  assert.equal(gate({ minLastUpdateEpoch: EPOCH - 1, epochAgeSeconds: OLD }), false);
  // Boundary is exclusive: exactly at the window, we stop.
  assert.equal(
    gate({ minLastUpdateEpoch: EPOCH - 1, epochAgeSeconds: SETTLE_WINDOW_SECONDS }),
    false,
  );
});

test('gate: ingested, every pool cranked, run succeeded → skip', () => {
  assert.equal(gate(), false);
});

test('gate: ingested and cranked but last run only partial, epoch young → refresh', () => {
  // Pools that failed on the boundary run used to be stranded for the epoch.
  assert.equal(gate({ lastRunStatus: 'partial' }), true);
  assert.equal(gate({ lastRunStatus: 'failed' }), true);
  assert.equal(gate({ lastRunStatus: null }), true);
});

test('gate: a partial run past the settle window still freezes', () => {
  assert.equal(gate({ lastRunStatus: 'partial', epochAgeSeconds: OLD }), false);
});

test('gate: null crank epoch (legacy rows) counts as settled', () => {
  // Deploying mid-epoch must not restart the pipeline on a boundary long past.
  assert.equal(gate({ minLastUpdateEpoch: null }), false);
  // ...but an unsuccessful run is still retried, legacy rows or not.
  assert.equal(gate({ minLastUpdateEpoch: null, lastRunStatus: 'partial' }), true);
});

test('gate: a crank epoch ahead of ours is not treated as stale', () => {
  assert.equal(gate({ minLastUpdateEpoch: EPOCH + 1 }), false);
});

// ───────────────────────────────────────────────────────────────────────────
// settleWindowState — the watchdog's arm/disarm decision for check 3b
// ───────────────────────────────────────────────────────────────────────────

const NOW = 1_800_000_000_000; // fixed wall clock, ms
const WINDOW_MS = SETTLE_WINDOW_SECONDS * 1000;

test('settle window: state file predating the field reads as armed, and is NOT back-stamped', () => {
  // The live watchdog-sanity.state has no epoch_first_seen_ms. Stamping "now"
  // on it would make a 45h-old epoch look freshly seen and blind 3b for 6h.
  const r = settleWindowState({
    prevEpoch: EPOCH,
    currentEpoch: EPOCH,
    prevFirstSeenMs: undefined,
    nowMs: NOW,
  });
  assert.equal(r.firstSeenMs, undefined);
  assert.equal(r.inSettleWindow, false);
});

test('settle window: a new epoch is stamped and disarms the check', () => {
  const fresh = settleWindowState({
    prevEpoch: null,
    currentEpoch: EPOCH,
    prevFirstSeenMs: undefined,
    nowMs: NOW,
  });
  assert.equal(fresh.firstSeenMs, NOW);
  assert.equal(fresh.inSettleWindow, true);

  const rolled = settleWindowState({
    prevEpoch: EPOCH - 1,
    currentEpoch: EPOCH,
    prevFirstSeenMs: NOW - 40 * 3600_000,
    nowMs: NOW,
  });
  assert.equal(rolled.firstSeenMs, NOW);
  assert.equal(rolled.inSettleWindow, true);
});

test('settle window: same epoch carries the original stamp forward', () => {
  const stamp = NOW - 3600_000; // seen an hour ago
  const r = settleWindowState({
    prevEpoch: EPOCH,
    currentEpoch: EPOCH,
    prevFirstSeenMs: stamp,
    nowMs: NOW,
  });
  assert.equal(r.firstSeenMs, stamp, 'stamp must not be refreshed each tick');
  assert.equal(r.inSettleWindow, true);
});

test('settle window: re-arms once the window has passed', () => {
  const past = settleWindowState({
    prevEpoch: EPOCH,
    currentEpoch: EPOCH,
    prevFirstSeenMs: NOW - WINDOW_MS - 1,
    nowMs: NOW,
  });
  assert.equal(past.inSettleWindow, false);

  // Boundary is exclusive, same as the ingest gate.
  const exact = settleWindowState({
    prevEpoch: EPOCH,
    currentEpoch: EPOCH,
    prevFirstSeenMs: NOW - WINDOW_MS,
    nowMs: NOW,
  });
  assert.equal(exact.inSettleWindow, false);
});

test('settle window: a backwards clock step reads as armed, not as a fresh epoch', () => {
  const r = settleWindowState({
    prevEpoch: EPOCH,
    currentEpoch: EPOCH,
    prevFirstSeenMs: NOW + 3600_000, // stamp in the future
    nowMs: NOW,
  });
  assert.equal(r.inSettleWindow, false);
  assert.equal(r.firstSeenMs, NOW + 3600_000, 'stamp is preserved, not rewritten');
});

// ───────────────────────────────────────────────────────────────────────────
// storage reads feeding the gate
// ───────────────────────────────────────────────────────────────────────────

type Storage = ReturnType<typeof openStorage>;

function memStorage(): Storage {
  return openStorage(':memory:');
}

const snap = (pubkey: string, lastUpdateEpoch: number) => ({
  validator_pubkey: pubkey,
  stake_lamports: 1_000_000_000n,
  transient_stake_lamports: 0n,
  validator_status: 0,
  last_update_epoch: lastUpdateEpoch,
  captured_at: 1_700_000_000,
});

test('storage: last_update_epoch round-trips through replaceSnapshotsForPoolEpoch', () => {
  const storage = memStorage();
  try {
    storage.replaceSnapshotsForPoolEpoch(EPOCH, 'PoolA', [snap('Val1', EPOCH)]);
    const rows = storage.listSnapshotsForPoolEpoch(EPOCH, 'PoolA');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].last_update_epoch, EPOCH);
  } finally {
    storage.close();
  }
});

test('storage: minLastUpdateEpochForEpoch takes the oldest crank across pools', () => {
  const storage = memStorage();
  try {
    storage.replaceSnapshotsForPoolEpoch(EPOCH, 'PoolA', [snap('Val1', EPOCH), snap('Val2', EPOCH)]);
    storage.replaceSnapshotsForPoolEpoch(EPOCH, 'PoolB', [snap('Val1', EPOCH - 1)]);
    // PoolB hasn't cranked → the epoch is not settled.
    assert.equal(storage.minLastUpdateEpochForEpoch(EPOCH), EPOCH - 1);
    // Re-capture PoolB post-crank → settled.
    storage.replaceSnapshotsForPoolEpoch(EPOCH, 'PoolB', [snap('Val1', EPOCH)]);
    assert.equal(storage.minLastUpdateEpochForEpoch(EPOCH), EPOCH);
  } finally {
    storage.close();
  }
});

test('storage: minLastUpdateEpochForEpoch is scoped to the epoch and null when empty', () => {
  const storage = memStorage();
  try {
    assert.equal(storage.minLastUpdateEpochForEpoch(EPOCH), null);
    storage.replaceSnapshotsForPoolEpoch(EPOCH - 1, 'PoolA', [snap('Val1', EPOCH - 5)]);
    assert.equal(storage.minLastUpdateEpochForEpoch(EPOCH), null);
    assert.equal(storage.minLastUpdateEpochForEpoch(EPOCH - 1), EPOCH - 5);
  } finally {
    storage.close();
  }
});

test('storage: legacy rows without last_update_epoch read as null, not 0', () => {
  const storage = memStorage();
  try {
    // Simulate rows written before the column existed.
    storage.db
      .prepare(
        `INSERT INTO pool_snapshots (epoch, pool_address, validator_pubkey, stake_lamports, captured_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(EPOCH, 'PoolLegacy', 'Val1', 1_000_000_000n, 1_700_000_000);
    assert.equal(storage.minLastUpdateEpochForEpoch(EPOCH), null);
    assert.equal(shouldRefreshEpoch({
      alreadyIngested: true,
      lastRunStatus: 'success',
      minLastUpdateEpoch: storage.minLastUpdateEpochForEpoch(EPOCH),
      epoch: EPOCH,
      epochAgeSeconds: YOUNG,
    }), false);

    // Mixed epoch: one migrated pool proves a pre-crank photo even though the
    // legacy rows carry no value. SQL MIN skips NULLs, so we still see it.
    storage.replaceSnapshotsForPoolEpoch(EPOCH, 'PoolB', [snap('Val2', EPOCH - 1)]);
    assert.equal(storage.minLastUpdateEpochForEpoch(EPOCH), EPOCH - 1);
  } finally {
    storage.close();
  }
});

test('storage: lastRunStatusForEpoch returns the newest run by started_at', () => {
  const storage = memStorage();
  try {
    assert.equal(storage.lastRunStatusForEpoch(EPOCH), null);

    storage.startRun({ run_id: 'run-a', epoch: EPOCH, started_at: 100, status: 'in_progress' });
    storage.finishRun({ run_id: 'run-a', finished_at: 150, status: 'partial', pools_processed: 3, pools_failed: 1 });
    assert.equal(storage.lastRunStatusForEpoch(EPOCH), 'partial');

    storage.startRun({ run_id: 'run-b', epoch: EPOCH, started_at: 200, status: 'in_progress' });
    storage.finishRun({ run_id: 'run-b', finished_at: 260, status: 'success', pools_processed: 4, pools_failed: 0 });
    assert.equal(storage.lastRunStatusForEpoch(EPOCH), 'success');

    // Scoped per epoch.
    assert.equal(storage.lastRunStatusForEpoch(EPOCH + 1), null);
  } finally {
    storage.close();
  }
});
