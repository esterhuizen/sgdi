// Jupiter LST tag list — friendly names for liquid-staking-token mints.
//
// Jupiter maintains a curated list of every LST they recognise, exposed at:
//   https://lite-api.jup.ag/tokens/v2/tag?query=lst
//
// We use it as the source of names for newly-discovered stake pools. A pool
// account exposes its `poolMint`; we look up that mint in this list to get
// the human name + symbol. Pools whose mint isn't in the list (rare; usually
// brand-new or non-standard LSTs) come through nameless — the watchlist file
// at `config/pools-watchlist.json` exists as a manual override for those.
//
// The response is a flat array of token objects; we only care about
// `id` (the mint) and `name` / `symbol`. Anything else is ignored so this
// stays resilient to Jupiter adding fields.

import type { ModuleLogger } from '../logger.ts';

const JUPITER_LST_URL =
  process.env.JUPITER_LST_URL || 'https://lite-api.jup.ag/tokens/v2/tag?query=lst';

export type JupiterLstEntry = {
  mint: string;
  name: string | null;
  symbol: string | null;
};

type RawJupiterToken = {
  id?: unknown;
  name?: unknown;
  symbol?: unknown;
};

export type JupiterOptions = {
  url?: string;
  timeoutMs?: number;
  logger?: ModuleLogger;
};

export function createJupiter({
  url = JUPITER_LST_URL,
  timeoutMs = 20_000,
  logger,
}: JupiterOptions = {}) {
  return {
    /**
     * Fetch the full LST tag list. Returns [] on any failure (network, parse,
     * unexpected shape) — naming is non-critical; the ingest carries on.
     */
    async fetchLstList(): Promise<JupiterLstEntry[]> {
      const startedAt = Date.now();
      let res: Response;
      try {
        res = await fetch(url, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        logger?.warn('jupiter.network_error', {
          url,
          detail: e instanceof Error ? e.message : String(e),
        });
        return [];
      }

      if (!res.ok) {
        logger?.warn('jupiter.http_error', {
          url,
          status: res.status,
          duration_ms: Date.now() - startedAt,
        });
        return [];
      }

      let data: unknown;
      try {
        data = await res.json();
      } catch (e) {
        logger?.warn('jupiter.parse_error', {
          url,
          detail: e instanceof Error ? e.message : String(e),
        });
        return [];
      }

      if (!Array.isArray(data)) {
        logger?.warn('jupiter.bad_shape', { url, type: typeof data });
        return [];
      }

      const out: JupiterLstEntry[] = [];
      for (const raw of data as RawJupiterToken[]) {
        if (raw && typeof raw === 'object' && typeof raw.id === 'string') {
          out.push({
            mint: raw.id,
            name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : null,
            symbol: typeof raw.symbol === 'string' && raw.symbol.length > 0 ? raw.symbol : null,
          });
        }
      }
      logger?.info('jupiter.fetched', { count: out.length, duration_ms: Date.now() - startedAt });
      return out;
    },
  };
}

/**
 * Build a mint → display-name lookup map from a list of Jupiter entries.
 * Prefers `symbol` (shorter, more brand-y like "JitoSOL"); falls back to
 * `name` (e.g. "Jito Staked SOL"). Returns lowercase-keyed map for safe
 * lookup regardless of case quirks in the source.
 */
export function buildMintNameMap(entries: readonly JupiterLstEntry[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of entries) {
    const display = e.symbol || e.name;
    if (display) m.set(e.mint, display);
  }
  return m;
}
