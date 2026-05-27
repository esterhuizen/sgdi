// Local IP→geo lookup against MaxMind GeoLite2-City + GeoLite2-ASN .mmdb files.
//
// The .mmdb files are refreshed weekly by deploy/sgdi-geoip-refresh.{service,timer}
// to /var/lib/sgdi/geoip/. This module just opens them and answers per-IP queries.
//
// Currently consumed ONLY by the shadow-geoip ingest pass (see scripts/gdi-ingest.ts).
// Live enrichment + pool scoring still reads from Stakewiz/Validators.app via
// pickField() in enrichment.ts; promoting this source to primary is a separate change.
//
// Failure modes handled:
//  - .mmdb files missing → createLocalGeoip returns ok=false; ingest treats
//    the shadow pass as a no-op for the epoch (silent skip, structured log).
//  - .mmdb files corrupt → maxmind.open throws; same treatment.
//  - IP is null / private / reserved → lookup returns all-null GeoLookup.

import { open as openMmdb, type Reader, type CityResponse, type AsnResponse } from 'maxmind';

export type GeoLookup = {
  country: string | null;   // ISO-3166 alpha-2 (e.g. "DE")
  city:    string | null;   // English name (e.g. "Frankfurt am Main")
  asn:     string | null;   // numeric string to match validators.asn column shape
  asn_org: string | null;   // ASN organisation, e.g. "Hetzner Online GmbH"
};

const EMPTY: GeoLookup = { country: null, city: null, asn: null, asn_org: null };

export type LocalGeoip = {
  /** Per-IP lookup. Returns EMPTY on any failure (null IP, private range, miss). */
  lookup(ip: string | null | undefined): GeoLookup;
  /** Last-modified mtime of the city .mmdb file — useful for "are we serving stale data?" checks. */
  cityMmdbMtimeMs: number;
  asnMmdbMtimeMs: number;
};

export type LocalGeoipResult =
  | { ok: true;  geoip: LocalGeoip }
  | { ok: false; reason: 'mmdb_missing' | 'mmdb_corrupt'; detail?: string };

/**
 * Open both .mmdb files. Returns { ok: false } if either is missing/unreadable —
 * the caller decides whether that's fatal (shadow pass treats it as skip).
 */
export async function createLocalGeoip(opts?: {
  cityMmdbPath?: string;
  asnMmdbPath?: string;
}): Promise<LocalGeoipResult> {
  const cityPath = opts?.cityMmdbPath ?? '/var/lib/sgdi/geoip/GeoLite2-City.mmdb';
  const asnPath  = opts?.asnMmdbPath  ?? '/var/lib/sgdi/geoip/GeoLite2-ASN.mmdb';

  let cityReader: Reader<CityResponse>;
  let asnReader: Reader<AsnResponse>;
  try {
    cityReader = await openMmdb<CityResponse>(cityPath);
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    return {
      ok: false,
      reason: /ENOENT/.test(msg) ? 'mmdb_missing' : 'mmdb_corrupt',
      detail: `${cityPath}: ${msg}`,
    };
  }
  try {
    asnReader = await openMmdb<AsnResponse>(asnPath);
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    return {
      ok: false,
      reason: /ENOENT/.test(msg) ? 'mmdb_missing' : 'mmdb_corrupt',
      detail: `${asnPath}: ${msg}`,
    };
  }

  // Cache file mtimes for staleness checks. Node's import of fs.statSync would
  // pull a sync dep; we got the file via the maxmind reader already, so just
  // call statSync from a tiny helper to keep this module's surface clean.
  const { statSync } = await import('node:fs');
  const cityMmdbMtimeMs = statSync(cityPath).mtimeMs;
  const asnMmdbMtimeMs  = statSync(asnPath).mtimeMs;

  return {
    ok: true,
    geoip: {
      cityMmdbMtimeMs,
      asnMmdbMtimeMs,
      lookup(ip) {
        if (!ip) return EMPTY;
        // MaxMind handles IPv6 + IPv4 transparently. It also throws on
        // malformed input — wrap in try/catch and return EMPTY on parse fail.
        let cityRow: CityResponse | null = null;
        let asnRow:  AsnResponse  | null = null;
        try { cityRow = cityReader.get(ip); } catch { /* malformed IP */ }
        try { asnRow  = asnReader.get(ip);  } catch { /* malformed IP */ }
        const asnNum = asnRow?.autonomous_system_number;
        return {
          country: cityRow?.country?.iso_code ?? null,
          city:    cityRow?.city?.names?.en ?? null,
          asn:     asnNum != null ? String(asnNum) : null,
          asn_org: asnRow?.autonomous_system_organization ?? null,
        };
      },
    },
  };
}
