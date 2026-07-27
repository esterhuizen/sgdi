// Should the current epoch be (re-)ingested?
//
// A stake pool's ValidatorList is only accurate once the pool has run its
// per-epoch update crank: upstream documents active_stake_lamports as "if
// `last_update_epoch` does not match the current epoch then this field may not
// be accurate" — until then a validator's stake is still parked in
// transient_stake_lamports. Our first tick after a boundary usually lands
// before that crank, so the boundary photo can be wrong (epoch 1007: definSOL
// showed 1 SOL active / 3005 transient for a validator holding 3006).
//
// So the current epoch is re-captured until it has *settled* — every pool
// snapshot taken post-crank AND the run fully succeeded — and then frozen for
// the rest of the epoch, exactly as before. This is a bounded catch-up window,
// not a perpetual refresh.
//
// Pure + dependency-free so both gdi-ingest (which acts on it) and the
// watchdog (which must not alarm on the legitimate re-scores it causes) can
// share one definition, and so it is directly unit-testable.

/** How long after an epoch boundary we keep trying to settle. Pools crank
 *  within minutes; 6h is a generous ceiling that stops a pool which never
 *  cranks (or was removed) from causing refreshes all epoch. */
export const SETTLE_WINDOW_SECONDS = 6 * 3600;

export type EpochGateInput = {
  /** ingestion_runs has a 'success' or 'partial' row for this epoch. */
  alreadyIngested: boolean;
  /** Status of the most recent run for this epoch, null if none. */
  lastRunStatus: string | null;
  /** MIN(last_update_epoch) across this epoch's snapshots; null when no row
   *  carries one (legacy rows written before the column existed). */
  minLastUpdateEpoch: number | null;
  /** The epoch being ingested. */
  epoch: number;
  /** Seconds since the epoch boundary. */
  epochAgeSeconds: number;
};

export function shouldRefreshEpoch(input: EpochGateInput): boolean {
  const { alreadyIngested, lastRunStatus, minLastUpdateEpoch, epoch, epochAgeSeconds } = input;

  // Never ingested this epoch — the caller runs the full path regardless.
  if (!alreadyIngested) return true;

  // Past the catch-up window: whatever we have is what we keep.
  if (epochAgeSeconds >= SETTLE_WINDOW_SECONDS) return false;

  // A run that didn't fully succeed leaves pools stranded for the epoch —
  // retry them while the window is open.
  if (lastRunStatus !== 'success') return true;

  // A pool whose snapshot predates its own crank is a pre-crank photo. Null
  // means no snapshot carries the field (rows from before this column shipped);
  // we can't prove staleness, so we treat the epoch as settled rather than
  // churning on a boundary that has long since passed.
  return minLastUpdateEpoch != null && minLastUpdateEpoch < epoch;
}

export type SettleWindowInput = {
  /** Epoch the previous watchdog tick recorded; null on a fresh state file. */
  prevEpoch: number | null;
  /** Epoch of the leaderboard this tick is looking at. */
  currentEpoch: number;
  /** epoch_first_seen_ms carried in the previous state; undefined when that
   *  state was written before the field existed. */
  prevFirstSeenMs: number | undefined;
  nowMs: number;
};

/**
 * Watchdog companion to shouldRefreshEpoch: is the current epoch still inside
 * the window where gdi-ingest may legitimately re-score it?
 *
 * The watchdog has no chain access, so it ages the window off the first tick
 * that saw the epoch — wall clock — while the ingest gate uses the slot-derived
 * epoch age. The two windows are close but deliberately not identical: the
 * ingest's decides whether to re-capture, this one only decides whether a
 * re-score is worth alerting about, so a few minutes of skew costs nothing.
 *
 * Returns the stamp to persist alongside the decision. The stamp is taken only
 * on a NEW epoch: a state file that pre-dates the field must not be
 * back-stamped with "now", or an epoch that has been running for two days would
 * look freshly seen and blind the check for a whole window.
 */
export function settleWindowState(input: SettleWindowInput): {
  firstSeenMs: number | undefined;
  inSettleWindow: boolean;
} {
  const { prevEpoch, currentEpoch, prevFirstSeenMs, nowMs } = input;

  const firstSeenMs = prevEpoch == null || prevEpoch !== currentEpoch ? nowMs : prevFirstSeenMs;

  // Unknown stamp (state written before this field existed) ⇒ treat the epoch
  // as old, i.e. armed. A negative age means the clock stepped backwards, which
  // is not evidence of a fresh epoch either, so that also reads as armed.
  if (firstSeenMs == null) return { firstSeenMs, inSettleWindow: false };
  const ageMs = nowMs - firstSeenMs;
  return {
    firstSeenMs,
    inSettleWindow: ageMs >= 0 && ageMs < SETTLE_WINDOW_SECONDS * 1000,
  };
}
