// Stakewiz REST client.
//
// One method we actually use: fetchAllValidators() — returns the entire active
// validator set with IP-derived geography + wiz_score. ~1500 validators, ~1MB
// JSON. Cached at the DB layer (validators table); we hit Stakewiz at most
// once per refresh cycle (default 7 days).
//
// API docs: https://api.stakewiz.com/
// No authentication required. The endpoint is generous about rate-limiting
// for low-frequency callers like us.

import type { ModuleLogger } from '../logger.ts';

const STAKEWIZ_BASE = process.env.STAKEWIZ_BASE_URL || 'https://api.stakewiz.com';

export type StakewizValidator = {
  vote_identity: string;          // vote account pubkey
  identity: string;               // node identity pubkey
  name: string | null;
  ip: string | null;
  ip_country: string | null;      // ISO-2 (e.g. "US")
  ip_city: string | null;
  ip_org: string | null;          // ASN organization name (e.g. "Hetzner Online GmbH")
  ip_asn: number | null;          // numeric ASN
  ip_latitude: number | null;
  ip_longitude: number | null;
  wiz_score: number | null;       // 0-100
  city_concentration: number | null;
  asn_concentration: number | null;
  activated_stake: number | null; // total active stake at this validator (SOL)
  commission: number | null;
  website: string | null;
  image: string | null;
};

export class StakewizError extends Error {
  readonly httpStatus: number | null;
  constructor(message: string, httpStatus: number | null) {
    super(message);
    this.name = 'StakewizError';
    this.httpStatus = httpStatus;
  }
}

export function createStakewiz(opts: { logger?: ModuleLogger; timeoutMs?: number } = {}) {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const logger = opts.logger;

  return {
    /**
     * Returns the full validator list. Filters out entries missing both
     * vote_identity and identity (defensive — Stakewiz occasionally returns
     * fragmentary entries during their own ingest cycles).
     */
    async fetchAllValidators(): Promise<StakewizValidator[]> {
      const url = `${STAKEWIZ_BASE}/validators`;
      const startedAt = Date.now();
      let res: Response;
      try {
        res = await fetch(url, {
          headers: { 'user-agent': 'sgdi/0.1 (+https://sgdi.app)' },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        logger?.warn('stakewiz.network_error', { url, detail });
        throw new StakewizError(`Stakewiz network: ${detail}`, null);
      }
      const dur = Date.now() - startedAt;

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        logger?.warn('stakewiz.http_error', { url, status: res.status, duration_ms: dur });
        throw new StakewizError(`Stakewiz HTTP ${res.status}: ${body.slice(0, 200)}`, res.status);
      }

      const data = (await res.json()) as unknown;
      if (!Array.isArray(data)) {
        logger?.warn('stakewiz.bad_shape', { url, type: typeof data });
        throw new StakewizError(`Stakewiz returned non-array (got ${typeof data})`, res.status);
      }

      const valid: StakewizValidator[] = (data as StakewizValidator[]).filter(
        (v) => v && typeof v === 'object' && (v.vote_identity || v.identity),
      );
      logger?.info('stakewiz.fetched', {
        url,
        duration_ms: dur,
        total: data.length,
        valid: valid.length,
      });
      return valid;
    },
  };
}
