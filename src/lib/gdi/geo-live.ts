// Live geo — a continuously-refreshed, flap-suppressed view of where each
// validator actually is right now.
//
// WHY THIS EXISTS
// ---------------
// The per-epoch shadow-geoip capture (gdi-ingest.ts step 8b) writes
// validator_geo_shadow only while the epoch is still inside its settle window,
// then freezes for the remaining ~40+ hours. That has two consequences, and the
// StakeCraft incident of 2026-08-26 hit both at once: a single gossip-IP flap
// (HK → Frankfurt, back within minutes) landed inside the settle window, was
// captured as the epoch's truth, and stayed the system's answer for the rest of
// the epoch — a whole-epoch relocation inferred from ONE observation.
//
// This pass fixes the observation side of that: it runs on EVERY ingest tick
// (~15 min), on both the full-ingest path and the settled skip path, and it
// never trusts one observation. `getClusterNodes()` is already fetched on both
// paths and its gossip IPs already thrown away, so the freshness is free — no
// new RPC call, no new secret, no second writer to gdi.db.
//
// THE RULE: K-consecutive, tuple-as-a-unit
// ----------------------------------------
// A new (country, city, asn, asn_name) tuple becomes a CANDIDATE. It only
// replaces the stable tuple after K counted observations that all agree AND at
// least MIN_DWELL_S of wall clock. A single observation that agrees with the
// incumbent abandons the candidate outright. So under ambiguity — the chronic
// flappers that alternate between two datacentres — the machine keeps the
// incumbent and flags the row `moving`, rather than picking a side and changing
// its mind. For a value that gates stake movement, "keep the incumbent under
// ambiguity" is the only defensible bias.
//
// The tuple is debounced as a UNIT, deliberately. Per-dimension debouncing can
// promote country without city and produce a `Hong Kong / Frankfurt am Main`
// chimera that lands in the wrong city bucket. NULL is a value here: a
// (HK, Hong Kong, AS46873) → (HK, NULL, AS46873) transition is a candidate like
// any other and debounces like any other.
//
// Comparison happens on the CANONICALISED tuple, imported from merge-geo.ts and
// never re-implemented: "46873" and "AS46873" are the same ASN, "Sao Paulo" and
// "São Paulo" the same city. Debouncing raw strings would burn K ticks on a
// MaxMind formatting revision.
//
// Bootstrap seeds stable_* from the newest validator_geo_shadow row per
// validator, so day-0 state is exactly what the system already believed — this
// pass is a provable no-op for every consumer on the tick it first runs.
//
// Nothing here throws into the ingest run: the two call sites in gdi-ingest.ts
// wrap it, exactly as step 8b wraps itself.

import {
  canonicalCountry,
  canonicalCity,
  canonicalAsn,
  canonicalPassthrough,
} from './data-sources/merge-geo.ts';
import type { GeoLookup, LocalGeoipResult } from './data-sources/local-geoip.ts';
import type { ModuleLogger } from './logger.ts';
import type {
  GeoLiveMetaRow,
  Storage,
  ValidatorGeoEventRow,
  ValidatorGeoLiveRow,
  ValidatorGeoOverrideRow,
  ValidatorGeoShadowRow,
} from './storage.ts';

// ── Configuration ──────────────────────────────────────────────────────────
// Every knob is env-overridable, and every knob is parsed defensively: an
// unset, empty or non-numeric value falls back to the default, and the result
// is clamped. `SGDI_GEO_STABLE_K=` (a deploy that drops the value) must not
// silently become K=0 — promote on the very first observation, i.e. exactly the
// incident this module exists to prevent — and a NaN must not become a machine
// that never promotes at all. Neither failure is visible without a check like
// this, and neither is acceptable for state that money reads.
function envNumber(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, n);
}

/** Boolean knob, same failure philosophy: unset, empty or unrecognised falls
 *  back to the default rather than silently flipping behaviour. A rollback
 *  switch that a typo could turn ON is not a rollback switch. */
function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === '') return fallback;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  return fallback;
}

// K=6 at the 15-min ingest cadence ≈ 90 minutes of agreement before a move is
// believed. Sized on ASYMMETRIC cost, not on data (the per-epoch shadow table
// cannot distinguish a 5-minute flap from a 2-day move, so there is nothing to
// fit): a large K costs a delay before a genuine relocation reprices — and the
// optimiser plans ~36h into a ~46h epoch with moves that activate at N+1, so 90
// minutes is ~0.2% of that horizon. A small K costs a flap moving real stake.
// When one side of a tradeoff is free, take the conservative side. Re-derive
// empirically from validator_geo_events.dwell_s (the flap-duration histogram)
// once a few weeks have accumulated.
const STABLE_K = envNumber('SGDI_GEO_STABLE_K', 6, 1);

// Wall-clock floor on a promotion. K counted in ticks alone is fragile if ticks
// bunch: gdi-ingest.timer is Persistent=true, and a catch-up after downtime or
// an operator looping gdi-cycle.sh by hand could deliver six observations in
// three minutes. A promotion needs K observations AND real elapsed time.
const STABLE_MIN_DWELL_S = envNumber('SGDI_GEO_STABLE_MIN_DWELL_S', 3600, 0);

// An observation closer than this to the last COUNTED one refreshes raw_* but
// does not count toward the machine — see the counting guard below.
const COUNT_INTERVAL_S = envNumber('SGDI_GEO_COUNT_INTERVAL_S', 300, 0);

const EVENT_RETENTION_DAYS = envNumber('SGDI_GEO_EVENT_RETENTION_DAYS', 90, 0);

// Promotions in one tick, as a percentage of validators present that tick. The
// fleet does not relocate together; a spike means a systematic re-mapping —
// almost always the weekly GeoLite2 refresh, which is why geo_live_meta carries
// the .mmdb mtimes. Guarded by an ABSOLUTE floor as well: only ~688 validators
// are present on a normal tick, so 0.5% of them is 4 promotions — ordinary
// churn, not an event. Both conditions must hold before this warns.
const MASS_CHANGE_ALERT_PCT = envNumber('SGDI_GEO_MASS_CHANGE_ALERT_PCT_PER_TICK', 0.5, 0);
const MASS_CHANGE_MIN_PROMOTIONS = 10;

// Bootstraps in one tick, as a fraction of the fleet, on a run that did NOT
// find an empty table. A first-ever run bootstraps everything and is expected;
// a later run bootstrapping 1% of the fleet means rows are being lost.
const MASS_BOOTSTRAP_WARN_FRACTION = 0.01;

// ── The stamp gate ─────────────────────────────────────────────────────────
// A tick that saw nothing useful is not a tick, and must not look fresh. The
// DENOMINATOR is the load-bearing decision here: only ~688 of the ~2,656 fleet
// validators advertise a resolvable gossip endpoint at all (measured, stable
// across 46 epochs), so present/observed sits near 0.26 permanently. Gating on
// that ratio would mean the stamp is never written, geo-live.json is never
// published, and the watchdog alerts forever — a pass that works perfectly
// while looking dead.
//
// So the gate is two independent conditions over the validators we can actually
// see:
//   present / with_ip  >= MIN_COVERAGE  →  MaxMind resolves what we can see
//                                          (688/688 at epoch 1023)
//   with_ip            >= MIN_WITH_IP   →  getClusterNodes did not degrade
// The second is what stops a partial RPC return — 200 endpoints, all resolving
// perfectly — from stamping a tick that looked at a quarter of the fleet.
const MIN_COVERAGE = 0.8;
const MIN_WITH_IP = envNumber('SGDI_GEO_MIN_WITH_IP', 400, 0);

// ── S2: how stale the live pass may be before the frozen photograph stops
//    trusting it ─────────────────────────────────────────────────────────────
// The run-level bound is what lets the LIVE pass's kill switch revert the
// FROZEN photograph too, without a second lever. Turn the live pass off
// (SGDI_GEO_LIVE_ENABLED=false), or let it start failing its stamp gate, and
// geo_live_meta simply stops advancing; within FROZEN_MAX_AGE_S the photograph
// goes back to taking its BASE from the instantaneous lookup, on its own, with
// no redeploy. 2h ≈ 8 missed ticks.
//
// Scope note, true of SGDI_GEO_FROZEN_FROM_STABLE as well: what reverts is the
// choice of BASE. The canonicalisation of the stored values and of the match
// flags is not gated and stays on — see buildShadowRow.
//
// Read per call, not at import: these are one-shot scripts, so the cost is nil
// and an operator's `systemctl set-environment` takes effect on the next run.
const frozenMaxAgeS = (): number => envNumber('SGDI_GEO_FROZEN_MAX_AGE_S', 7200, 0);

// The row-level bound. A validator that has been out of gossip for longer than
// this must not have a stale stable tuple frozen into a new epoch's photograph:
// its instantaneous lookup returns EMPTY, which is exactly what the photograph
// recorded for it before S2. ~1 epoch (2 days).
const frozenRowMaxAgeS = (): number => envNumber('SGDI_GEO_FROZEN_ROW_MAX_AGE_S', 172_800, 0);

/** Age bounded to [0, max]. A NEGATIVE age — a clock stepped backwards, a DB
 *  restored from a future backup, a stamp written by a host with a bad clock —
 *  is not "very fresh", it is unexplained, and unexplained is not a state in
 *  which to trust a value that gets frozen for a whole epoch. */
const ageWithin = (ageS: number, maxS: number): boolean => ageS >= 0 && ageS <= maxS;

/** The debounced unit. All four dimensions move together, nulls included. */
type GeoTuple = {
  country: string | null;
  city: string | null;
  asn: string | null;
  asn_name: string | null;
};

const NULL_TUPLE: GeoTuple = { country: null, city: null, asn: null, asn_name: null };

/** Tuple equality with NULL treated as a value (see the header note). */
function tupleEq(a: GeoTuple, b: GeoTuple): boolean {
  return a.country === b.country
    && a.city === b.city
    && a.asn === b.asn
    && a.asn_name === b.asn_name;
}

const stableOf = (r: ValidatorGeoLiveRow): GeoTuple => ({
  country: r.stable_country,
  city: r.stable_city,
  asn: r.stable_asn,
  asn_name: r.stable_asn_name,
});

const candOf = (r: ValidatorGeoLiveRow): GeoTuple => ({
  country: r.cand_country,
  city: r.cand_city,
  asn: r.cand_asn,
  asn_name: r.cand_asn_name,
});

function setStable(r: ValidatorGeoLiveRow, t: GeoTuple): void {
  r.stable_country = t.country;
  r.stable_city = t.city;
  r.stable_asn = t.asn;
  r.stable_asn_name = t.asn_name;
}

function setCandidate(r: ValidatorGeoLiveRow, t: GeoTuple, firstSeen: number): void {
  r.cand_country = t.country;
  r.cand_city = t.city;
  r.cand_asn = t.asn;
  r.cand_asn_name = t.asn_name;
  r.cand_count = 1;
  r.cand_first_seen = firstSeen;
}

function clearCandidate(r: ValidatorGeoLiveRow): void {
  r.cand_country = null;
  r.cand_city = null;
  r.cand_asn = null;
  r.cand_asn_name = null;
  r.cand_count = 0;
  r.cand_first_seen = null;
}

// ───────────────────────────────────────────────────────────────────────────
// S2 — what the frozen per-epoch photograph (gdi-ingest step 8b) is a photo OF
// ───────────────────────────────────────────────────────────────────────────
//
// Before S2, step 8b photographed an INSTANTANEOUS MaxMind lookup: whatever
// gossip said in the one moment, inside the settle window, that the pass
// happened to run. That is the incident in one sentence — StakeCraft's IP
// flapped to Frankfurt for a few minutes on 2026-08-26, the settle-window tick
// landed inside those minutes, and Frankfurt became epoch 1023's truth for the
// next ~46 hours.
//
// After S2 the photograph is of the DEBOUNCED STABLE TUPLE. A flap that has not
// survived K observations and the dwell floor is, by construction, not what
// gets photographed — no matter when in the settle window the tick lands.
//
// The eligibility rules below are the safety envelope around that. They are
// deliberately conservative in one direction only: every path that is not
// clearly better than the pre-S2 behaviour falls back TO the pre-S2 behaviour.

export type FrozenBasePlan = {
  /** Run-level verdict on whether the live view is fresh enough to read. */
  useStable: boolean;
  reason: 'ok' | 'flag_disabled' | 'no_meta' | 'stale_meta';
  /** Age of the live pass's freshness stamp, in seconds. Null when there is none. */
  metaAgeS: number | null;
  maxAgeS: number;
};

/**
 * Run-level eligibility: is the live view fresh enough for this ingest run to
 * read stable tuples out of it at all?
 *
 * This verdict is all-or-nothing for the RUN: the live view is either live or
 * it is not, and that is a property of the pass, not of any one validator. It
 * does not make the resulting photograph uniform — the row gate in
 * selectFrozenBase still falls back per validator, so an epoch's table
 * legitimately mixes stable rows with instantaneous ones. What "one decision"
 * buys is that the mixture is explained entirely by per-row facts (no live row,
 * uncorroborated stable, long absence) rather than by the pass's health
 * flickering mid-loop.
 */
export function planFrozenBase(meta: GeoLiveMetaRow | undefined, now: number): FrozenBasePlan {
  const maxAgeS = frozenMaxAgeS();
  // The one-env-var rollback. NOTE its exact scope: it reverts the choice of
  // BASE to the pre-S2 instantaneous lookup. It does not, and must not, gate
  // the canonicalisation of stored values and match flags — see buildShadowRow.
  if (!envFlag('SGDI_GEO_FROZEN_FROM_STABLE', true)) {
    return { useStable: false, reason: 'flag_disabled', metaAgeS: null, maxAgeS };
  }
  // No stamp at all: the live pass has never completed a tick. Nothing to read.
  // A warming-up database, not an incident — the caller logs it accordingly.
  if (!meta) return { useStable: false, reason: 'no_meta', metaAgeS: null, maxAgeS };
  const metaAgeS = now - meta.last_tick_at;
  // A stale stamp means the live view is no longer live. Reading a frozen
  // "stable" tuple out of a dead pass would reintroduce exactly the class of
  // bug S1 exists to kill — a stale value presented as current.
  if (!ageWithin(metaAgeS, maxAgeS)) return { useStable: false, reason: 'stale_meta', metaAgeS, maxAgeS };
  return { useStable: true, reason: 'ok', metaAgeS, maxAgeS };
}

export type FrozenBaseSelection = {
  /** GeoLookup-shaped so the override layering is unchanged by S2. */
  base: GeoLookup;
  source: 'stable' | 'instantaneous';
  /** Why the stable tuple was not used. 'ok' when it was. */
  fallbackReason: 'ok' | 'run_gate' | 'no_row' | 'no_stable' | 'uncorroborated' | 'absent';
  /** The stable tuple's corroborating observation count, for the evidence line. */
  observations: number;
  candCount: number;
  /** The live row's recorded IP, when the stable tuple was used. */
  stableIp: string | null;
};

/** The pass's own definition of "located": city and org name alone do not
 *  place a validator in any scored bucket. Used for the stable-usability gate
 *  and for the evidence predicate, so all three agree. */
const isPlaced = (t: GeoTuple): boolean => t.country != null || t.asn != null;

/** Equality over the three SCORED dimensions. asn_name is excluded on purpose:
 *  registry org-name churn ("Hetzner Online GmbH" → "Hetzner Online") moves no
 *  bucket and must not be reported as a suppressed flap. */
const scoredEq = (a: GeoTuple, b: GeoTuple): boolean =>
  a.country === b.country && a.city === b.city && a.asn === b.asn;

/**
 * Row-level selection. Pure: every input is a value, nothing is read here.
 *
 * Falls back to the instantaneous lookup — i.e. to exactly what 8b did before
 * S2 — whenever the stable tuple is not clearly better:
 *   - run_gate:        the run-level plan said no
 *   - no_row:          the validator has no live row yet
 *   - no_stable:       its stable tuple places it nowhere (no country, no ASN)
 *   - uncorroborated:  its stable tuple has ZERO observations behind it
 *   - absent:          it has been out of gossip longer than the row bound
 * In the last case the instantaneous lookup yields EMPTY, which is precisely
 * what the photograph would have recorded for an unreachable validator anyway.
 *
 * `uncorroborated` is the one that is easy to miss and is the whole ballgame.
 * A live row bootstrapped from validator_geo_shadow carries
 * stable_observations = 0: its "stable" tuple is an IMPORT of the previous
 * epoch's instantaneous photograph, believed by nobody. If a flap was frozen
 * into that photograph, seeding it and then photographing it back out would
 * launder the flap into a second epoch under the name "stable" — the very loop
 * S2 exists to break. Verified against production: StakeCraft's seeded stable
 * IS its Frankfurt flap value, with observations = 0. Until the live pass has
 * counted at least one observation agreeing with it, that tuple is not
 * evidence, and the photograph takes its own instantaneous lookup instead.
 */
export function selectFrozenBase(args: {
  plan: FrozenBasePlan;
  row: ValidatorGeoLiveRow | undefined;
  lookup: GeoLookup;
  now: number;
}): FrozenBaseSelection {
  const { plan, row, lookup, now } = args;
  const instantaneous = (
    fallbackReason: FrozenBaseSelection['fallbackReason'],
  ): FrozenBaseSelection => ({
    base: lookup, source: 'instantaneous', fallbackReason,
    observations: row?.stable_observations ?? 0, candCount: row?.cand_count ?? 0, stableIp: null,
  });

  if (!plan.useStable) return instantaneous('run_gate');
  if (row == null) return instantaneous('no_row');

  const stable = stableOf(row);
  if (!isPlaced(stable)) return instantaneous('no_stable');
  if (row.stable_observations <= 0) return instantaneous('uncorroborated');
  if (row.last_present_at == null || !ageWithin(now - row.last_present_at, frozenRowMaxAgeS())) {
    return instantaneous('absent');
  }

  return {
    base: { country: stable.country, city: stable.city, asn: stable.asn, asn_org: stable.asn_name },
    source: 'stable',
    fallbackReason: 'ok',
    observations: row.stable_observations,
    candCount: row.cand_count,
    stableIp: row.ip_used,
  };
}

/** What 8b needs to know about a row it just built, for logging and counters.
 *  Everything here is derived, nothing is re-computed by the caller. */
export type ShadowEvidence = {
  source: 'stable' | 'instantaneous';
  fallbackReason: FrozenBaseSelection['fallbackReason'];
  /** The photograph is passing over a DIFFERENT instantaneous answer than the
   *  one it recorded. Every divergence between this artifact and a pre-S2 one
   *  is either this or a recent promote — that is the reconciliation gate. */
  suppressedFlap: boolean;
  /** False when the instantaneous lookup placed the validator nowhere. A
   *  suppressed flap with raw_present=false is the "frozen while absent" case,
   *  which is legitimate but distinguishable. */
  rawPresent: boolean;
  observations: number;
  candCount: number;
  /** The canonicalised instantaneous lookup that was passed over. */
  raw: GeoTuple;
  /** The instantaneous IP behind `raw`. Logs only — never a published field. */
  rawIp: string | null;
};

/**
 * Build ONE validator_geo_shadow row exactly as gdi-ingest step 8b writes it.
 *
 * This function IS 8b's write path — base selection, override layering,
 * canonicalisation, match flags, the ip_used tri-state and the evidence
 * predicate. 8b calls it in its loop and the tests call it directly, so there
 * is no second copy of the logic to drift out of sync.
 *
 * Pure: every input is a value; no I/O, no clock, no env read beyond the
 * eligibility knobs consulted through selectFrozenBase/planFrozenBase.
 */
export function buildShadowRow(args: {
  plan: FrozenBasePlan;
  epoch: number;
  /** The canonical (Stakewiz/VA-derived) side, from the validators table. */
  validator: {
    validator_pubkey: string;
    country: string | null;
    city: string | null;
    asn: string | null;
    asn_name: string | null;
  };
  liveRow: ValidatorGeoLiveRow | undefined;
  /** This tick's instantaneous MaxMind answer, in raw shapes. */
  lookup: GeoLookup;
  /** The IP `lookup` came from. */
  ip: string | null;
  override: ValidatorGeoOverrideRow | null | undefined;
  now: number;
  computedAt: number;
}): { row: ValidatorGeoShadowRow; evidence: ShadowEvidence } {
  const { plan, epoch, validator: v, liveRow, lookup, ip, override: ov, now, computedAt } = args;

  const selection = selectFrozenBase({ plan, row: liveRow, lookup, now });
  const base = selection.base;

  // The evidence predicate compares the recorded tuple against the
  // CANONICALISED INSTANTANEOUS LOOKUP — what this photograph would have
  // recorded before S2 — not against the live row's raw_*. raw_* is the last
  // PRESENT observation, which is stale exactly when the validator is absent
  // this tick, and would then hide the divergence instead of reporting it.
  const raw: GeoTuple = {
    country: canonicalCountry(lookup.country),
    city: canonicalCity(lookup.city),
    asn: canonicalAsn(lookup.asn),
    asn_name: canonicalPassthrough(lookup.asn_org),
  };
  const recorded: GeoTuple = {
    country: canonicalCountry(base.country),
    city: canonicalCity(base.city),
    asn: canonicalAsn(base.asn),
    asn_name: canonicalPassthrough(base.asn_org),
  };
  const suppressedFlap = selection.source === 'stable' && !scoredEq(recorded, raw);

  // Per-validator operator override, layered on the base. Each field
  // independently: override > base. asn_name is overridable too.
  const merged = ov ? {
    country: ov.country ?? base.country,
    city:    ov.city    ?? base.city,
    asn:     ov.asn     ?? base.asn,
    asn_org: ov.asn_name ?? base.asn_org,
  } : base;

  // Canonicalise once, after the override layering, so the STORED shapes are
  // source-independent: a stable tuple, an instantaneous lookup and an operator
  // override all land in the same format. This is NOT gated by
  // SGDI_GEO_FROZEN_FROM_STABLE — gating it would make one epoch's table hold a
  // mix of raw and canonical shapes, which is a third behaviour nobody asked
  // for. It is shape-only and idempotent through mergeGeo.
  const shadow = {
    country: canonicalCountry(merged.country),
    city:    canonicalCity(merged.city),
    asn:     canonicalAsn(merged.asn),
    asn_org: canonicalPassthrough(merged.asn_org),
  };

  // Match flags: canonical on BOTH sides, so the comparison is between like and
  // like. The residual case fold is deliberate — canonicalCity folds known
  // spelling variants but does not case-fold, and merge-geo's own cityEq
  // compares case-insensitively.
  const matchFlag = (a: string | null, b: string | null): number | null => {
    if (a == null || b == null) return null;
    return a.toLowerCase() === b.toLowerCase() ? 1 : 0;
  };

  // ip_used, tri-state. The recorded address must CORROBORATE the recorded geo:
  // this column exists so a later analyst can re-look-up the address and check
  // the answer.
  //   instantaneous  → the address we just looked up
  //   stable, agreed → the live row's address, which produced this tuple
  //   stable, flap   → NULL. The live row's address is the flapping one; paired
  //                    with the pre-flap tuple it would be a row that disproves
  //                    itself on inspection. NULL is already the value on most
  //                    rows (1,968 of 2,656 at epoch 1023) and says honestly
  //                    "no address corroborates this". The suppressed_flap log
  //                    line carries the passed-over address instead.
  const ipUsed = selection.source === 'instantaneous' ? ip
    : suppressedFlap ? null
    : selection.stableIp;

  return {
    row: {
      epoch,
      validator_pubkey: v.validator_pubkey,
      ip_used: ipUsed,
      shadow_country: shadow.country,
      shadow_city: shadow.city,
      shadow_asn: shadow.asn,
      shadow_asn_name: shadow.asn_org,
      canonical_country: v.country,
      canonical_city: v.city,
      canonical_asn: v.asn,
      canonical_asn_name: v.asn_name,
      country_match: matchFlag(shadow.country, canonicalCountry(v.country)),
      city_match:    matchFlag(shadow.city,    canonicalCity(v.city)),
      asn_match:     matchFlag(shadow.asn,     canonicalAsn(v.asn)),
      computed_at: computedAt,
    },
    evidence: {
      source: selection.source,
      fallbackReason: selection.fallbackReason,
      suppressedFlap,
      rawPresent: isPlaced(raw),
      observations: selection.observations,
      candCount: selection.candCount,
      raw,
      rawIp: ip,
    },
  };
}

export type LiveGeoPassInput = {
  storage: Storage;
  /** The validators to observe — needs the vote pubkey and its gossip identity. */
  validators: { validator_pubkey: string; identity_pubkey: string | null }[];
  /** getClusterNodes() output, reused from the caller (never re-fetched here). */
  clusterNodes: { pubkey: string; gossip: string | null; tpu: string | null }[];
  now: number;
  epoch: number | null;
  log: ModuleLogger;
  /** Test seam. Defaults to the real local MaxMind reader, lazily imported
   *  exactly as step 8b imports it. */
  geoipFactory?: () => Promise<LocalGeoipResult>;
};

export type LiveGeoPassResult = {
  /** Non-null when the pass no-opped; the tick counters are then all zero. */
  skipped: null | 'disabled' | 'geoip_unavailable';
  observed: number;
  /** Observed validators that had a gossip/TPU endpoint to look up at all. */
  with_ip: number;
  present: number;
  moving: number;
  promoted: number;
  bootstrapped: number;
  mass_change_pct: number;
  /** False when the stamp gate refused to write geo_live_meta. */
  meta_written: boolean;
};

/**
 * One live-geo tick. Reads gossip IPs the caller already has, looks each one up
 * against the local MaxMind databases, runs the K-consecutive debouncer, and
 * commits every row update, event and the freshness stamp in ONE transaction.
 */
export async function runLiveGeoPass(input: LiveGeoPassInput): Promise<LiveGeoPassResult> {
  const { storage, validators, clusterNodes, now, epoch, log } = input;
  const startedMs = Date.now();
  const noop = {
    observed: 0, with_ip: 0, present: 0, moving: 0, promoted: 0, bootstrapped: 0,
    mass_change_pct: 0, meta_written: false,
  };

  // Kill switch, same shape as the shadow pass's SGDI_SHADOW_ENABLED.
  if (process.env.SGDI_GEO_LIVE_ENABLED === 'false') {
    log.info('geo.live.disabled', { reason: 'SGDI_GEO_LIVE_ENABLED=false' });
    return { skipped: 'disabled', ...noop };
  }

  const geoipFactory = input.geoipFactory ?? (async () => {
    const { createLocalGeoip } = await import('./data-sources/local-geoip.ts');
    return createLocalGeoip();
  });
  const geoipRes = await geoipFactory();
  if (!geoipRes.ok) {
    // Missing/corrupt .mmdb (e.g. the microsecond mid-rename during the weekly
    // refresh). No observations means no counter movement and no promotions —
    // a safe no-op, not a data event.
    log.warn('geo.live.skipped', { reason: geoipRes.reason, detail: geoipRes.detail });
    return { skipped: 'geoip_unavailable', ...noop };
  }
  const { geoip } = geoipRes;

  // Identity pubkey → IP. Gossip preferred, TPU as fallback, port stripped —
  // mirrors the shadow pass's construction so both see the same endpoint.
  const ipByIdentity = new Map<string, string>();
  for (const n of clusterNodes) {
    const endpoint = n.gossip ?? n.tpu ?? null;
    if (!endpoint) continue;
    const colon = endpoint.lastIndexOf(':');
    const ip = colon > 0 ? endpoint.slice(0, colon) : endpoint;
    if (ip) ipByIdentity.set(n.pubkey, ip);
  }

  const live = new Map(storage.listGeoLiveAll().map((r) => [r.validator_pubkey, r]));
  // An empty table means this is the first run ever, where bootstrapping the
  // whole fleet is the expected behaviour rather than an alarm.
  const firstEverRun = live.size === 0;

  // Bootstrap seeds — only queried while `live` is incomplete. Once every
  // validator has a row neither the seed nor the override list is consulted
  // again, so both queries are skipped entirely on the steady-state tick.
  const seeds = new Map<string, GeoTuple>();
  const overriddenPubkeys = new Set<string>();
  if (validators.some((v) => !live.has(v.validator_pubkey))) {
    for (const s of storage.listLatestGeoShadow()) {
      seeds.set(s.validator_pubkey, {
        country: canonicalCountry(s.shadow_country),
        city: canonicalCity(s.shadow_city),
        asn: canonicalAsn(s.shadow_asn),
        asn_name: canonicalPassthrough(s.shadow_asn_name),
      });
    }
    // PURITY INVARIANT: this table stores what MaxMind actually said, and
    // nothing else. Operator overrides are applied DOWNSTREAM (by the frozen
    // capture at write time, and by the optimiser through mergeGeo), which is
    // what makes adding or removing an override take effect instantly instead
    // of waiting out a K-observation debounce.
    //
    // The one place that invariant can leak is the bootstrap seed: shadow rows
    // have overrides already baked into them. Seeding from one would import an
    // operator decision into the live table as if MaxMind had said it — and the
    // pass would then spend K ticks "correcting" it back to the raw truth,
    // emitting a promote event that misrepresents a static validator as having
    // relocated. So a validator that HAS an override seeds from its own
    // observation instead. Overrides are never layered into `obs`.
    for (const o of storage.listGeoOverrides()) overriddenPubkeys.add(o.validator_pubkey);
  }

  const updates: ValidatorGeoLiveRow[] = [];
  const events: ValidatorGeoEventRow[] = [];
  // Guards against a caller handing us the same validator twice in one tick:
  // the second copy would be diffed against the pre-tick row rather than the
  // one we just computed, double-counting an observation the machine treats as
  // evidence of stability. Skip it and say so, once.
  const seenThisTick = new Set<string>();
  let duplicateInput = 0;
  let observed = 0;
  let withIpCount = 0;
  let presentCount = 0;
  let promoted = 0;
  let bootstrapped = 0;

  const emit = (
    kind: ValidatorGeoEventRow['kind'],
    pubkey: string,
    from: GeoTuple | null,
    to: GeoTuple | null,
    extra?: { cand_count?: number; dwell_s?: number },
  ): void => {
    events.push({
      at: now,
      validator_pubkey: pubkey,
      kind,
      from_country: from?.country ?? null,
      from_city: from?.city ?? null,
      from_asn: from?.asn ?? null,
      to_country: to?.country ?? null,
      to_city: to?.city ?? null,
      to_asn: to?.asn ?? null,
      cand_count: extra?.cand_count ?? null,
      dwell_s: extra?.dwell_s ?? null,
      epoch,
    });
  };

  for (const v of validators) {
    const pk = v.validator_pubkey;
    if (seenThisTick.has(pk)) {
      duplicateInput++;
      continue;
    }
    seenThisTick.add(pk);
    observed++;
    const ip = v.identity_pubkey ? ipByIdentity.get(v.identity_pubkey) ?? null : null;
    if (ip != null) withIpCount++;
    const lookup = geoip.lookup(ip); // handles a null IP by returning EMPTY
    const obs: GeoTuple = {
      country: canonicalCountry(lookup.country),
      city: canonicalCity(lookup.city),
      asn: canonicalAsn(lookup.asn),
      asn_name: canonicalPassthrough(lookup.asn_org),
    };
    // "Present" = we learned something placeable. City/asn_name alone are not
    // enough to call the validator located.
    const present = obs.country != null || obs.asn != null;
    if (present) presentCount++;

    const prev = live.get(pk);

    // (ii) Bootstrap — BEFORE the counting guard, so a brand-new validator is
    //      always given a row on the tick it first appears. Seeding from the
    //      frozen shadow row (not from this observation) is what makes the
    //      pass's first tick a no-op for every consumer.
    if (!prev) {
      // Two things disqualify a shadow row from being a seed:
      //
      //  1. The validator has an operator override. Its shadow row has that
      //     override baked in, and this table must hold pure MaxMind (see the
      //     purity invariant above).
      //  2. The shadow row is entirely null — 2,773 of the 3,471 latest rows
      //     are, because most validators never advertised a resolvable gossip
      //     endpoint at capture time. An all-null "seed" is not knowledge; it
      //     would park a validator we CAN resolve right now at null geo for six
      //     ticks while the debouncer works up to promoting what we already
      //     know. Fall through to the observation instead.
      const seedRow = seeds.get(pk) ?? null;
      const seed = seedRow != null && !tupleEq(seedRow, NULL_TUPLE) && !overriddenPubkeys.has(pk)
        ? seedRow
        : null;
      const stable = seed ?? (present ? obs : NULL_TUPLE);
      const row: ValidatorGeoLiveRow = {
        validator_pubkey: pk,
        raw_country: obs.country,
        raw_city: obs.city,
        raw_asn: obs.asn,
        raw_asn_name: obs.asn_name,
        ip_used: ip,
        stable_country: stable.country,
        stable_city: stable.city,
        stable_asn: stable.asn,
        stable_asn_name: stable.asn_name,
        stable_since: now,
        // A seeded row has no observations of its own behind it yet.
        stable_observations: seed == null && present ? 1 : 0,
        cand_country: null,
        cand_city: null,
        cand_asn: null,
        cand_asn_name: null,
        cand_count: 0,
        cand_first_seen: null,
        first_observed_at: now,
        last_observed_at: now,
        last_counted_at: present ? now : null,
        last_present_at: present ? now : null,
        missing_streak: present ? 0 : 1,
        bootstrap_source: seed ? 'shadow-seed' : (present ? 'first-observation' : null),
      };
      updates.push(row);
      emit('bootstrap', pk, null, stable);
      // The row is inserted with missing_streak = 1, so it is already in the
      // missing state — record that the same way a running row would, or the
      // 'missing' → 'reappeared' pairing is broken for every validator that was
      // absent on the tick it was first seen (the common case: most of the
      // fleet has no resolvable endpoint).
      if (!present) emit('missing', pk, stable, null);
      bootstrapped++;
      continue;
    }

    // Work on a copy; the row is written WHOLE at commit so the stable tuple
    // can never be observed half-updated.
    const row: ValidatorGeoLiveRow = { ...prev };
    const stable = stableOf(prev);

    // (iii) An absent observation never counts, never resets a candidate and
    //       never clears stable. A validator dropping out of gossip is not
    //       evidence that it moved.
    if (!present) {
      row.missing_streak = prev.missing_streak + 1;
      row.last_observed_at = now;
      // Emit on the TRANSITION into missing — i.e. when the pre-increment
      // streak was 0 — so a validator absent for a week produces one event, not
      // 672 of them.
      if (prev.missing_streak === 0) emit('missing', pk, stable, null);
      updates.push(row);
      continue;
    }

    if (prev.missing_streak > 0) emit('reappeared', pk, null, obs);
    row.missing_streak = 0;
    row.last_present_at = now;
    row.raw_country = obs.country;
    row.raw_city = obs.city;
    row.raw_asn = obs.asn;
    row.raw_asn_name = obs.asn_name;
    row.ip_used = ip;
    row.last_observed_at = now;

    // (i) COUNTING GUARD — against last_COUNTED_at, not last_observed_at.
    //     Bunched ticks still refresh raw_* above but cannot fake 90 minutes of
    //     stability. Anchoring on the last COUNTED observation (rather than the
    //     last observation of any kind) also means a sub-interval cadence
    //     cannot starve the machine: the first observation at least
    //     COUNT_INTERVAL_S after the last counted one counts.
    if (prev.last_counted_at != null && now - prev.last_counted_at < COUNT_INTERVAL_S) {
      updates.push(row);
      continue;
    }

    // (iv) Agrees with stable — THE FLAP FIX. One observation back on the
    //      incumbent kills a pending candidate outright.
    if (tupleEq(obs, stable)) {
      if (prev.cand_count > 0) {
        emit('candidate_abandoned', pk, stable, candOf(prev), {
          cand_count: prev.cand_count,
          dwell_s: now - (prev.cand_first_seen ?? now),
        });
        clearCandidate(row);
      }
      row.stable_observations = prev.stable_observations + 1;
      row.last_counted_at = now;
      updates.push(row);
      continue;
    }

    // (v) Agrees with the pending candidate — count it, and promote once BOTH
    //     the count and the dwell floor are satisfied.
    if (prev.cand_count > 0 && tupleEq(obs, candOf(prev))) {
      row.cand_count = prev.cand_count + 1;
      row.last_counted_at = now;
      const dwellS = now - (prev.cand_first_seen ?? now);
      if (row.cand_count >= STABLE_K && dwellS >= STABLE_MIN_DWELL_S) {
        emit('promote', pk, stable, obs, { cand_count: row.cand_count, dwell_s: dwellS });
        setStable(row, obs);
        row.stable_since = now;
        row.stable_observations = row.cand_count;
        clearCandidate(row);
        promoted++;
      }
      updates.push(row);
      continue;
    }

    // (vi) A new, third value — the pending candidate is abandoned and this one
    //      starts from scratch.
    if (prev.cand_count > 0) {
      emit('candidate_abandoned', pk, stable, candOf(prev), {
        cand_count: prev.cand_count,
        dwell_s: now - (prev.cand_first_seen ?? now),
      });
    }
    emit('raw_change', pk, stable, obs);
    setCandidate(row, obs, now);
    row.last_counted_at = now;
    updates.push(row);
  }

  // Rows carrying a pending change, across the whole table — validators we did
  // not observe this tick keep whatever candidate they had.
  const touched = new Set(updates.map((r) => r.validator_pubkey));
  let moving = 0;
  for (const r of updates) if (r.cand_count > 0) moving++;
  for (const [pk, r] of live) if (!touched.has(pk) && r.cand_count > 0) moving++;

  // The stamp gate. Coverage is measured against the validators that HAD an
  // endpoint to look up (with_ip), never against the whole fleet — see the
  // MIN_WITH_IP block above for why the fleet denominator would wedge this shut.
  const coverage = presentCount / Math.max(1, withIpCount);
  const massChangePct = (100 * promoted) / Math.max(1, presentCount);
  const metaWritten = withIpCount >= MIN_WITH_IP && coverage >= MIN_COVERAGE;
  const retentionCutoff = now - EVENT_RETENTION_DAYS * 86_400;

  storage.runGeoLiveTransaction(() => {
    for (const r of updates) storage.upsertGeoLiveRow(r);
    for (const e of events) storage.insertGeoEvent(e);
    if (metaWritten) {
      storage.upsertGeoLiveMeta({
        last_tick_at: now,
        epoch,
        observed_count: observed,
        with_ip_count: withIpCount,
        present_count: presentCount,
        moving_count: moving,
        promoted_count: promoted,
        bootstrapped_count: bootstrapped,
        mass_change_pct: massChangePct,
        city_mmdb_mtime_ms: geoip.cityMmdbMtimeMs,
        asn_mmdb_mtime_ms: geoip.asnMmdbMtimeMs,
        stable_k: STABLE_K,
        stable_min_dwell_s: STABLE_MIN_DWELL_S,
      });
    }
    storage.deleteGeoEventsBefore(retentionCutoff);
  });

  if (!metaWritten) {
    log.warn('geo.live.no_coverage', {
      observed,
      with_ip: withIpCount,
      present: presentCount,
      coverage: +coverage.toFixed(4),
      min_with_ip: MIN_WITH_IP,
      min_coverage: MIN_COVERAGE,
    });
  }
  // Both conditions, not either: on ~688 present validators the percentage
  // alone fires at 4 promotions, which is a normal tick.
  if (promoted >= MASS_CHANGE_MIN_PROMOTIONS && massChangePct > MASS_CHANGE_ALERT_PCT) {
    log.warn('geo.live.mass_change', {
      promoted,
      present: presentCount,
      mass_change_pct: +massChangePct.toFixed(3),
      threshold_pct: MASS_CHANGE_ALERT_PCT,
      threshold_promotions: MASS_CHANGE_MIN_PROMOTIONS,
      city_mmdb_mtime_ms: geoip.cityMmdbMtimeMs,
      asn_mmdb_mtime_ms: geoip.asnMmdbMtimeMs,
    });
  }
  if (!firstEverRun && bootstrapped > MASS_BOOTSTRAP_WARN_FRACTION * observed) {
    log.warn('geo.live.mass_bootstrap', { bootstrapped, observed });
  }
  if (duplicateInput > 0) {
    log.warn('geo.live.duplicate_input', {
      duplicates: duplicateInput,
      unique: observed,
      hint: 'the caller passed the same validator_pubkey more than once; extra copies were skipped',
    });
  }
  log.info('geo.live.tick', {
    observed,
    with_ip: withIpCount,
    present: presentCount,
    moving,
    promoted,
    bootstrapped,
    meta_written: metaWritten,
    ms: Date.now() - startedMs,
  });

  return {
    skipped: null,
    observed,
    with_ip: withIpCount,
    present: presentCount,
    moving,
    promoted,
    bootstrapped,
    mass_change_pct: massChangePct,
    meta_written: metaWritten,
  };
}
