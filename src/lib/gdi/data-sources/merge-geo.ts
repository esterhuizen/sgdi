// Per-validator geo merge with provenance, for the MaxMind shadow pipeline.
//
// Takes geo values from up to four sources (override / maxmind / stakewiz /
// validators-app) and produces a single merged answer, plus per-dimension
// provenance ("which source's value won for this field").
//
// Resolution: per-dimension, in priority order, first non-null wins.
//
//   override      ─ operator-confirmed correction (highest trust)
//   maxmind       ─ locally-hosted GeoLite2-City / GeoLite2-ASN lookup
//   stakewiz      ─ canonical pre-MaxMind primary
//   validators-app ─ canonical pre-MaxMind secondary
//
// Each dimension (country, city, asn, asn_name) picks independently. This
// is deliberate: a partial override that sets only country still lets MaxMind
// answer for city; a MaxMind result that has country but not city still lets
// Stakewiz answer for city.
//
// The function is pure. No I/O, no allocation beyond the result object,
// no logging unless a logger is explicitly passed.

import type { ValidatorGeoOverrideRow } from '../storage.ts';
import type { GeoLookup } from './local-geoip.ts';

/** Normalised input shape — caller adapts source-specific types to this. */
export type GeoCandidate = {
  country: string | null;
  city: string | null;
  asn: string | null;
  asn_name: string | null;
};

export type GeoSource =
  | 'override'
  | 'maxmind'
  | 'stakewiz'
  | 'validators-app';

export type MergedGeo = {
  country: string | null;
  city: string | null;
  asn: string | null;
  asn_name: string | null;
  sources: {
    country: GeoSource | null;
    city: GeoSource | null;
    asn: GeoSource | null;
    asn_name: GeoSource | null;
  };
};

/** A minimal logger surface — matches the existing ModuleLogger.warn shape. */
type WarnLogger = {
  warn(event: string, fields: Record<string, unknown>): void;
};

export type MergeGeoInput = {
  override?: ValidatorGeoOverrideRow | null;
  maxmind?: GeoLookup | null;
  stakewiz?: GeoCandidate | null;
  validatorsApp?: GeoCandidate | null;
  /** Vote pubkey for log context. Required iff `logger` is passed. */
  pubkey?: string;
  /** Optional logger for disagreement warnings. No log calls if omitted. */
  logger?: WarnLogger;
};

// ── Normalised compare helpers for disagreement detection ────────────────
// We never normalise the VALUE we return — that's the raw winner's string.
// We only normalise FOR COMPARISON so "US" vs "United States" or "20473"
// vs "AS20473" don't fire a spurious WARN.

const countryEq = (a: string, b: string): boolean => {
  const na = a.trim().toLowerCase();
  const nb = b.trim().toLowerCase();
  if (na === nb) return true;
  // ISO-2 ↔ region-name expansion. If either side is 2 chars treat as ISO-2.
  try {
    const dn = new Intl.DisplayNames(['en'], { type: 'region' });
    const expand = (s: string): string =>
      s.length === 2 ? (dn.of(s.toUpperCase()) ?? s).toLowerCase() : s;
    return expand(na) === expand(nb);
  } catch {
    return false;
  }
};
const cityEq = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();
const asnEq = (a: string, b: string): boolean =>
  a.trim().replace(/^AS/i, '') === b.trim().replace(/^AS/i, '');
const asnNameEq = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

const EQ_FN: Record<'country' | 'city' | 'asn' | 'asn_name', (a: string, b: string) => boolean> = {
  country: countryEq,
  city: cityEq,
  asn: asnEq,
  asn_name: asnNameEq,
};

const isPresent = (v: string | null | undefined): v is string =>
  typeof v === 'string' && v.trim().length > 0;

/**
 * Resolve one dimension. Walks the candidate list in priority order, picks
 * the first non-null value, records its source. Optionally logs WARN if
 * lower-priority candidates disagreed.
 */
function pickDimension(
  field: 'country' | 'city' | 'asn' | 'asn_name',
  candidates: Array<{ source: GeoSource; value: string | null | undefined }>,
  pubkey: string | undefined,
  logger: WarnLogger | undefined,
): { value: string | null; source: GeoSource | null } {
  let winner: { source: GeoSource; value: string } | null = null;
  const present: Array<{ source: GeoSource; value: string }> = [];
  for (const c of candidates) {
    if (!isPresent(c.value)) continue;
    present.push({ source: c.source, value: c.value });
    if (winner == null) winner = { source: c.source, value: c.value };
  }
  if (winner == null) return { value: null, source: null };

  // Disagreement: ≥ 2 present, any other doesn't match winner under
  // field-specific normalisation. Single log line listing all sources.
  if (present.length >= 2 && logger != null) {
    const eq = EQ_FN[field];
    const disagrees = present.filter((p) => p.source !== winner!.source && !eq(p.value, winner!.value));
    if (disagrees.length > 0) {
      logger.warn('geo.merge.disagreement', {
        validator: pubkey,
        field,
        used: winner.value,
        used_source: winner.source,
        others: Object.fromEntries(present
          .filter((p) => p.source !== winner!.source)
          .map((p) => [p.source, p.value])),
      });
    }
  }
  return { value: winner.value, source: winner.source };
}

/**
 * Merge geo candidates from up to four sources into a single result + per-
 * dimension provenance. Pure: no I/O, no side effects unless a `logger` is
 * passed (in which case disagreements are surfaced as WARN log lines).
 */
export function mergeGeo(input: MergeGeoInput): MergedGeo {
  const ov = input.override ?? null;
  const mm = input.maxmind ?? null;
  const sw = input.stakewiz ?? null;
  const va = input.validatorsApp ?? null;

  // MaxMind exposes `asn_org` for the org name; align to asn_name here so
  // pickDimension can iterate uniformly.
  const mmCandidate: GeoCandidate | null = mm
    ? { country: mm.country, city: mm.city, asn: mm.asn, asn_name: mm.asn_org }
    : null;
  const ovCandidate: GeoCandidate | null = ov
    ? { country: ov.country, city: ov.city, asn: ov.asn, asn_name: ov.asn_name }
    : null;

  const candidates = (field: keyof GeoCandidate) => [
    { source: 'override'      as GeoSource, value: ovCandidate?.[field] },
    { source: 'maxmind'       as GeoSource, value: mmCandidate?.[field] },
    { source: 'stakewiz'      as GeoSource, value: sw?.[field] },
    { source: 'validators-app' as GeoSource, value: va?.[field] },
  ];

  const country  = pickDimension('country',  candidates('country'),  input.pubkey, input.logger);
  const city     = pickDimension('city',     candidates('city'),     input.pubkey, input.logger);
  const asn      = pickDimension('asn',      candidates('asn'),      input.pubkey, input.logger);
  const asn_name = pickDimension('asn_name', candidates('asn_name'), input.pubkey, input.logger);

  return {
    country: country.value,
    city: city.value,
    asn: asn.value,
    asn_name: asn_name.value,
    sources: {
      country: country.source,
      city: city.source,
      asn: asn.source,
      asn_name: asn_name.source,
    },
  };
}
