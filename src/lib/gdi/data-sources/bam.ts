// BAM (Block Assembly Marketplace, Jito) connected-validator list.
//
// Public no-auth API. Returns the set of validators currently routing their
// block production through BAM. Used as the `is_bam` operational flag on
// each validator — orthogonal to `is_jito` (running Jito-modified client)
// and `is_dz` (using DoubleZero networking).
//
// API shape (verified 2026-05-17):
//   GET https://explorer.bam.dev/api/v1/validators
//   → [ { validator_pubkey, bam_node_connection, stake, stake_percentage }, ... ]
//
// `validator_pubkey` in the response is the Solana IDENTITY pubkey (verified
// against our validators table by direct match on a sample row).

import type { ModuleLogger } from '../logger.ts';

const DEFAULT_URL = 'https://explorer.bam.dev/api/v1/validators';

export type BamValidator = {
  /** Solana validator IDENTITY pubkey. */
  identity_pubkey: string;
  /** BAM node region/name the validator is attached to (e.g. "ny-mainnet-bam-2-tee"). */
  bam_node: string;
  stake_sol: number;
};

export type BamOptions = {
  url?: string;
  timeoutMs?: number;
  logger?: ModuleLogger;
};

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createBam(opts: BamOptions = {}) {
  const url = opts.url ?? process.env.BAM_VALIDATORS_URL ?? DEFAULT_URL;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const logger = opts.logger;

  return {
    async fetchConnectedValidators(): Promise<BamValidator[]> {
      const startedAt = Date.now();
      let res: Response;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        logger?.warn('bam.network_error', { url, detail: errMessage(e) });
        throw new Error(`BAM fetch network: ${errMessage(e)}`);
      }
      const dur = Date.now() - startedAt;
      if (!res.ok) {
        logger?.warn('bam.http_error', { url, status: res.status, duration_ms: dur });
        throw new Error(`BAM HTTP ${res.status}`);
      }
      // Response is either a bare array or { data: [...] }. Handle both.
      const json = (await res.json()) as unknown;
      const arr: Array<Record<string, unknown>> = Array.isArray(json)
        ? (json as Array<Record<string, unknown>>)
        : (json as { data?: Array<Record<string, unknown>> }).data ?? [];

      const out: BamValidator[] = [];
      for (const row of arr) {
        const pk = typeof row.validator_pubkey === 'string' ? row.validator_pubkey : null;
        if (!pk) continue;
        out.push({
          identity_pubkey: pk,
          bam_node: typeof row.bam_node_connection === 'string' ? row.bam_node_connection : '',
          stake_sol: typeof row.stake === 'number' ? row.stake : 0,
        });
      }
      logger?.info('bam.fetched', { url, duration_ms: Date.now() - startedAt, count: out.length });
      return out;
    },

    /** Convenience: just the set of IDENTITY pubkeys (what enrichment needs). */
    async fetchConnectedIdentitySet(): Promise<Set<string>> {
      const list = await this.fetchConnectedValidators();
      return new Set(list.map((v) => v.identity_pubkey));
    },
  };
}
