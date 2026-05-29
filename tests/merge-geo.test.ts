// Unit tests for src/lib/gdi/data-sources/merge-geo.ts.
// Run via: node --test --experimental-strip-types tests/merge-geo.test.ts
//
// Strategy: cover the fall-through table cell-by-cell — for each dimension,
// verify that the highest-priority non-null source wins and the source label
// is correct. Then a few partial-input and disagreement-detection cases.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mergeGeo } from '../src/lib/gdi/data-sources/merge-geo.ts';
import type { ValidatorGeoOverrideRow } from '../src/lib/gdi/storage.ts';

// Helper: build a complete ValidatorGeoOverrideRow with given fields.
const ovOf = (geo: Partial<{ country: string; city: string; asn: string; asn_name: string }>): ValidatorGeoOverrideRow => ({
  validator_pubkey: 'TestPubkey1111111111111111111111111111',
  country: geo.country ?? null,
  city: geo.city ?? null,
  asn: geo.asn ?? null,
  asn_name: geo.asn_name ?? null,
  reason: 'test',
  source_evidence: null,
  added_at: 0,
  added_by: 'test',
});

test('all four sources null → result fully null', () => {
  const r = mergeGeo({ override: null, maxmind: null, stakewiz: null, validatorsApp: null });
  assert.equal(r.country, null);
  assert.equal(r.city, null);
  assert.equal(r.asn, null);
  assert.equal(r.asn_name, null);
  assert.equal(r.sources.country, null);
  assert.equal(r.sources.city, null);
  assert.equal(r.sources.asn, null);
  assert.equal(r.sources.asn_name, null);
});

test('only stakewiz set → stakewiz wins every dimension', () => {
  const r = mergeGeo({
    stakewiz: { country: 'Germany', city: 'Frankfurt', asn: 'AS24940', asn_name: 'Hetzner' },
  });
  assert.deepEqual(r, {
    country: 'Germany', city: 'Frankfurt', asn: 'AS24940', asn_name: 'Hetzner',
    sources: { country: 'stakewiz', city: 'stakewiz', asn: 'stakewiz', asn_name: 'stakewiz' },
  });
});

test('full priority chain — override wins all when set, output canonical-formatted', () => {
  const r = mergeGeo({
    override: ovOf({ country: 'PL', city: 'Warsaw', asn: '0', asn_name: '(unregistered)' }),
    maxmind: { country: 'DE', city: 'Frankfurt', asn: '24940', asn_org: 'Hetzner' },
    stakewiz: { country: 'United States', city: 'New York', asn: 'AS7922', asn_name: 'Comcast' },
    validatorsApp: { country: 'GB', city: 'London', asn: 'AS1', asn_name: 'Level3' },
  });
  assert.equal(r.country, 'Poland'); assert.equal(r.sources.country, 'override');
  assert.equal(r.city, 'Warsaw'); assert.equal(r.sources.city, 'override');
  assert.equal(r.asn, 'AS0'); assert.equal(r.sources.asn, 'override');
  assert.equal(r.asn_name, '(unregistered)'); assert.equal(r.sources.asn_name, 'override');
});

test('per-dimension partial override: country from override, rest fall through to maxmind', () => {
  const r = mergeGeo({
    override: ovOf({ country: 'PL' }),
    maxmind: { country: 'DE', city: 'Frankfurt', asn: '24940', asn_org: 'Hetzner' },
    stakewiz: { country: 'United States', city: 'New York', asn: 'AS7922', asn_name: 'Comcast' },
  });
  assert.equal(r.country, 'Poland'); assert.equal(r.sources.country, 'override');
  assert.equal(r.city, 'Frankfurt'); assert.equal(r.sources.city, 'maxmind');
  assert.equal(r.asn, 'AS24940'); assert.equal(r.sources.asn, 'maxmind');
  assert.equal(r.asn_name, 'Hetzner'); assert.equal(r.sources.asn_name, 'maxmind');
});

test('maxmind has country but missing city → city falls through to stakewiz', () => {
  const r = mergeGeo({
    maxmind: { country: 'DE', city: null, asn: '24940', asn_org: 'Hetzner' },
    stakewiz: { country: 'Germany', city: 'Frankfurt', asn: 'AS24940', asn_name: 'Hetzner Online GmbH' },
  });
  assert.equal(r.country, 'Germany'); assert.equal(r.sources.country, 'maxmind');
  assert.equal(r.city, 'Frankfurt'); assert.equal(r.sources.city, 'stakewiz');
  assert.equal(r.asn, 'AS24940'); assert.equal(r.sources.asn, 'maxmind');
  assert.equal(r.asn_name, 'Hetzner'); assert.equal(r.sources.asn_name, 'maxmind');
});

test('empty string treated as null (e.g. MaxMind missing city)', () => {
  const r = mergeGeo({
    maxmind: { country: 'DE', city: '', asn: '24940', asn_org: 'Hetzner' },
    stakewiz: { country: 'Germany', city: 'Frankfurt', asn: 'AS24940', asn_name: 'Hetzner Online' },
  });
  assert.equal(r.city, 'Frankfurt'); assert.equal(r.sources.city, 'stakewiz');
});

test('validators-app sole source when others null', () => {
  const r = mergeGeo({
    validatorsApp: { country: 'JP', city: 'Tokyo', asn: 'AS395201', asn_name: 'WebNX' },
  });
  assert.equal(r.country, 'Japan'); assert.equal(r.sources.country, 'validators-app');
  assert.equal(r.city, 'Tokyo'); assert.equal(r.sources.city, 'validators-app');
  assert.equal(r.asn, 'AS395201'); assert.equal(r.sources.asn, 'validators-app');
});

test('disagreement WARN: maxmind vs stakewiz differ on country, logger called', () => {
  const logged: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const logger = { warn: (event: string, fields: Record<string, unknown>) => { logged.push({ event, fields }); } };

  const r = mergeGeo({
    maxmind: { country: 'GB', city: 'London', asn: '8220', asn_org: 'COLT' },
    stakewiz: { country: 'United States', city: 'London', asn: 'AS8220', asn_name: 'COLT' },
    pubkey: 'pk1',
    logger,
  });

  // Winner is maxmind (GB), but stakewiz disagrees on country.
  // Output is canonicalised to display-name form.
  assert.equal(r.country, 'United Kingdom');
  assert.equal(r.sources.country, 'maxmind');

  // Should warn exactly once for country; city and asn agree under normalisation
  // ("AS8220" vs "8220" should NOT trigger, neither should city "London" exact match).
  // The WARN logs the RAW winner pre-canonicalisation so the comparison is honest.
  const countryWarns = logged.filter((l) => l.fields.field === 'country');
  assert.equal(countryWarns.length, 1);
  assert.equal(countryWarns[0].event, 'geo.merge.disagreement');
  assert.equal(countryWarns[0].fields.used, 'GB');
  assert.equal(countryWarns[0].fields.used_source, 'maxmind');
  assert.equal(countryWarns[0].fields.validator, 'pk1');

  const asnWarns = logged.filter((l) => l.fields.field === 'asn');
  assert.equal(asnWarns.length, 0, '"AS8220" vs "8220" normalises to equal — no warn');

  const cityWarns = logged.filter((l) => l.fields.field === 'city');
  assert.equal(cityWarns.length, 0, 'exact city match — no warn');
});

test('disagreement NOT logged when normalisation collapses them', () => {
  const logged: Array<{ event: string }> = [];
  const logger = { warn: (event: string) => { logged.push({ event }); } };

  // "US" (ISO-2) vs "United States" (full name) should be treated as agreement.
  mergeGeo({
    maxmind: { country: 'US', city: 'New York', asn: '7922', asn_org: 'Comcast' },
    stakewiz: { country: 'United States', city: 'new york', asn: 'AS7922', asn_name: 'COMCAST' },
    pubkey: 'pk2',
    logger,
  });

  assert.equal(logged.length, 0, 'ISO-2 / case-insensitive / AS-prefix all normalise — no warns expected');
});

test('no logger → no log calls (silent mode for pure use)', () => {
  // If logger is omitted entirely, disagreement detection is skipped — the
  // function MUST be a pure value-producer.
  const r = mergeGeo({
    maxmind: { country: 'GB', city: 'London', asn: '8220', asn_org: 'COLT' },
    stakewiz: { country: 'US', city: 'London', asn: 'AS8220', asn_name: 'COLT' },
  });
  assert.equal(r.country, 'United Kingdom'); // still picks maxmind; just doesn't log
});

test('asn vs asn_name resolve independently (rare case but explicit)', () => {
  // Override sets only asn; asn_name falls through to maxmind, which has it.
  // This is a deliberate design choice — pairing asn+asn_name to one source
  // would force operators to provide both even when they only know one.
  const r = mergeGeo({
    override: ovOf({ asn: '99999' }),
    maxmind: { country: 'US', city: 'New York', asn: '7922', asn_org: 'Comcast' },
  });
  assert.equal(r.asn, 'AS99999'); assert.equal(r.sources.asn, 'override');
  assert.equal(r.asn_name, 'Comcast'); assert.equal(r.sources.asn_name, 'maxmind');
});

// ── Canonical output format ──────────────────────────────────────────────

test('country output: ISO-2 expanded to Intl display name regardless of source', () => {
  // Intl.DisplayNames is the source of truth here — what JS's
  // standard region-name table reports. For most common countries this
  // matches what Stakewiz historically returned (Netherlands, United
  // States, United Kingdom, Germany, Japan, ...). For SAR / disputed
  // regions Intl uses the formal UN form, e.g. "Hong Kong SAR China".
  // We accept that as authoritative rather than maintaining a custom map.
  const r1 = mergeGeo({ maxmind: { country: 'NL', city: 'Amsterdam', asn: '58061', asn_org: 'Solar' } });
  assert.equal(r1.country, 'Netherlands');

  const r2 = mergeGeo({ stakewiz: { country: 'Netherlands', city: 'Amsterdam', asn: 'AS58061', asn_name: 'Solar' } });
  assert.equal(r2.country, 'Netherlands');

  const r3 = mergeGeo({ maxmind: { country: 'US', city: 'New York', asn: '7922', asn_org: 'Comcast' } });
  assert.equal(r3.country, 'United States');

  // SAR codes are explicitly overridden to the common form so the UI
  // matches the legacy Stakewiz strings users are used to.
  const r4 = mergeGeo({ override: ovOf({ country: 'HK' }) });
  assert.equal(r4.country, 'Hong Kong');

  const r5 = mergeGeo({ override: ovOf({ country: 'MO' }) });
  assert.equal(r5.country, 'Macao');
});

test('asn output: always AS-prefixed', () => {
  const r1 = mergeGeo({ maxmind: { country: 'DE', city: 'Frankfurt', asn: '24940', asn_org: 'Hetzner' } });
  assert.equal(r1.asn, 'AS24940');

  const r2 = mergeGeo({ stakewiz: { country: 'DE', city: 'Frankfurt', asn: 'AS24940', asn_name: 'Hetzner' } });
  assert.equal(r2.asn, 'AS24940');

  const r3 = mergeGeo({ override: ovOf({ asn: '0' }) });
  assert.equal(r3.asn, 'AS0');

  // Lower-case AS prefix → normalised.
  const r4 = mergeGeo({ override: ovOf({ asn: 'as12345' }) });
  assert.equal(r4.asn, 'AS12345');
});

test('city + asn_name pass through trimmed but otherwise unchanged', () => {
  const r = mergeGeo({
    maxmind: { country: 'NL', city: '  Amsterdam  ', asn: '58061', asn_org: '  Solar Communications GmbH  ' },
  });
  assert.equal(r.city, 'Amsterdam');
  assert.equal(r.asn_name, 'Solar Communications GmbH');
});

test('null/empty country canonicalises to null, not "ZZ" or similar', () => {
  const r = mergeGeo({ stakewiz: { country: null, city: 'Frankfurt', asn: 'AS24940', asn_name: 'Hetzner' } });
  assert.equal(r.country, null);
  assert.equal(r.sources.country, null);
});
