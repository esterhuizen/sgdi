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
import { openStorage, type ValidatorGeoShadowRow } from '../src/lib/gdi/storage.ts';
import { runLiveGeoPass, type LiveGeoPassResult } from '../src/lib/gdi/geo-live.ts';
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
