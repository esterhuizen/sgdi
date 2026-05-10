// Validator metadata enrichment.
//
// Pure function (in the same spirit as scoring.ts): given a list of pubkeys
// and the latest snapshots from Stakewiz + Validators.app, produces a list
// of ValidatorRow objects ready to be upserted into the validators table.
// Decides which source to trust per field, and logs every disagreement.
//
// Trust ordering (spec §4): Stakewiz primary → Validators.app fallback when
// Stakewiz is missing the field → log disagreements at WARN with all source
// values. Stakewiz wins ties.

import type { StakewizValidator } from './data-sources/stakewiz.ts';
import type { ValidatorsAppValidator } from './data-sources/validators-app.ts';
import type { ValidatorRow } from './storage.ts';
import type { ModuleLogger } from './logger.ts';

export type EnrichmentInput = {
  /** Vote pubkeys we want metadata for. Result preserves this order. */
  pubkeys: readonly string[];
  /** Stakewiz validators keyed by `vote_identity`. */
  stakewiz: ReadonlyMap<string, StakewizValidator>;
  /** Validators.app validators keyed by `vote_account`. */
  validatorsApp: ReadonlyMap<string, ValidatorsAppValidator>;
  logger: ModuleLogger;
  /** Current unix timestamp (seconds). Used as `metadata_refreshed_at`. */
  now: number;
};

type Source = 'stakewiz' | 'validators-app' | null;

type Resolved<T> = { value: T | null; source: Source };

/**
 * Compare-and-pick: if Stakewiz has a value, use it. If Stakewiz is missing
 * but Validators.app has one, use that. If both have a value but they
 * disagree (under the provided equality fn), log at WARN and still go with
 * Stakewiz. If neither, return null.
 */
function pickField<T>(
  logger: ModuleLogger,
  pubkey: string,
  fieldName: string,
  swValue: T | null | undefined,
  vaValue: T | null | undefined,
  eq: (a: T, b: T) => boolean,
): Resolved<T> {
  const sw = swValue == null ? null : swValue;
  const va = vaValue == null ? null : vaValue;

  if (sw != null && va != null && !eq(sw, va)) {
    logger.warn('disagreement', {
      validator: pubkey,
      field: fieldName,
      stakewiz: sw,
      validators_app: va,
      used: sw,
      used_source: 'stakewiz',
    });
  }
  if (sw != null) return { value: sw, source: 'stakewiz' };
  if (va != null) return { value: va, source: 'validators-app' };
  return { value: null, source: null };
}

const eqExact = <T>(a: T, b: T) => a === b;
const eqCity = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

export function enrichValidators(input: EnrichmentInput): ValidatorRow[] {
  const { pubkeys, stakewiz, validatorsApp, logger, now } = input;
  const out: ValidatorRow[] = [];

  for (const pubkey of pubkeys) {
    const sw = stakewiz.get(pubkey);
    const va = validatorsApp.get(pubkey);

    // Country: ISO-2, exact-match comparison.
    const country = pickField<string>(logger, pubkey, 'country', sw?.ip_country, va?.country, eqExact);

    // City: case-insensitive, trim-tolerant comparison (raw strings differ
    // legitimately between sources — e.g. "New York" vs "new york").
    const city = pickField<string>(logger, pubkey, 'city', sw?.ip_city, va?.city, eqCity);

    // ASN: compare as strings (Stakewiz has it numeric, Validators.app stringy).
    const swAsn = sw?.ip_asn != null ? String(sw.ip_asn) : null;
    const vaAsn = va?.asn ?? null;
    const asn = pickField<string>(logger, pubkey, 'asn', swAsn, vaAsn, eqExact);

    // ASN organisation name: stakewiz primary, no comparison (these are
    // long-form strings that legitimately differ in whitespace/punctuation).
    const asn_name = sw?.ip_org ?? va?.asn_organization ?? null;

    // Datacenter / identity name: not a "trust ordering" field — Validators.app
    // provides datacenter info that Stakewiz doesn't, so we just take what's there.
    const datacenter = va?.data_center_key ?? null;
    const identity_name = sw?.name ?? va?.name ?? null;

    out.push({
      validator_pubkey: pubkey,
      identity_name,
      country: country.value,
      city: city.value,
      asn: asn.value,
      asn_name,
      datacenter,
      country_source: country.source,
      city_source: city.source,
      asn_source: asn.source,
      metadata_refreshed_at: now,
      stakewiz_wiz_score: sw?.wiz_score ?? null,
      stakewiz_city_concentration: sw?.city_concentration ?? null,
      stakewiz_asn_concentration: sw?.asn_concentration ?? null,
      stakewiz_refreshed_at: sw ? now : null,
    });
  }

  return out;
}
