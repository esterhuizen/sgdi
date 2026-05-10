// Validators.app REST client (cross-reference for validator metadata).
//
// Used only as a tiebreaker / fallback when Stakewiz disagrees on country /
// city / ASN. Same once-per-refresh-cycle cadence as Stakewiz.
//
// API docs: https://www.validators.app/api-documentation
// Requires VALIDATORS_APP_TOKEN in env (header: "Token <token>").

import type { ModuleLogger } from '../logger.ts';

const BASE_URL =
  process.env.VALIDATORS_APP_BASE_URL || 'https://www.validators.app/api/v1';

export type ValidatorsAppValidator = {
  account: string;            // node identity pubkey
  vote_account: string;       // vote account pubkey
  name: string | null;
  ip: string | null;
  /** Validators.app stores ASN as a numeric string in `ip_address.autonomous_system_number` historically; we accept either shape. */
  asn: string | null;
  asn_organization: string | null;
  country: string | null;     // ISO-2
  city: string | null;
  data_center_concentration_score: number | null;
  data_center_host: string | null;
  data_center_key: string | null;
};

export class ValidatorsAppError extends Error {
  readonly httpStatus: number | null;
  constructor(message: string, httpStatus: number | null) {
    super(message);
    this.name = 'ValidatorsAppError';
    this.httpStatus = httpStatus;
  }
}

export function createValidatorsApp(opts: {
  token?: string;
  network?: 'mainnet' | 'testnet';
  logger?: ModuleLogger;
  timeoutMs?: number;
} = {}) {
  const token = opts.token ?? process.env.VALIDATORS_APP_TOKEN ?? '';
  const network = opts.network ?? 'mainnet';
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const logger = opts.logger;

  return {
    /** Was the client configured with a usable token? */
    isConfigured(): boolean {
      return token.length > 0;
    },

    /**
     * Fetch every validator on the chosen network. The API returns up to
     * 9999 entries in a single page when `?per_page=9999` is set. We use
     * that to avoid pagination on a low-volume daily/weekly job.
     */
    async fetchAllValidators(): Promise<ValidatorsAppValidator[]> {
      if (!token) {
        throw new ValidatorsAppError(
          'VALIDATORS_APP_TOKEN not set — adapter cannot run',
          null,
        );
      }
      const url = `${BASE_URL}/validators/${network}.json?per_page=9999`;
      const startedAt = Date.now();
      let res: Response;
      try {
        res = await fetch(url, {
          headers: {
            Token: token,
            'user-agent': 'sgdi/0.1 (+https://sgdi.app)',
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        logger?.warn('validators_app.network_error', { url, detail });
        throw new ValidatorsAppError(`Validators.app network: ${detail}`, null);
      }
      const dur = Date.now() - startedAt;

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        logger?.warn('validators_app.http_error', {
          url,
          status: res.status,
          duration_ms: dur,
        });
        throw new ValidatorsAppError(
          `Validators.app HTTP ${res.status}: ${body.slice(0, 200)}`,
          res.status,
        );
      }

      const raw = (await res.json()) as unknown;
      if (!Array.isArray(raw)) {
        logger?.warn('validators_app.bad_shape', { url, type: typeof raw });
        throw new ValidatorsAppError(
          `Validators.app returned non-array (got ${typeof raw})`,
          res.status,
        );
      }

      // Normalise to our typed shape. Validators.app's response includes
      // many fields we don't use; we extract the small set we care about.
      const out: ValidatorsAppValidator[] = (raw as Record<string, unknown>[])
        .map((r) => ({
          account: stringOrNull(r.account) ?? '',
          vote_account: stringOrNull(r.vote_account) ?? '',
          name: stringOrNull(r.name),
          ip: stringOrNull(r.ip_address) ?? stringOrNull(r.ip),
          asn:
            stringOrNull(r.autonomous_system_number) ??
            stringOrNull((r as { ip_address?: { autonomous_system_number?: unknown } }).ip_address?.autonomous_system_number) ??
            null,
          asn_organization: stringOrNull(r.autonomous_system_organization),
          country: stringOrNull(r.country) ?? stringOrNull(r.country_code),
          city: stringOrNull(r.city),
          data_center_concentration_score: numberOrNull(r.data_center_concentration_score),
          data_center_host: stringOrNull(r.data_center_host),
          data_center_key: stringOrNull(r.data_center_key),
        }))
        .filter((v) => v.vote_account || v.account);

      logger?.info('validators_app.fetched', {
        url,
        duration_ms: dur,
        total: raw.length,
        valid: out.length,
      });
      return out;
    },
  };
}

function stringOrNull(v: unknown): string | null {
  if (typeof v === 'string' && v.length > 0) return v;
  if (typeof v === 'number') return String(v);
  return null;
}

function numberOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}
