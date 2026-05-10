// Server-side loader for the published GDI JSON files.
//
// In dev: reads from ./public/gdi/ (where `npm run publish` writes by default).
// In prod: SGDI_PUBLISHED_DIR env points at /var/lib/sgdi/published/, which
// nginx also serves at /gdi/* via a `location /gdi/ { alias ... }` block.
//
// All loaders return null on missing/malformed file rather than throwing —
// the UI shows a "coming soon" state rather than a 500.

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const PUBLISHED_DIR = resolve(
  process.env.SGDI_PUBLISHED_DIR || join(process.cwd(), 'public/gdi'),
);

async function loadJson<T>(relativePath: string): Promise<T | null> {
  try {
    const raw = await readFile(join(PUBLISHED_DIR, relativePath), 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Shared types matching the publish script's JSON shape
// ───────────────────────────────────────────────────────────────────────────

export type FormattedScore = {
  epoch: number;
  pool_address: string;
  dc_country: number | null;
  dc_city: number | null;
  dc_asn: number | null;
  gdi: number | null;
  nis: number | null;
  placement_coverage: number | null;
  validator_count: number | null;
  total_stake_sol: number | null;
  methodology_version: string;
  pool_name?: string | null;
  pool_program?: string | null;
  pool_token_mint?: string | null;
};

export type FormattedBaseline = {
  epoch: number;
  dc_country: number | null;
  dc_city: number | null;
  dc_asn: number | null;
  gdi: number | null;
  validator_count: number | null;
  total_stake_sol: number | null;
  methodology_version: string;
};

export type Leaderboard = {
  epoch: number;
  last_published_at: string;
  methodology_version: string;
  network_baseline: FormattedBaseline | null;
  pools: FormattedScore[];
};

export type PoolValidator = {
  pubkey: string;
  stake_sol: number;
  country: string | null;
  city: string | null;
  asn: string | null;
  asn_name: string | null;
  wiz_score: number | null;
};

export type PoolLatest = {
  pool: { address: string; name: string | null; program: string | null; token_mint: string | null };
  score: FormattedScore;
  network_baseline: FormattedBaseline | null;
  validators: PoolValidator[];
};

export type PoolHistory = {
  pool: { address: string; name: string | null };
  methodology_version: string;
  history: FormattedScore[];
};

export type NetworkBaselineFile = {
  latest: FormattedBaseline | null;
  history: FormattedBaseline[];
};

// ───────────────────────────────────────────────────────────────────────────
// Loaders
// ───────────────────────────────────────────────────────────────────────────

export const loadLeaderboard = () => loadJson<Leaderboard>('leaderboard-latest.json');
export const loadLeaderboardForEpoch = (epoch: number) =>
  loadJson<Leaderboard>(`leaderboard-${epoch}.json`);
export const loadPoolLatest = (address: string) =>
  loadJson<PoolLatest>(`pools/${address}/latest.json`);
export const loadPoolHistory = (address: string) =>
  loadJson<PoolHistory>(`pools/${address}/history.json`);
export const loadNetworkBaseline = () => loadJson<NetworkBaselineFile>('network-baseline.json');
