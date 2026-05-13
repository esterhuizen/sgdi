// Shared UI constants for the leaderboard view.
//
// Lives outside the components that use it so the same value can be read by
// the client component (LeaderboardWithSearch) AND the server-rendered OG
// images (per-pool opengraph-image). Keeping it in one place avoids the
// silent drift that happens when "the default filter" is hardcoded in
// multiple places.

/**
 * Default minimum total stake (SOL) used to filter pools on first page load
 * AND when computing the rank shown on per-pool OG cards. Pools below this
 * threshold are still in the dataset (and reachable via the "All" pill or
 * search), they just don't count toward the headline rank.
 */
export const DEFAULT_TVL_FLOOR_SOL = 100_000;
