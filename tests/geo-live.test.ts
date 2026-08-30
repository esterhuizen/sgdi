// The live-geo state machine (src/lib/gdi/geo-live.ts).
//
// Run via: node --test --experimental-strip-types tests/geo-live.test.ts
//
// Regression net for the StakeCraft incident of 2026-08-26: a single gossip-IP
// flap (Hong Kong → Frankfurt and back within minutes) landed inside epoch
// 1023's settle window, was captured as that epoch's truth by the once-per-epoch
// shadow pass, and stayed the system's answer for the rest of the epoch. Test 3
// is that incident, replayed tick by tick, asserting the stable tuple never
// leaves Hong Kong.
//
// Everything runs against an in-memory DB with a MOCKED MaxMind reader
// (`geoipFactory`) and a synthetic clock — never the real .mmdb files, never a
// real DB. `now` is passed in, so a 90-minute dwell costs no wall-clock time.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runSnapshot } from '../scripts/gdi-snapshot.ts';
import {
  openStorage,
  type GeoLiveMetaRow,
  type ValidatorGeoLiveRow,
  type ValidatorGeoShadowRow,
} from '../src/lib/gdi/storage.ts';
import {
  buildShadowRow,
  planFrozenBase,
  runLiveGeoPass,
  selectFrozenBase,
  type FrozenBasePlan,
  type LiveGeoPassResult,
} from '../src/lib/gdi/geo-live.ts';
import {
  canonicalAsn,
  canonicalCity,
  canonicalCountry,
  canonicalPassthrough,
  mergeGeo,
} from '../src/lib/gdi/data-sources/merge-geo.ts';
import type { GeoLookup, LocalGeoipResult } from '../src/lib/gdi/data-sources/local-geoip.ts';
import type { ModuleLogger } from '../src/lib/gdi/logger.ts';

type Storage = ReturnType<typeof openStorage>;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const FIXTURE = join(HERE, 'fixtures', 'gdi-fixture.sqlite');

const V1 = 'Vote111111111111111111111111111111111111111';
const ID1 = 'Iden111111111111111111111111111111111111111';
const EPOCH = 1023;

const T0 = 1_756_000_000;   // arbitrary fixed base; all times are T0 + offset
const TICK = 900;           // the real gdi-ingest.timer cadence

// Raw MaxMind shapes on purpose — ISO-2 country, bare ASN — so every test also
// exercises the canonicalisation the debouncer compares on.
const HK: GeoLookup = { country: 'HK', city: 'Hong Kong', asn: '46873', asn_org: 'Host Color' };
const DE: GeoLookup = { country: 'DE', city: 'Frankfurt am Main', asn: '20326', asn_org: 'TeraSwitch' };
const FR: GeoLookup = { country: 'FR', city: 'Paris', asn: '12322', asn_org: 'Free SAS' };
// Same host, city dimension unresolved — MaxMind can answer ASN without City.
const HK_NO_CITY: GeoLookup = { country: 'HK', city: null, asn: '46873', asn_org: 'Host Color' };

const IP_HK = '45.84.193.5';
const IP_DE = '64.130.50.101';
const IP_FR = '51.15.0.1';

const CITY_MTIME_MS = 1_756_000_000_000;
const ASN_MTIME_MS = 1_756_000_001_000;

const EMPTY: GeoLookup = { country: null, city: null, asn: null, asn_org: null };

type LogLine = { level: string; event: string; ctx: Record<string, unknown> | undefined };

/** Collecting logger — keeps the test silent and lets us assert on events. */
function stubLog(): ModuleLogger & { lines: LogLine[] } {
  const lines: LogLine[] = [];
  const push = (level: string) => (event: string, ctx?: Record<string, unknown>) =>
    void lines.push({ level, event, ctx });
  return {
    runId: 'test',
    module: 'geo-live',
    lines,
    debug: push('DEBUG'),
    info: push('INFO'),
    warn: push('WARN'),
    error: push('ERROR'),
  };
}

/** Mock MaxMind: an ip → lookup table, EMPTY for anything unknown or null. */
function geoipFactory(table: Record<string, GeoLookup>): () => Promise<LocalGeoipResult> {
  return async () => ({
    ok: true,
    geoip: {
      cityMmdbMtimeMs: CITY_MTIME_MS,
      asnMmdbMtimeMs: ASN_MTIME_MS,
      lookup: (ip) => (ip ? table[ip] ?? EMPTY : EMPTY),
    },
  });
}

type TickOpts = {
  now: number;
  /** identity pubkey → IP, or null/absent for "not advertising an endpoint". */
  ips: Record<string, string | null>;
  /** IP → what MaxMind answers for it. */
  lookups: Record<string, GeoLookup>;
  validators?: { validator_pubkey: string; identity_pubkey: string | null }[];
  log?: ModuleLogger;
  /** Override the whole reader — for the .mmdb-unavailable path. */
  geoipFactory?: () => Promise<LocalGeoipResult>;
};

/** One ingest tick's worth of live-geo pass. */
async function tick(storage: Storage, opts: TickOpts): Promise<LiveGeoPassResult> {
  const clusterNodes = Object.entries(opts.ips)
    .filter(([, ip]) => ip != null)
    .map(([pubkey, ip]) => ({ pubkey, gossip: `${ip}:8001`, tpu: null }));
  return runLiveGeoPass({
    storage,
    validators: opts.validators ?? [{ validator_pubkey: V1, identity_pubkey: ID1 }],
    clusterNodes,
    now: opts.now,
    epoch: EPOCH,
    log: opts.log ?? stubLog(),
    geoipFactory: opts.geoipFactory ?? geoipFactory(opts.lookups),
  });
}

/** N validators. Used to clear MIN_WITH_IP, which is 400 by default and is
 *  deliberately NOT lowered for tests — the gate itself is under test. */
function fleet(n: number): { validator_pubkey: string; identity_pubkey: string }[] {
  return Array.from({ length: n }, (_, i) => ({
    validator_pubkey: `Vote_${i}`,
    identity_pubkey: `Iden_${i}`,
  }));
}

/** Assign an endpoint per validator by index; null = advertises none. */
function ipsFor(
  validators: { identity_pubkey: string }[],
  assign: (i: number) => string | null,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  validators.forEach((v, i) => { out[v.identity_pubkey] = assign(i); });
  return out;
}

/** A frozen shadow row for `pubkey` at `epoch`, in RAW MaxMind shapes. */
function seedShadow(storage: Storage, pubkey: string, epoch: number, lk: GeoLookup): void {
  const row: ValidatorGeoShadowRow = {
    epoch,
    validator_pubkey: pubkey,
    ip_used: IP_HK,
    shadow_country: lk.country,
    shadow_city: lk.city,
    shadow_asn: lk.asn,
    shadow_asn_name: lk.asn_org,
    canonical_country: null, canonical_city: null, canonical_asn: null, canonical_asn_name: null,
    country_match: null, city_match: null, asn_match: null,
    computed_at: T0,
  };
  storage.replaceGeoShadowForEpoch(epoch, [row]);
}

const kinds = (storage: Storage, pubkey = V1): string[] =>
  storage.listGeoEventsForValidator(pubkey).map((e) => e.kind);

// ── 1. Bootstrap from the frozen shadow row ────────────────────────────────

test('bootstrap: seeds stable from the newest shadow row, canonicalised', async () => {
  const storage = openStorage(':memory:');
  // Two epochs of shadow history — the NEWEST must win.
  seedShadow(storage, V1, EPOCH - 1, FR);
  seedShadow(storage, V1, EPOCH, HK);

  // The live observation deliberately DISAGREES with the seed, proving stable
  // came from the shadow row and not from this tick's lookup.
  await tick(storage, { now: T0, ips: { [ID1]: IP_DE }, lookups: { [IP_DE]: DE } });

  const row = storage.getGeoLive(V1)!;
  assert.equal(row.bootstrap_source, 'shadow-seed');
  assert.equal(row.stable_country, 'Hong Kong');   // "HK" → Intl → override
  assert.equal(row.stable_city, 'Hong Kong');
  assert.equal(row.stable_asn, 'AS46873');         // "46873" → "AS46873"
  assert.equal(row.stable_asn_name, 'Host Color');
  assert.equal(row.stable_observations, 0);        // the seed brings no observations
  assert.equal(row.stable_since, T0);
  // Raw is this tick's observation; no candidate is opened on the bootstrap tick.
  assert.equal(row.raw_country, 'Germany');
  assert.equal(row.cand_count, 0);
  assert.equal(row.ip_used, IP_DE);
  assert.equal(row.missing_streak, 0);
  assert.equal(row.last_counted_at, T0);

  const events = storage.listGeoEventsForValidator(V1);
  assert.deepEqual(events.map((e) => e.kind), ['bootstrap']);
  assert.equal(events[0].to_country, 'Hong Kong');
  assert.equal(events[0].to_asn, 'AS46873');
  assert.equal(events[0].epoch, EPOCH);
  storage.close();
});

// ── 2. Bootstrap without a shadow row ──────────────────────────────────────

test('bootstrap: falls back to the first observation, or to an all-null tuple', async () => {
  const storage = openStorage(':memory:');
  const V2 = 'Vote222222222222222222222222222222222222222';
  const ID2 = 'Iden222222222222222222222222222222222222222';

  await tick(storage, {
    now: T0,
    ips: { [ID1]: IP_HK, [ID2]: null },   // V2's node advertises no endpoint
    lookups: { [IP_HK]: HK },
    validators: [
      { validator_pubkey: V1, identity_pubkey: ID1 },
      { validator_pubkey: V2, identity_pubkey: ID2 },
    ],
  });

  const seen = storage.getGeoLive(V1)!;
  assert.equal(seen.bootstrap_source, 'first-observation');
  assert.equal(seen.stable_country, 'Hong Kong');
  assert.equal(seen.stable_observations, 1);
  assert.equal(seen.last_present_at, T0);

  const unseen = storage.getGeoLive(V2)!;
  assert.equal(unseen.bootstrap_source, null);
  assert.equal(unseen.stable_country, null);
  assert.equal(unseen.stable_asn, null);
  assert.equal(unseen.stable_observations, 0);
  assert.equal(unseen.missing_streak, 1);
  assert.equal(unseen.last_counted_at, null);
  assert.equal(unseen.last_present_at, null);

  assert.deepEqual(kinds(storage, V1), ['bootstrap']);
  // A row inserted with missing_streak = 1 is already in the missing state, so
  // it must record that like any other row — otherwise the eventual
  // 'reappeared' has no matching 'missing', for most of the fleet.
  assert.deepEqual(kinds(storage, V2), ['bootstrap', 'missing']);
  storage.close();
});

// ── 3. THE INCIDENT ────────────────────────────────────────────────────────

test('the incident: a single Frankfurt flap never reaches stable', async () => {
  const storage = openStorage(':memory:');
  seedShadow(storage, V1, EPOCH, HK);
  const lookups = { [IP_HK]: HK, [IP_DE]: DE };

  // t0: bootstrap, stable = Hong Kong (45 clean epochs' worth of belief).
  await tick(storage, { now: T0, ips: { [ID1]: IP_HK }, lookups });

  // t0+15m: the flap. 64.130.50.101 → DE/Frankfurt/AS20326.
  await tick(storage, { now: T0 + TICK, ips: { [ID1]: IP_DE }, lookups });
  let row = storage.getGeoLive(V1)!;
  assert.equal(row.cand_count, 1);
  assert.equal(row.cand_country, 'Germany');
  assert.equal(row.raw_country, 'Germany');       // raw moved…
  assert.equal(row.stable_country, 'Hong Kong');  // …stable did not
  assert.equal(row.ip_used, IP_DE);

  // t0+30m: the IP is back. One agreeing observation kills the candidate.
  await tick(storage, { now: T0 + 2 * TICK, ips: { [ID1]: IP_HK }, lookups });
  row = storage.getGeoLive(V1)!;
  assert.equal(row.cand_count, 0);
  assert.equal(row.cand_country, null);
  assert.equal(row.stable_country, 'Hong Kong');
  assert.equal(row.stable_asn, 'AS46873');
  // The seed brought 0; the flap tick counted toward the candidate, not stable;
  // only the tick that came back to Hong Kong counted for stable.
  assert.equal(row.stable_observations, 1);

  const events = storage.listGeoEventsForValidator(V1);
  assert.deepEqual(events.map((e) => e.kind), ['bootstrap', 'raw_change', 'candidate_abandoned']);
  const abandoned = events[2];
  assert.equal(abandoned.dwell_s, TICK);          // the flap's whole lifetime
  assert.equal(abandoned.cand_count, 1);
  assert.equal(abandoned.from_country, 'Hong Kong');
  assert.equal(abandoned.to_country, 'Germany');
  storage.close();
});

// ── 4. Promotion ───────────────────────────────────────────────────────────

test('promotion: K agreeing observations spanning the dwell floor move stable', async () => {
  const storage = openStorage(':memory:');
  const lookups = { [IP_HK]: HK, [IP_DE]: DE };
  await tick(storage, { now: T0, ips: { [ID1]: IP_HK }, lookups });   // bootstrap HK

  // Six observations of the new location at the real 15-min cadence: count
  // reaches 6 at t0+90m, dwell = 75m ≥ the 60m floor.
  let last = 0;
  for (let i = 1; i <= 6; i++) {
    last = T0 + i * TICK;
    await tick(storage, { now: last, ips: { [ID1]: IP_DE }, lookups });
  }

  const row = storage.getGeoLive(V1)!;
  assert.equal(row.stable_country, 'Germany');
  assert.equal(row.stable_city, 'Frankfurt am Main');
  assert.equal(row.stable_asn, 'AS20326');
  assert.equal(row.stable_asn_name, 'TeraSwitch');
  assert.equal(row.stable_since, last);
  assert.equal(row.stable_observations, 6);
  assert.equal(row.cand_count, 0);
  assert.equal(row.cand_first_seen, null);

  const promote = storage.listGeoEventsForValidator(V1).find((e) => e.kind === 'promote')!;
  assert.ok(promote, 'a promote event must be recorded');
  assert.equal(promote.from_country, 'Hong Kong');
  assert.equal(promote.to_country, 'Germany');
  assert.equal(promote.cand_count, 6);
  assert.equal(promote.dwell_s, 5 * TICK);        // first_seen was t0+15m
  storage.close();
});

// ── 5. Dwell floor ─────────────────────────────────────────────────────────

test('dwell floor: K counted observations inside one hour do NOT promote', async () => {
  const storage = openStorage(':memory:');
  const lookups = { [IP_HK]: HK, [IP_DE]: DE };
  await tick(storage, { now: T0, ips: { [ID1]: IP_HK }, lookups });

  // Bunched catch-up: six observations 5 minutes apart — each one counts (it
  // clears COUNT_INTERVAL_S) but the six of them span only 25 minutes.
  for (let i = 1; i <= 6; i++) {
    await tick(storage, { now: T0 + i * 300, ips: { [ID1]: IP_DE }, lookups });
  }

  const row = storage.getGeoLive(V1)!;
  assert.equal(row.cand_count, 6, 'the candidate must have counted all six');
  assert.equal(row.stable_country, 'Hong Kong', 'but the dwell floor blocks the promotion');
  assert.equal(kinds(storage).includes('promote'), false);
  storage.close();
});

// ── 6. Counting guard ──────────────────────────────────────────────────────

test('counting guard: sub-interval ticks refresh raw only, and cannot starve the machine', async () => {
  const storage = openStorage(':memory:');
  const lookups = { [IP_HK]: HK, [IP_DE]: DE };
  await tick(storage, { now: T0, ips: { [ID1]: IP_HK }, lookups });  // counts, last_counted = T0

  for (const dt of [10, 20]) {
    await tick(storage, { now: T0 + dt, ips: { [ID1]: IP_DE }, lookups });
  }
  let row = storage.getGeoLive(V1)!;
  assert.equal(row.raw_country, 'Germany', 'raw_* still tracks the latest observation');
  assert.equal(row.last_observed_at, T0 + 20);
  assert.equal(row.cand_count, 0, 'but nothing counted');
  assert.equal(row.last_counted_at, T0);
  assert.deepEqual(kinds(storage), ['bootstrap']);

  // The guard is measured from the last COUNTED observation, so an observation
  // COUNT_INTERVAL_S after T0 counts — a sub-interval cadence cannot starve it.
  await tick(storage, { now: T0 + 310, ips: { [ID1]: IP_DE }, lookups });
  row = storage.getGeoLive(V1)!;
  assert.equal(row.cand_count, 1);
  assert.equal(row.last_counted_at, T0 + 310);
  assert.deepEqual(kinds(storage), ['bootstrap', 'raw_change']);
  storage.close();
});

// ── 7. Missing observations ────────────────────────────────────────────────

test('missing: absent ticks never reset a candidate, clear stable, or re-emit', async () => {
  const storage = openStorage(':memory:');
  const lookups = { [IP_HK]: HK, [IP_DE]: DE };
  await tick(storage, { now: T0, ips: { [ID1]: IP_HK }, lookups });
  await tick(storage, { now: T0 + TICK, ips: { [ID1]: IP_DE }, lookups });   // cand = DE

  for (let i = 2; i <= 4; i++) {
    await tick(storage, { now: T0 + i * TICK, ips: { [ID1]: null }, lookups });
  }
  let row = storage.getGeoLive(V1)!;
  assert.equal(row.missing_streak, 3);
  assert.equal(row.cand_count, 1, 'the pending candidate survives untouched');
  assert.equal(row.cand_country, 'Germany');
  assert.equal(row.stable_country, 'Hong Kong');
  assert.equal(row.last_present_at, T0 + TICK, 'last_present_at freezes while absent');
  assert.equal(kinds(storage).filter((k) => k === 'missing').length, 1, 'emitted once, not per tick');

  // Reappearing on the incumbent abandons the candidate as usual.
  await tick(storage, { now: T0 + 5 * TICK, ips: { [ID1]: IP_HK }, lookups });
  row = storage.getGeoLive(V1)!;
  assert.equal(row.missing_streak, 0);
  assert.equal(row.cand_count, 0);
  assert.equal(row.stable_country, 'Hong Kong');
  assert.deepEqual(kinds(storage), [
    'bootstrap', 'raw_change', 'missing', 'reappeared', 'candidate_abandoned',
  ]);
  storage.close();
});

// ── 8. NULL is a value ─────────────────────────────────────────────────────

test('null is a value: losing the city dimension starts a candidate', async () => {
  const storage = openStorage(':memory:');
  const lookups = { [IP_HK]: HK, [IP_FR]: HK_NO_CITY };  // same host, city unresolved
  await tick(storage, { now: T0, ips: { [ID1]: IP_HK }, lookups });
  await tick(storage, { now: T0 + TICK, ips: { [ID1]: IP_FR }, lookups });

  const row = storage.getGeoLive(V1)!;
  assert.equal(row.cand_count, 1);
  assert.equal(row.cand_country, 'Hong Kong');
  assert.equal(row.cand_city, null);
  assert.equal(row.cand_asn, 'AS46873');
  assert.equal(row.stable_city, 'Hong Kong', 'stable keeps the full tuple until K agree');
  assert.deepEqual(kinds(storage), ['bootstrap', 'raw_change']);
  storage.close();
});

// ── 9. The stamp gate ──────────────────────────────────────────────────────
// The denominator is the whole point. Most of the fleet advertises no
// resolvable gossip endpoint (~688 of ~2,656), so a gate on present/observed
// would never stamp and the pass would look permanently dead while working
// perfectly. Coverage is measured against with_ip; with_ip has its own floor.

test('stamp gate: most of the fleet having no endpoint does NOT block the stamp', async () => {
  const storage = openStorage(':memory:');
  // 2,000 validators, only 600 with an endpoint — present/observed = 0.25,
  // i.e. production's steady state. 500 of the 600 resolve.
  const validators = fleet(2000);
  const ips = ipsFor(validators, (i) => (i < 600 ? (i < 500 ? IP_HK : IP_FR) : null));
  const r = await tick(storage, {
    now: T0, validators, ips,
    lookups: { [IP_HK]: HK, [IP_FR]: EMPTY },   // IP_FR resolves to nothing
  });

  assert.equal(r.observed, 2000);
  assert.equal(r.with_ip, 600);
  assert.equal(r.present, 500);
  assert.equal(r.meta_written, true, 'present/with_ip = 0.83 clears the gate');

  const meta = storage.getGeoLiveMeta()!;
  assert.equal(meta.last_tick_at, T0);
  assert.equal(meta.observed_count, 2000);
  assert.equal(meta.with_ip_count, 600);
  assert.equal(meta.present_count, 500);
  assert.equal(meta.epoch, EPOCH);
  assert.equal(meta.stable_k, 6);
  assert.equal(meta.stable_min_dwell_s, 3600);
  assert.equal(meta.city_mmdb_mtime_ms, CITY_MTIME_MS);
  assert.equal(meta.asn_mmdb_mtime_ms, ASN_MTIME_MS);
  storage.close();
});

test('stamp gate: a degraded getClusterNodes does not stamp, however well it resolves', async () => {
  const storage = openStorage(':memory:');
  // A partial RPC return: 200 endpoints, every one resolving perfectly. The
  // coverage ratio is a flawless 1.0 — only the with_ip floor catches this.
  const validators = fleet(2000);
  const ips = ipsFor(validators, (i) => (i < 200 ? IP_HK : null));
  const r = await tick(storage, { now: T0, validators, ips, lookups: { [IP_HK]: HK } });

  assert.equal(r.with_ip, 200);
  assert.equal(r.present, 200);
  assert.equal(r.meta_written, false, '200 endpoints is below the 400 floor');
  assert.equal(storage.getGeoLiveMeta(), undefined);
  storage.close();
});

test('stamp gate: MaxMind failing on endpoints we CAN see does not stamp', async () => {
  const storage = openStorage(':memory:');
  // 600 endpoints (over the floor), but only half resolve — coverage 0.5.
  const validators = fleet(600);
  const ips = ipsFor(validators, (i) => (i < 300 ? IP_HK : IP_FR));
  const r = await tick(storage, {
    now: T0, validators, ips,
    lookups: { [IP_HK]: HK, [IP_FR]: EMPTY },
  });

  assert.equal(r.with_ip, 600);
  assert.equal(r.present, 300);
  assert.equal(r.meta_written, false, 'coverage 0.50 is below 0.80');
  assert.equal(storage.getGeoLiveMeta(), undefined);
  storage.close();
});

// ── 10. Event retention ────────────────────────────────────────────────────

test('retention: events older than the window are deleted on the next tick', async () => {
  const storage = openStorage(':memory:');
  const old = {
    at: T0 - 100 * 86_400,     // 100 days back, past the 90-day default
    validator_pubkey: V1,
    kind: 'promote' as const,
    from_country: null, from_city: null, from_asn: null,
    to_country: 'Germany', to_city: null, to_asn: null,
    cand_count: 6, dwell_s: 3600, epoch: EPOCH - 40,
  };
  const recent = { ...old, at: T0 - 10 * 86_400, epoch: EPOCH - 5 };
  storage.insertGeoEvent(old);
  storage.insertGeoEvent(recent);
  assert.equal(storage.countGeoEvents(), 2);

  await tick(storage, { now: T0, ips: { [ID1]: IP_HK }, lookups: { [IP_HK]: HK } });

  const remaining = storage.listGeoEventsForValidator(V1);
  assert.equal(remaining.some((e) => e.at === old.at), false, 'the 100-day-old event is gone');
  assert.equal(remaining.some((e) => e.at === recent.at), true, 'the 10-day-old event survives');
  storage.close();
});

// ── 11. Third value ────────────────────────────────────────────────────────

test('third value: a different tuple abandons the pending candidate and restarts', async () => {
  const storage = openStorage(':memory:');
  const lookups = { [IP_HK]: HK, [IP_DE]: DE, [IP_FR]: FR };
  await tick(storage, { now: T0, ips: { [ID1]: IP_HK }, lookups });
  await tick(storage, { now: T0 + TICK, ips: { [ID1]: IP_DE }, lookups });
  await tick(storage, { now: T0 + 2 * TICK, ips: { [ID1]: IP_FR }, lookups });

  const row = storage.getGeoLive(V1)!;
  assert.equal(row.cand_country, 'France');
  assert.equal(row.cand_count, 1, 'the new value starts from scratch');
  assert.equal(row.cand_first_seen, T0 + 2 * TICK);
  assert.equal(row.stable_country, 'Hong Kong');

  const events = storage.listGeoEventsForValidator(V1);
  assert.deepEqual(events.map((e) => e.kind), [
    'bootstrap', 'raw_change', 'candidate_abandoned', 'raw_change',
  ]);
  assert.equal(events[2].to_country, 'Germany', 'the abandoned candidate was Germany');
  assert.equal(events[2].dwell_s, TICK);
  assert.equal(events[3].to_country, 'France');
  storage.close();
});

// ── 12. Public-repo guard ──────────────────────────────────────────────────

test('the event log carries no IP column (it ships in the public snapshot)', async () => {
  const storage = openStorage(':memory:');
  await tick(storage, { now: T0, ips: { [ID1]: IP_HK }, lookups: { [IP_HK]: HK } });

  const cols = (storage.db.prepare('PRAGMA table_info(validator_geo_events)').all() as { name: string }[])
    .map((c) => c.name);
  assert.equal(cols.includes('ip_used'), false, 'no per-validator IP-transition history');
  // The IP does live on the live row — that one is dropped from the snapshot.
  assert.equal(storage.getGeoLive(V1)!.ip_used, IP_HK);
  storage.close();
});

test('the public snapshot carries neither live-geo table, nor their bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sgdi-geolive-'));
  const srcPath = join(dir, 'src.db');
  const storage = openStorage(srcPath);
  // The frozen per-epoch capture keeps shipping, but its ip_used column must be
  // nulled in the copy: 46 epochs x ~2,650 validators of gossip IPs is the same
  // per-validator IP history the live table is dropped for.
  seedShadow(storage, V1, EPOCH, HK);
  // runSnapshot refuses to publish an empty active set, so give it one live
  // validator alongside the geo rows.
  storage.upsertValidator({
    validator_pubkey: V1, identity_pubkey: ID1, identity_name: 'test',
    country: 'Hong Kong', city: 'Hong Kong', asn: 'AS46873', asn_name: 'Host Color',
    datacenter: null, country_source: null, city_source: null, asn_source: null,
    metadata_refreshed_at: T0, stakewiz_wiz_score: 90,
    stakewiz_city_concentration: null, stakewiz_asn_concentration: null, stakewiz_refreshed_at: T0,
    activated_stake_lamports: 1_000_000_000, delinquent: 0, image_url: null,
    client_name: 'Agave', client_version: '3.0.0', is_jito: 0, is_dz: 0, is_bam: 0, ibrl_score: null,
  });
  await tick(storage, { now: T0, ips: { [ID1]: IP_HK }, lookups: { [IP_HK]: HK } });
  await tick(storage, { now: T0 + TICK, ips: { [ID1]: IP_DE }, lookups: { [IP_HK]: HK, [IP_DE]: DE } });
  storage.db.pragma('wal_checkpoint(TRUNCATE)');
  storage.close();

  const out = runSnapshot({ sourceDbPath: srcPath, publishedDir: join(dir, 'out') });
  const snap = new Database(out.path, { readonly: true });
  try {
    const tables = (snap.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[])
      .map((t) => t.name);
    assert.equal(tables.includes('validator_geo_live'), false, 'ip_used must not be published');
    assert.equal(tables.includes('validator_geo_events'), false, 'no location-transition history');
    assert.equal(tables.includes('geo_live_meta'), true, 'the freshness counters DO ship — nothing per-validator');
    assert.equal(tables.includes('validator_geo_shadow'), true, 'the frozen capture still ships…');
    const shadowIps = snap
      .prepare('SELECT COUNT(*) AS n FROM validator_geo_shadow WHERE ip_used IS NOT NULL')
      .get() as { n: number };
    assert.equal(shadowIps.n, 0, '…but with its IP column nulled out');
  } finally {
    snap.close();
  }

  // DROP TABLE and UPDATE ... = NULL only unlink or orphan pages; without the
  // VACUUM every one of these strings stays recoverable from the published
  // file. Assert on the BYTES, not the schema — a schema-only assertion passes
  // with the VACUUM deleted, which is exactly the hole this closes.
  const bytes = readFileSync(out.path);
  // IP_HK: the bootstrap tick's ip_used AND the seeded shadow row's.
  assert.equal(bytes.includes(IP_HK), false, 'no gossip IP bytes (tick 1 / shadow) in the snapshot');
  // IP_DE: tick 2 overwrote ip_used, so asserting IP_HK alone proves nothing
  // about the value actually sitting in the live row at snapshot time.
  assert.equal(bytes.includes(IP_DE), false, 'no gossip IP bytes (tick 2, the CURRENT ip_used) either');
  // The events table's payload, which never had an IP column to begin with.
  assert.equal(bytes.includes('candidate_abandoned'), false, 'no transition-log rows either');
});

// ── 14. Kill switch and unavailable .mmdb ──────────────────────────────────

test('kill switch: SGDI_GEO_LIVE_ENABLED=false makes the pass a clean no-op', async () => {
  const storage = openStorage(':memory:');
  const prev = process.env.SGDI_GEO_LIVE_ENABLED;
  process.env.SGDI_GEO_LIVE_ENABLED = 'false';
  try {
    const validators = fleet(600);
    const r = await tick(storage, {
      now: T0, validators,
      ips: ipsFor(validators, () => IP_HK),
      lookups: { [IP_HK]: HK },
    });
    assert.equal(r.skipped, 'disabled');
    assert.equal(r.observed, 0);
    assert.equal(r.meta_written, false);
    assert.equal(storage.listGeoLiveAll().length, 0, 'no rows written');
    assert.equal(storage.getGeoLiveMeta(), undefined, 'and nothing stamped fresh');
    assert.equal(storage.countGeoEvents(), 0);
  } finally {
    if (prev === undefined) delete process.env.SGDI_GEO_LIVE_ENABLED;
    else process.env.SGDI_GEO_LIVE_ENABLED = prev;
  }
  storage.close();
});

test('unavailable .mmdb: the pass no-ops without touching a single row', async () => {
  const storage = openStorage(':memory:');
  // Seed one row via a healthy tick, then lose the databases (the weekly
  // refresh's rename window).
  await tick(storage, { now: T0, ips: { [ID1]: IP_HK }, lookups: { [IP_HK]: HK } });
  const before = storage.getGeoLive(V1)!;

  const r = await tick(storage, {
    now: T0 + TICK, ips: { [ID1]: IP_DE }, lookups: { [IP_DE]: DE },
    geoipFactory: async () => ({ ok: false, reason: 'mmdb_missing', detail: 'GeoLite2-City.mmdb: ENOENT' }),
  });

  assert.equal(r.skipped, 'geoip_unavailable');
  assert.equal(r.meta_written, false);
  // No observations means no counter movement — critically, no missing_streak
  // bump, which would otherwise read a tooling failure as a fleet-wide outage.
  assert.deepEqual(storage.getGeoLive(V1), before);
  assert.deepEqual(kinds(storage), ['bootstrap']);
  storage.close();
});

// ── 15. Bootstrap purity: overrides and empty seeds ────────────────────────

test('an overridden validator seeds from observation, never from its shadow row', async () => {
  const storage = openStorage(':memory:');
  // The shadow row has the operator's correction baked in. Seeding from it
  // would import that decision into a table defined as pure MaxMind, and the
  // pass would then spend K ticks "correcting" a validator that never moved —
  // emitting a promote event that misrepresents it as having relocated.
  seedShadow(storage, V1, EPOCH, HK);
  storage.upsertGeoOverride({
    validator_pubkey: V1,
    country: 'Hong Kong', city: 'Hong Kong', asn: 'AS46873', asn_name: 'Host Color',
    reason: 'operator-confirmed location', source_evidence: null,
    added_at: T0, added_by: 'test',
  });

  await tick(storage, { now: T0, ips: { [ID1]: IP_DE }, lookups: { [IP_DE]: DE } });

  const row = storage.getGeoLive(V1)!;
  assert.equal(row.bootstrap_source, 'first-observation');
  assert.equal(row.stable_country, 'Germany', 'the live table holds what MaxMind said');
  assert.equal(row.stable_asn, 'AS20326');
  assert.equal(row.cand_count, 0, 'and therefore has nothing to correct');
  storage.close();
});

test('an all-null shadow row is not a seed — a resolvable validator gets geo at once', async () => {
  const storage = openStorage(':memory:');
  // 2,773 of the 3,471 latest shadow rows are entirely null (no resolvable
  // endpoint at capture time). Treating one as a seed would park a validator we
  // CAN resolve right now at null geo for six ticks.
  seedShadow(storage, V1, EPOCH, EMPTY);

  await tick(storage, { now: T0, ips: { [ID1]: IP_HK }, lookups: { [IP_HK]: HK } });

  const row = storage.getGeoLive(V1)!;
  assert.equal(row.bootstrap_source, 'first-observation');
  assert.equal(row.stable_country, 'Hong Kong');
  assert.equal(row.stable_observations, 1);
  storage.close();
});

// ── 16. Day-0 promotion out of an all-null stable ──────────────────────────

test('promotion out of all-null stable: the common day-0 path still debounces', async () => {
  const storage = openStorage(':memory:');
  const lookups = { [IP_HK]: HK };
  // Bootstrapped while absent → stable is the all-null tuple, no seed.
  await tick(storage, { now: T0, ips: { [ID1]: null }, lookups });
  assert.equal(storage.getGeoLive(V1)!.stable_country, null);

  // Then it appears and stays. NULL is a value, so this is an ordinary
  // transition and takes the full K observations plus the dwell floor.
  let last = 0;
  for (let i = 1; i <= 6; i++) {
    last = T0 + i * TICK;
    await tick(storage, { now: last, ips: { [ID1]: IP_HK }, lookups });
    if (i < 6) {
      assert.equal(storage.getGeoLive(V1)!.stable_country, null, `no early promotion at obs ${i}`);
    }
  }

  const row = storage.getGeoLive(V1)!;
  assert.equal(row.stable_country, 'Hong Kong');
  assert.equal(row.stable_asn, 'AS46873');
  assert.equal(row.stable_since, last);
  assert.equal(row.missing_streak, 0);
  assert.deepEqual(kinds(storage), [
    'bootstrap', 'missing', 'reappeared', 'raw_change', 'promote',
  ]);
  storage.close();
});

// ── 17. Duplicate input ────────────────────────────────────────────────────

test('a duplicated validator in one tick counts once, and says so', async () => {
  const storage = openStorage(':memory:');
  const log = stubLog();
  const dup = { validator_pubkey: V1, identity_pubkey: ID1 };
  const r = await tick(storage, {
    now: T0, ips: { [ID1]: IP_HK }, lookups: { [IP_HK]: HK },
    validators: [dup, dup, dup], log,
  });

  assert.equal(r.observed, 1, 'the extra copies are not observations');
  assert.equal(r.with_ip, 1);
  assert.deepEqual(kinds(storage), ['bootstrap'], 'and do not double-emit');
  assert.equal(log.lines.filter((l) => l.event === 'geo.live.duplicate_input').length, 1);
  storage.close();
});

// ── 18. The published artifact ─────────────────────────────────────────────
// gdi-publish.ts runs main() on import, so these drive it as a subprocess —
// against a COPY of the committed fixture in a tmp dir, never a real DB.

/** Run scripts/gdi-publish.ts against `dbPath`, writing into `outDir`. */
function runPublish(dbPath: string, outDir: string): void {
  execFileSync(
    process.execPath,
    ['--experimental-strip-types', join(REPO, 'scripts', 'gdi-publish.ts')],
    {
      cwd: REPO,
      stdio: 'pipe',
      env: {
        ...process.env,
        SGDI_DB_PATH: dbPath,
        SGDI_PUBLISHED_DIR: outDir,
        SGDI_SHADOW_PUBLISHED_DIR: join(outDir, '_shadow'),
        SGDI_LOG_DIR: join(outDir, '_logs'),
        NODE_ENV: 'production',   // silences the logger's console mirror
      },
    },
  );
}

/** A fixture copy carrying a stamped live-geo tick over `n` validators. */
async function publishableDb(dir: string, n = 450): Promise<string> {
  const dbPath = join(dir, 'src.db');
  copyFileSync(FIXTURE, dbPath);
  const storage = openStorage(dbPath);
  const validators = fleet(n);
  await tick(storage, {
    now: T0, validators,
    ips: ipsFor(validators, () => IP_HK),
    lookups: { [IP_HK]: HK },
  });
  assert.ok(storage.getGeoLiveMeta(), 'the fixture tick must clear the stamp gate');
  storage.db.pragma('wal_checkpoint(TRUNCATE)');
  storage.close();
  return dbPath;
}

test('geo-live.json: stamped with the TICK time, and carrying no IPs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sgdi-publish-'));
  const dbPath = await publishableDb(dir);
  const out = join(dir, 'out');
  runPublish(dbPath, out);

  const path = join(out, 'geo-live.json');
  assert.ok(existsSync(path), 'a stamped, coherent DB must publish the file');
  const raw = readFileSync(path, 'utf8');
  const doc = JSON.parse(raw);

  // computed_at is the ingest tick, NEVER publish wall-clock: gdi-cycle.sh runs
  // publish even when ingest failed, so a publish-derived stamp would
  // resurrect a dead ingest as fresh.
  assert.equal(doc.computed_at, new Date(T0 * 1000).toISOString());
  assert.notEqual(doc.published_at, doc.computed_at, 'published_at is a separate, debug-only field');
  assert.equal(doc.schema, 'sgdi.geo-live/1');
  assert.equal(doc.epoch, EPOCH);

  // with_ip is what `present` is meaningful against — without it a reader
  // computes present/observed and concludes the pass is broken.
  assert.equal(doc.observed, 450);
  assert.equal(doc.with_ip, 450);
  assert.equal(doc.present, 450);
  assert.equal(doc.validators.length, 450);
  assert.equal(doc.validators[0].country, 'Hong Kong');

  // The published dir is served publicly.
  assert.equal(raw.includes(IP_HK), false, 'no gossip IP in the published JSON');
  assert.equal(raw.includes('ip_used'), false, 'not even the field name');
});

test('geo-live.json: rows newer than the stamp keep the previous file in place', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sgdi-publish-'));
  const dbPath = await publishableDb(dir);
  const out = join(dir, 'out');
  runPublish(dbPath, out);
  const first = readFileSync(join(out, 'geo-live.json'), 'utf8');

  // Simulate a degraded tick: rows advanced (the pass always writes them) but
  // the stamp gate refused, so geo_live_meta stayed where it was. Publishing
  // now would pair an old, trustworthy computed_at with a newer body.
  const storage = openStorage(dbPath);
  storage.db.prepare('UPDATE validator_geo_live SET last_observed_at = ? WHERE validator_pubkey = ?')
    .run(T0 + TICK, 'Vote_0');
  storage.db.pragma('wal_checkpoint(TRUNCATE)');
  storage.close();

  runPublish(dbPath, out);
  assert.equal(
    readFileSync(join(out, 'geo-live.json'), 'utf8'), first,
    'the file must be left exactly as it was, ageing honestly through its own computed_at',
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// S2 — the frozen photograph reads the STABLE view
// ═══════════════════════════════════════════════════════════════════════════
//
// gdi-ingest step 8b now photographs the debounced stable tuple rather than an
// instantaneous MaxMind lookup. buildShadowRow IS 8b's per-validator write
// path — the ingest loop and these tests call the same function, so there is no
// mirror to drift.

const HOUR = 3600;
const DAY = 86_400;

/** A geo_live_meta row stamped at `at`. Only last_tick_at is load-bearing. */
function metaAt(at: number): GeoLiveMetaRow {
  return {
    id: 1, last_tick_at: at, epoch: EPOCH,
    observed_count: 2656, with_ip_count: 689, present_count: 689,
    moving_count: 1, promoted_count: 0, bootstrapped_count: 0, mass_change_pct: 0,
    city_mmdb_mtime_ms: CITY_MTIME_MS, asn_mmdb_mtime_ms: ASN_MTIME_MS,
    stable_k: 6, stable_min_dwell_s: 3600,
  };
}

/** A live row with a settled, well-corroborated Hong Kong stable tuple. */
function liveRow(over: Partial<ValidatorGeoLiveRow> = {}): ValidatorGeoLiveRow {
  return {
    validator_pubkey: V1,
    raw_country: 'Hong Kong', raw_city: 'Hong Kong', raw_asn: 'AS46873', raw_asn_name: 'Host Color',
    ip_used: IP_HK,
    stable_country: 'Hong Kong', stable_city: 'Hong Kong', stable_asn: 'AS46873', stable_asn_name: 'Host Color',
    stable_since: T0 - 30 * DAY, stable_observations: 1180,
    cand_country: null, cand_city: null, cand_asn: null, cand_asn_name: null,
    cand_count: 0, cand_first_seen: null,
    first_observed_at: T0 - 60 * DAY, last_observed_at: T0, last_counted_at: T0,
    last_present_at: T0, missing_streak: 0, bootstrap_source: 'shadow-seed',
    ...over,
  };
}

/** The healthy run-level plan, computed through the real function. */
const healthyPlan = (): FrozenBasePlan => planFrozenBase(metaAt(T0 - 60), T0);

/** Run `fn` with SGDI_GEO_FROZEN_FROM_STABLE set to `value`. */
function withFrozenFlag<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.SGDI_GEO_FROZEN_FROM_STABLE;
  if (value === undefined) delete process.env.SGDI_GEO_FROZEN_FROM_STABLE;
  else process.env.SGDI_GEO_FROZEN_FROM_STABLE = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.SGDI_GEO_FROZEN_FROM_STABLE;
    else process.env.SGDI_GEO_FROZEN_FROM_STABLE = prev;
  }
}

/** 8b's write path for one validator, with test-friendly defaults. */
function build(over: {
  plan?: FrozenBasePlan;
  liveRow?: ValidatorGeoLiveRow;
  lookup?: GeoLookup;
  ip?: string | null;
  override?: Parameters<typeof buildShadowRow>[0]['override'];
  now?: number;
  canonical?: { country: string | null; city: string | null; asn: string | null; asn_name?: string | null };
} = {}) {
  const canonical = over.canonical ?? { country: 'Hong Kong', city: 'Hong Kong', asn: 'AS46873' };
  return buildShadowRow({
    plan: over.plan ?? healthyPlan(),
    epoch: EPOCH,
    validator: {
      validator_pubkey: V1,
      country: canonical.country, city: canonical.city, asn: canonical.asn,
      asn_name: canonical.asn_name ?? 'Host Color',
    },
    liveRow: over.liveRow,
    lookup: over.lookup ?? EMPTY,
    ip: over.ip ?? null,
    override: over.override ?? null,
    now: over.now ?? T0,
    computedAt: T0,
  });
}

// ── 19. Run-level eligibility ──────────────────────────────────────────────

test('run gate: no live stamp at all → the whole run stays instantaneous', () => {
  const plan = planFrozenBase(undefined, T0);
  assert.equal(plan.useStable, false);
  assert.equal(plan.reason, 'no_meta');

  const sel = selectFrozenBase({ plan, row: liveRow(), lookup: DE, now: T0 });
  assert.equal(sel.source, 'instantaneous');
  assert.equal(sel.fallbackReason, 'run_gate');
  assert.deepEqual(sel.base, DE, 'an eligible row cannot rescue a run-level "no"');
});

test('run gate: a stale live stamp → instantaneous (this is what makes the kill switch inert)', () => {
  const justInside = planFrozenBase(metaAt(T0 - 2 * HOUR), T0);
  assert.equal(justInside.useStable, true, '2h exactly is still trusted');

  const plan = planFrozenBase(metaAt(T0 - 2 * HOUR - 1), T0);
  assert.equal(plan.useStable, false);
  assert.equal(plan.reason, 'stale_meta');
  assert.equal(plan.metaAgeS, 2 * HOUR + 1);
  assert.equal(plan.maxAgeS, 7200);

  assert.equal(selectFrozenBase({ plan, row: liveRow(), lookup: DE, now: T0 }).source, 'instantaneous');
});

test('run gate: a stamp from the FUTURE fails the gate (clock step / restored DB)', () => {
  // Negative age is not "very fresh", it is unexplained — and unexplained is
  // not a state in which to freeze a value for a whole epoch.
  const plan = planFrozenBase(metaAt(T0 + 60), T0);
  assert.equal(plan.useStable, false);
  assert.equal(plan.reason, 'stale_meta');
  assert.equal(plan.metaAgeS, -60);
  assert.equal(selectFrozenBase({ plan, row: liveRow(), lookup: DE, now: T0 }).source, 'instantaneous');
});

test('run gate: SGDI_GEO_FROZEN_FROM_STABLE=false reverts the BASE SELECTION only', () => {
  withFrozenFlag('false', () => {
    const plan = planFrozenBase(metaAt(T0), T0);
    assert.equal(plan.useStable, false);
    assert.equal(plan.reason, 'flag_disabled');

    // The base reverts to the instantaneous lookup…
    const { row, evidence } = build({ plan, liveRow: liveRow(), lookup: HK, ip: IP_HK });
    assert.equal(evidence.source, 'instantaneous');
    assert.equal(evidence.fallbackReason, 'run_gate');
    assert.equal(row.ip_used, IP_HK);

    // …but the canonicalisation is NOT gated, by design: it is shape-only and
    // idempotent through mergeGeo, and gating it would leave one epoch's table
    // holding a mix of raw and canonical shapes.
    assert.equal(row.shadow_country, 'Hong Kong', 'still canonical, not "HK"');
    assert.equal(row.shadow_asn, 'AS46873', 'still canonical, not "46873"');
    assert.equal(row.country_match, 1, 'match flags still compare canonical to canonical');
  });

  // Any other value, including a typo, leaves the default in force. A rollback
  // switch a typo could turn ON is not a rollback switch.
  withFrozenFlag('flase', () => assert.equal(planFrozenBase(metaAt(T0), T0).useStable, true));
  withFrozenFlag('', () => assert.equal(planFrozenBase(metaAt(T0), T0).useStable, true));
  withFrozenFlag(undefined, () => assert.equal(planFrozenBase(metaAt(T0), T0).useStable, true));
});

// ── 20. Row-level eligibility ──────────────────────────────────────────────

test('row gate: a healthy corroborated row is photographed from its stable tuple', () => {
  // The instantaneous lookup says Frankfurt; the stable tuple says Hong Kong.
  const sel = selectFrozenBase({ plan: healthyPlan(), row: liveRow(), lookup: DE, now: T0 });
  assert.equal(sel.source, 'stable');
  assert.equal(sel.fallbackReason, 'ok');
  assert.deepEqual(sel.base, { country: 'Hong Kong', city: 'Hong Kong', asn: 'AS46873', asn_org: 'Host Color' });
  assert.equal(sel.stableIp, IP_HK);
});

test('row gate: no live row yet → instantaneous', () => {
  const sel = selectFrozenBase({ plan: healthyPlan(), row: undefined, lookup: DE, now: T0 });
  assert.equal(sel.source, 'instantaneous');
  assert.equal(sel.fallbackReason, 'no_row');
  assert.deepEqual(sel.base, DE);
});

test('row gate: a stable tuple that places the validator nowhere → instantaneous', () => {
  // The usability predicate is the pass's own definition of "located": a city
  // or an org name alone puts a validator in no scored bucket.
  const allNull = selectFrozenBase({
    plan: healthyPlan(),
    row: liveRow({ stable_country: null, stable_city: null, stable_asn: null, stable_asn_name: null }),
    lookup: HK, now: T0,
  });
  assert.equal(allNull.fallbackReason, 'no_stable', 'the transient first-tick state is never frozen in');

  const cityOnly = selectFrozenBase({
    plan: healthyPlan(),
    row: liveRow({ stable_country: null, stable_asn: null, stable_city: 'Hong Kong', stable_asn_name: 'Host Color' }),
    lookup: HK, now: T0,
  });
  assert.equal(cityOnly.fallbackReason, 'no_stable', 'city + org name alone is not a location');
  assert.deepEqual(cityOnly.base, HK);

  // Either scored dimension alone IS enough.
  const asnOnly = selectFrozenBase({
    plan: healthyPlan(),
    row: liveRow({ stable_country: null, stable_city: null }),
    lookup: HK, now: T0,
  });
  assert.equal(asnOnly.source, 'stable');
});

test('row gate: absent from gossip beyond the row age bound → instantaneous', () => {
  const plan = healthyPlan();
  const justInside = selectFrozenBase({
    plan, row: liveRow({ last_present_at: T0 - 2 * DAY }), lookup: EMPTY, now: T0,
  });
  assert.equal(justInside.source, 'stable', '2 days exactly is still trusted');

  const stale = selectFrozenBase({
    plan, row: liveRow({ last_present_at: T0 - 2 * DAY - 1 }), lookup: EMPTY, now: T0,
  });
  assert.equal(stale.fallbackReason, 'absent');
  // Which yields EMPTY — precisely what the photograph recorded for an
  // unreachable validator before S2. Never worse than today.
  assert.deepEqual(stale.base, EMPTY);

  const neverPresent = selectFrozenBase({
    plan, row: liveRow({ last_present_at: null }), lookup: EMPTY, now: T0,
  });
  assert.equal(neverPresent.fallbackReason, 'absent');

  // A last_present_at in the FUTURE is unexplained, not fresh.
  const future = selectFrozenBase({
    plan, row: liveRow({ last_present_at: T0 + 60 }), lookup: EMPTY, now: T0,
  });
  assert.equal(future.fallbackReason, 'absent');
});

// ── 21. The laundering loop — an uncorroborated seed is not evidence ────────

test('row gate: a shadow-seeded stable with ZERO observations is not trusted', () => {
  // A row bootstrapped from validator_geo_shadow carries stable_observations=0:
  // its "stable" tuple is an IMPORT of the previous epoch's instantaneous
  // photograph, believed by nobody. Photographing it back out would launder it
  // into a second epoch under the name "stable".
  const seeded = liveRow({ stable_observations: 0, bootstrap_source: 'shadow-seed' });
  const sel = selectFrozenBase({ plan: healthyPlan(), row: seeded, lookup: DE, now: T0 });
  assert.equal(sel.source, 'instantaneous', 'fresh and present, but uncorroborated');
  assert.equal(sel.fallbackReason, 'uncorroborated');
  assert.deepEqual(sel.base, DE);
});

test('row gate: one corroborating observation is enough (first-observation bootstrap)', () => {
  const bootstrapped = liveRow({ stable_observations: 1, bootstrap_source: 'first-observation' });
  const sel = selectFrozenBase({ plan: healthyPlan(), row: bootstrapped, lookup: DE, now: T0 });
  assert.equal(sel.source, 'stable', 'this tuple came from an observation the pass actually made');
  assert.equal(sel.observations, 1);
});

test('row gate: a promoted tuple carries its K observations and is trusted', () => {
  const promoted = liveRow({ stable_observations: 6, stable_since: T0 - HOUR, bootstrap_source: 'shadow-seed' });
  const sel = selectFrozenBase({ plan: healthyPlan(), row: promoted, lookup: DE, now: T0 });
  assert.equal(sel.source, 'stable');
  assert.equal(sel.observations, 6);
});

test('THE LAUNDERING LOOP, closed: a flap seeded from last epoch is not re-frozen', async () => {
  // Reproduce the production state exactly: epoch N's photograph froze the
  // Frankfurt flap; the live pass then bootstraps from that shadow row, so the
  // live table's "stable" tuple IS the flap, with observations = 0. Without the
  // corroboration gate, epoch N+1 would photograph it straight back out.
  const storage = openStorage(':memory:');
  seedShadow(storage, V1, EPOCH, DE);          // the poisoned frozen capture
  // Bootstrap the live row from it, with no corroborating observation at all
  // (the validator is not in gossip on this tick).
  await tick(storage, { now: T0, ips: { [ID1]: null }, lookups: {} });

  const row = storage.getGeoLive(V1)!;
  assert.equal(row.bootstrap_source, 'shadow-seed');
  assert.equal(row.stable_country, 'Germany', 'the seed really is the flap value');
  assert.equal(row.stable_observations, 0, 'and nothing corroborates it');

  // Epoch N+1's settle-window tick, with the validator back on its real IP.
  const { row: shadow, evidence } = build({
    liveRow: row, lookup: HK, ip: IP_HK,
    canonical: { country: 'Hong Kong', city: 'Hong Kong', asn: 'AS46873' },
  });
  assert.equal(evidence.fallbackReason, 'uncorroborated');
  assert.equal(shadow.shadow_country, 'Hong Kong', 'the flap is NOT laundered into a second epoch');
  assert.equal(shadow.ip_used, IP_HK);
  storage.close();
});

// ── 22. THE ROOT-CAUSE TEST ────────────────────────────────────────────────

test('THE INCIDENT, closed: a mid-settle flap cannot be photographed', async () => {
  // Drive the REAL state machine into the exact state of 2026-08-26: a
  // long-settled Hong Kong validator whose gossip IP has just flapped to
  // Frankfurt, with the candidate still well short of K.
  const storage = openStorage(':memory:');
  const lookups = { [IP_HK]: HK, [IP_DE]: DE };
  await tick(storage, { now: T0, ips: { [ID1]: IP_HK }, lookups });          // corroborates HK
  await tick(storage, { now: T0 + TICK, ips: { [ID1]: IP_DE }, lookups });   // the flap

  const live = storage.getGeoLive(V1)!;
  assert.equal(live.cand_count, 1, 'a flap in progress, nowhere near K');
  assert.equal(live.stable_observations, 1, 'the stable tuple IS corroborated');
  assert.equal(live.raw_country, 'Germany', 'the instantaneous truth right now IS Frankfurt');

  // Now the settle-window ingest tick lands — the coincidence that caused the
  // incident. Before S2 this photographed geoip.lookup(IP_DE) = Frankfurt and
  // froze it for ~46 hours.
  const { row, evidence } = build({
    liveRow: live, lookup: DE, ip: IP_DE, now: T0 + TICK,
    canonical: { country: 'Hong Kong', city: 'Hong Kong', asn: 'AS46873' },
  });

  assert.equal(row.shadow_country, 'Hong Kong', 'the epoch is photographed as Hong Kong');
  assert.equal(row.shadow_asn, 'AS46873');
  // The live row's ip_used has already moved to the flapping address, so no
  // recorded address corroborates the recorded geo. Recording the Frankfurt IP
  // beside "Hong Kong" would be a row that disproves itself on inspection.
  assert.equal(row.ip_used, null, 'no IP is recorded rather than a contradictory one');

  // The divergence is recorded as evidence, not hidden.
  assert.equal(evidence.suppressedFlap, true);
  assert.equal(evidence.rawPresent, true);
  assert.equal(evidence.candCount, 1);
  assert.equal(evidence.raw.country, 'Germany');
  assert.equal(evidence.rawIp, IP_DE, 'the passed-over address goes in the log line');
  storage.close();
});

// ── 23. The evidence predicate ─────────────────────────────────────────────

test('evidence: a settled row with a matching lookup reports no suppressed flap', () => {
  const { row, evidence } = build({ liveRow: liveRow(), lookup: HK, ip: IP_HK });
  assert.equal(evidence.source, 'stable');
  assert.equal(evidence.suppressedFlap, false, 'no divergence to reconcile on a quiet row');
  assert.equal(row.ip_used, IP_HK, 'and the corroborating address is recorded');
});

test('evidence: freezing a tuple while the lookup is EMPTY IS a divergence', () => {
  // The predicate compares against the instantaneous lookup 8b is passing over,
  // NOT against the live row's raw_* — which is the last PRESENT observation
  // and is stale exactly when the validator is absent. Comparing raw_* would
  // hide this whole class instead of reporting it.
  const { row, evidence } = build({
    liveRow: liveRow({ last_present_at: T0 - HOUR }), lookup: EMPTY, ip: null,
  });
  assert.equal(evidence.source, 'stable');
  assert.equal(evidence.suppressedFlap, true, 'a stable tuple was frozen over an empty lookup');
  assert.equal(evidence.rawPresent, false, 'and the line says which kind of divergence it is');
  assert.equal(row.shadow_country, 'Hong Kong');
  assert.equal(row.ip_used, null);
});

test('evidence: org-name churn alone is not a suppressed flap', () => {
  // asn_name is excluded from the predicate: registry renames move no bucket
  // and must not fill the journal with reconciliation lines.
  const { evidence } = build({
    liveRow: liveRow(),
    lookup: { country: 'HK', city: 'Hong Kong', asn: '46873', asn_org: 'Host Color Ltd.' },
    ip: IP_HK,
  });
  assert.equal(evidence.source, 'stable');
  assert.equal(evidence.suppressedFlap, false, 'the three scored dimensions all agree');
});

test('evidence: an instantaneous row never reports a suppressed flap', () => {
  const { evidence } = build({ plan: planFrozenBase(undefined, T0), lookup: DE, ip: IP_DE });
  assert.equal(evidence.source, 'instantaneous');
  assert.equal(evidence.suppressedFlap, false, 'nothing was suppressed — the lookup IS what was recorded');
});

// ── 24. The 8b write path ──────────────────────────────────────────────────

test('8b writes canonical shapes, and the HK cosmetic mismatch is gone', () => {
  // 12 rows at epoch 1023 read country_match=0 purely because the old local
  // expandIso2 produced Intl's "Hong Kong SAR China", which never equalled
  // canonical's "Hong Kong". canonicalCountry applies COUNTRY_NAME_OVERRIDES.
  const { row } = build({ liveRow: liveRow(), lookup: DE, ip: IP_DE });

  assert.equal(row.shadow_country, 'Hong Kong', 'not "HK"');
  assert.equal(row.shadow_asn, 'AS46873', 'not "46873"');
  assert.equal(row.shadow_city, 'Hong Kong');
  assert.equal(row.shadow_asn_name, 'Host Color');
  assert.equal(row.country_match, 1, 'the cosmetic mismatch is fixed');
  assert.equal(row.city_match, 1);
  assert.equal(row.asn_match, 1);
  assert.equal(row.epoch, EPOCH);
  assert.equal(row.computed_at, T0);
  assert.equal(row.canonical_country, 'Hong Kong', 'the canonical side is snapshotted verbatim');
});

test('8b: the instantaneous fallback canonicalises identically to the stable path', () => {
  // A fallback run must not produce differently-shaped rows, or the artifact's
  // format would depend on the live pass's health.
  const viaStable = build({ liveRow: liveRow(), lookup: EMPTY, ip: null });
  const viaInstantaneous = build({ plan: planFrozenBase(undefined, T0), lookup: HK, ip: IP_HK });

  assert.equal(viaInstantaneous.evidence.source, 'instantaneous');
  assert.equal(viaStable.row.shadow_country, viaInstantaneous.row.shadow_country);
  assert.equal(viaStable.row.shadow_city, viaInstantaneous.row.shadow_city);
  assert.equal(viaStable.row.shadow_asn, viaInstantaneous.row.shadow_asn);
  assert.equal(viaStable.row.shadow_asn_name, viaInstantaneous.row.shadow_asn_name);
  assert.equal(viaInstantaneous.row.country_match, 1);
  assert.equal(viaInstantaneous.row.asn_match, 1);
});

test('8b: operator overrides still win, per dimension, and are canonicalised too', () => {
  const { row } = build({
    liveRow: liveRow(), lookup: DE, ip: IP_DE,
    // Partial override: country only. City/ASN must still come from the base.
    override: {
      validator_pubkey: V1, country: 'PL', city: null, asn: null, asn_name: null,
      reason: 'operator-confirmed', source_evidence: null, added_at: T0, added_by: 'test',
    },
    canonical: { country: 'Poland', city: 'Hong Kong', asn: 'AS46873' },
  });
  assert.equal(row.shadow_country, 'Poland', 'override wins, and is canonicalised like any other source');
  assert.equal(row.shadow_city, 'Hong Kong', 'the un-overridden dimensions still come from the stable base');
  assert.equal(row.shadow_asn, 'AS46873');
  assert.equal(row.country_match, 1);
});

test('8b: a validator MaxMind cannot place at all still writes a row', () => {
  const { row, evidence } = build({
    plan: planFrozenBase(undefined, T0), lookup: EMPTY, ip: null,
    canonical: { country: 'Germany', city: 'Frankfurt am Main', asn: 'AS24940' },
  });
  assert.equal(evidence.source, 'instantaneous');
  assert.equal(row.shadow_country, null);
  assert.equal(row.ip_used, null);
  // Null on one side means the flag is null, not 0 — "we cannot call it".
  assert.equal(row.country_match, null);
  assert.equal(row.city_match, null);
  assert.equal(row.asn_match, null);
  assert.equal(row.canonical_country, 'Germany', 'the canonical side is still recorded');
});

// ── 25. The shape change is safe for mergeGeo consumers ────────────────────

test('canonicalisation is idempotent, so re-canonicalising a stored row is a no-op', () => {
  // Every consumer of validator_geo_shadow feeds these strings straight into
  // mergeGeo, which canonicalises again. S2 changes the stored shapes, so that
  // second pass must be a no-op for all four dimensions.
  const once = {
    country: canonicalCountry('HK'),
    city: canonicalCity('Sao Paulo'),
    asn: canonicalAsn('46873'),
    asn_name: canonicalPassthrough('  Host Color  '),
  };
  assert.deepEqual(once, {
    country: 'Hong Kong', city: 'São Paulo', asn: 'AS46873', asn_name: 'Host Color',
  });
  assert.deepEqual({
    country: canonicalCountry(once.country),
    city: canonicalCity(once.city),
    asn: canonicalAsn(once.asn),
    asn_name: canonicalPassthrough(once.asn_name),
  }, once, 'a second canonicalisation must change nothing');

  // And through mergeGeo itself, which is how consumers actually reach it.
  const merged = mergeGeo({ maxmind: { country: 'Hong Kong', city: 'Hong Kong', asn: 'AS46873', asn_org: 'Host Color' } });
  assert.equal(merged.country, 'Hong Kong');
  assert.equal(merged.asn, 'AS46873');
  assert.equal(merged.sources.country, 'maxmind');
});

// ── 26. The kill-switch chain, end to end ──────────────────────────────────

test('disabling the LIVE pass reverts the FROZEN base on its own, within the age bound', async () => {
  // The operational claim S2 rests on: there is one switch, not two. Turning
  // off SGDI_GEO_LIVE_ENABLED stops geo_live_meta advancing, and the run-level
  // age bound then reverts 8b's BASE to its pre-S2 source without anyone
  // touching SGDI_GEO_FROZEN_FROM_STABLE or redeploying.
  const storage = openStorage(':memory:');
  const validators = fleet(600);
  const ips = ipsFor(validators, () => IP_HK);
  const lookups = { [IP_HK]: HK };

  await tick(storage, { now: T0, validators, ips, lookups });
  assert.equal(storage.getGeoLiveMeta()!.last_tick_at, T0);
  assert.equal(planFrozenBase(storage.getGeoLiveMeta(), T0).useStable, true);

  const prev = process.env.SGDI_GEO_LIVE_ENABLED;
  process.env.SGDI_GEO_LIVE_ENABLED = 'false';
  try {
    for (let i = 1; i <= 12; i++) {
      const r = await tick(storage, { now: T0 + i * TICK, validators, ips, lookups });
      assert.equal(r.skipped, 'disabled');
    }
  } finally {
    if (prev === undefined) delete process.env.SGDI_GEO_LIVE_ENABLED;
    else process.env.SGDI_GEO_LIVE_ENABLED = prev;
  }
  assert.equal(storage.getGeoLiveMeta()!.last_tick_at, T0, 'the stamp is frozen at the last healthy tick');

  // Inside the bound the photograph still trusts the (still-valid) stable view.
  assert.equal(planFrozenBase(storage.getGeoLiveMeta(), T0 + 2 * HOUR).useStable, true);

  // Past it, the base reverts to instantaneous lookups by itself.
  const reverted = planFrozenBase(storage.getGeoLiveMeta(), T0 + 2 * HOUR + 1);
  assert.equal(reverted.useStable, false);
  assert.equal(reverted.reason, 'stale_meta');
  const sel = selectFrozenBase({
    plan: reverted, row: storage.getGeoLive('Vote_0')!, lookup: DE, now: T0 + 2 * HOUR + 1,
  });
  assert.equal(sel.source, 'instantaneous');
  assert.deepEqual(sel.base, DE, 'exactly the pre-S2 base');
  storage.close();
});
