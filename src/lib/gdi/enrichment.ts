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
import type { IbrlValidator } from './data-sources/ibrl.ts';
import type { ValidatorRow } from './storage.ts';
import type { ModuleLogger } from './logger.ts';

export type EnrichmentInput = {
  /** Vote pubkeys we want metadata for. Result preserves this order. */
  pubkeys: readonly string[];
  /** Stakewiz validators keyed by `vote_identity`. */
  stakewiz: ReadonlyMap<string, StakewizValidator>;
  /** Validators.app validators keyed by `vote_account`. */
  validatorsApp: ReadonlyMap<string, ValidatorsAppValidator>;
  /** IBRL validators keyed by `identity` (node identity, not vote pubkey).
   *  Optional — caller may omit if the IBRL fetch failed. */
  ibrl?: ReadonlyMap<string, IbrlValidator>;
  /** Set of Solana validator IDENTITY pubkeys currently registered as
   *  Activated on the DoubleZero mainnet ledger. Authoritative source for
   *  `is_dz`. Optional — when omitted (e.g. DZ fetch failed) we leave the
   *  existing DB value via COALESCE upsert rather than overwrite with null. */
  doubleZeroIdentities?: ReadonlySet<string>;
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
  const { pubkeys, stakewiz, validatorsApp, ibrl, doubleZeroIdentities, logger, now } = input;
  const out: ValidatorRow[] = [];

  for (const pubkey of pubkeys) {
    const sw = stakewiz.get(pubkey);
    const va = validatorsApp.get(pubkey);
    // IBRL is keyed by NODE identity, not vote pubkey. Get the identity from
    // Stakewiz/VA (whichever knows it) and look up there.
    const identity = sw?.identity ?? va?.account ?? null;
    const ib = identity && ibrl ? ibrl.get(identity) : undefined;

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
      identity_pubkey: sw?.identity ?? null,
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
      // Network-wide stake & status — needed for the validator-lookup page
      // (ranks by activated_stake and excludes delinquent from the "active"
      // denominator).
      activated_stake_lamports:
        sw?.activated_stake != null ? Math.floor(sw.activated_stake * 1e9) : null,
      delinquent: sw?.delinquent != null ? (sw.delinquent ? 1 : 0) : null,
      image_url: sw?.image ?? null,
      // Client diversity (gdi-1.2 phase 1). Validators.app is the only source
      // with a curated `software_client` label (Agave / JitoLabs / Frankendancer
      // / Firedancer / HarmonicAgave / Rakurai / …) and for is_jito.
      // is_dz: switched away from validators.app (unreliable — missed major
      // operators like Galaxy/Ledger-by-Figment, falsely included Everstake/
      // Drift). Source is now the DoubleZero mainnet ledger directly: a
      // validator is on DZ iff its identity pubkey has an Activated User
      // account in the serviceability program. Same record DZ Foundation
      // uses to bill the 5% fee, so validators don't keep it if they're
      // not actually connected.
      client_name: va?.software_client ?? null,
      client_version: va?.software_version ?? null,
      is_jito: va?.jito != null ? (va.jito ? 1 : 0) : null,
      is_dz:
        doubleZeroIdentities && identity
          ? (doubleZeroIdentities.has(identity) ? 1 : 0)
          : null,
      // IBRL: typeof check (vs ?? null) because 0 is a valid score but unlikely;
      // null means "no blocks produced this epoch" so we have no signal.
      ibrl_score: ib != null ? ib.ibrl_score : null,
    });
  }

  return out;
}
