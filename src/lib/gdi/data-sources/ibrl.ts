// IBRL (Increase Bandwidth, Reduce Latency) — Jito's block-build quality
// API. Public, no auth. Methodology: https://ibrl.wtf/methodology
//
// Score 0-100 composed of:
//   - 45% non-vote packing (compute distribution across PoH ticks)
//   - 40% slot time (block build ms vs handoff/continuation thresholds)
//   - 15% vote packing (% of votes processed early in block)
//
// Latency-/bandwidth-dominated — more direct signal for DC infra quality
// than Stakewiz wiz_score, which is a broader operator-quality composite.

import type { ModuleLogger } from '../logger.ts';

const BASE_URL =
  process.env.IBRL_BASE_URL || 'https://explorer.bam.dev';

export type IbrlValidator = {
  /** Node identity pubkey — joins to validators.identity_pubkey, NOT vote_pubkey. */
  identity: string;
  /** Composite 0-100. */
  ibrl_score: number;
  /** Sub-scores, kept for /methodology drill-down later. */
  build_time_score: number;
  vote_packing_score: number;
  non_vote_packing_score: number;
  /** How many blocks produced in this epoch — sample size for the score. */
  blocks_produced: number;
  /** Median block build time in ms; lower = better. */
  median_block_build_ms: number;
};

export class IbrlError extends Error {
  readonly httpStatus: number | null;
  constructor(message: string, httpStatus: number | null) {
    super(message);
    this.name = 'IbrlError';
    this.httpStatus = httpStatus;
  }
}

export function createIbrl(opts: {
  logger?: ModuleLogger;
  timeoutMs?: number;
} = {}) {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const logger = opts.logger;

  return {
    /**
     * Fetch IBRL scores for all validators in the current (or specified) epoch.
     * Returns one entry per validator that produced ≥1 block.
     */
    async fetchAllValidators(epoch?: number): Promise<IbrlValidator[]> {
      const qs = epoch != null ? `?epoch=${epoch}` : '';
      const url = `${BASE_URL}/api/v1/ibrl_validators${qs}`;
      const startedAt = Date.now();
      let res: Response;
      try {
        res = await fetch(url, {
          headers: { 'user-agent': 'sgdi/0.1 (+https://gdindex.app)' },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        logger?.warn('ibrl.network_error', { url, detail });
        throw new IbrlError(`IBRL network: ${detail}`, null);
      }
      const dur = Date.now() - startedAt;

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        logger?.warn('ibrl.http_error', { url, status: res.status, duration_ms: dur });
        throw new IbrlError(`IBRL HTTP ${res.status}: ${body.slice(0, 200)}`, res.status);
      }

      const json = (await res.json()) as { data?: unknown };
      const data = json?.data;
      if (!Array.isArray(data)) {
        logger?.warn('ibrl.bad_shape', { url, type: typeof data });
        throw new IbrlError(`IBRL returned non-array data (got ${typeof data})`, res.status);
      }

      const out: IbrlValidator[] = (data as Record<string, unknown>[])
        .filter((r) => typeof r.identity === 'string')
        .map((r) => ({
          identity: r.identity as string,
          ibrl_score: numberOrZero(r.ibrl_score),
          build_time_score: numberOrZero(r.build_time_score),
          vote_packing_score: numberOrZero(r.vote_packing_score),
          non_vote_packing_score: numberOrZero(r.non_vote_packing_score),
          blocks_produced: numberOrZero(r.blocks_produced),
          median_block_build_ms: numberOrZero(r.median_block_build_ms),
        }));

      logger?.info('ibrl.fetched', { url, duration_ms: dur, count: out.length });
      return out;
    },
  };
}

function numberOrZero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
