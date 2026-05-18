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
  // gdi-1.2 phase 3 — present on leaderboard entries (publish embeds per pool).
  // Absent on history JSON entries (intentional — history rows are score-only).
  client_distribution?: ClientDistribution | null;
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
  // Network-wide client distribution for baseline comparison on pool pages.
  // Optional for backwards compat with older published JSON.
  network_client_distribution?: ClientDistribution | null;
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
  // Client family + version (from getClusterNodes) + operational flags.
  client_name?: string | null;
  client_version?: string | null;
  is_jito?: boolean | null;
  is_dz?: boolean | null;
  is_bam?: boolean | null;
};

// Stake-weighted client breakdown per pool. Published by gdi-publish.
export type ClientDistribution = {
  by_client: { client: string; stake_sol: number; stake_share: number; validator_count: number }[];
  operational: { jito_share: number; dz_share: number; bam_share: number };
  effective_clients: number | null;
  unclassified: { stake_sol: number; stake_share: number };
};

export type PoolLatest = {
  pool: { address: string; name: string | null; program: string | null; token_mint: string | null };
  score: FormattedScore;
  network_baseline: FormattedBaseline | null;
  rank: number | null;
  total_ranked: number;
  // Optional for backwards compat — older published JSON won't have it.
  client_distribution?: ClientDistribution | null;
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

// ───────────────────────────────────────────────────────────────────────────
// Validator index — used by /validator/* pages
// ───────────────────────────────────────────────────────────────────────────

export type ValidatorIndexEntry = {
  vote_pubkey: string;
  identity_pubkey: string | null;
  identity_name: string | null;
  image_url: string | null;
  country: string | null;
  city: string | null;
  asn: string | null;
  asn_name: string | null;
  activated_stake_sol: number;
  network_share_country: number | null;
  network_share_city: number | null;
  network_share_asn: number | null;
  rarity_country: number | null;
  rarity_city: number | null;
  rarity_asn: number | null;
  composite_rarity: number | null;
  rank: number | null;
  percentile: number | null;
  // Operational flags surfaced for the /locations dashboard.
  is_dz?: boolean | null;
  is_jito?: boolean | null;
  is_bam?: boolean | null;
  // Coarse client family (Agave / Frankendancer / null) — from gossip version.
  client_name?: string | null;
  client_version?: string | null;
  // Stakewiz composite performance score (0-100). Optional for backwards
  // compat with older published JSON that pre-dates the field.
  wiz_score?: number | null;
  // IBRL block-build quality (Jito) 0-100. Null when validator produced no
  // blocks in the current epoch.
  ibrl_score?: number | null;
};

export type ValidatorIndex = {
  last_published_at: string;
  epoch: number;
  methodology_version: string;
  active_set_definition: string;
  active_count: number;
  rankable_count: number;
  total_active_stake_sol: number;
  median_composite_rarity: number | null;
  validators: ValidatorIndexEntry[];
};

export const loadValidatorIndex = () => loadJson<ValidatorIndex>('validator-index.json');

export const loadLeaderboard = () => loadJson<Leaderboard>('leaderboard-latest.json');
export const loadLeaderboardForEpoch = (epoch: number) =>
  loadJson<Leaderboard>(`leaderboard-${epoch}.json`);
export const loadPoolLatest = (address: string) =>
  loadJson<PoolLatest>(`pools/${address}/latest.json`);
export const loadPoolHistory = (address: string) =>
  loadJson<PoolHistory>(`pools/${address}/history.json`);
export const loadNetworkBaseline = () => loadJson<NetworkBaselineFile>('network-baseline.json');
