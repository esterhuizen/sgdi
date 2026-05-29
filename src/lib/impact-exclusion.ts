// Temporary exclusion list for /impact (page + opengraph-image).
//
// At epoch 978 the canonical geo backend switched from Stakewiz to the
// merged MaxMind+overrides world. For a handful of pools, MaxMind
// corrected long-standing country/city/ASN misclassifications, producing
// step-changes in GDI big enough to dominate the chart's y-axis on
// /impact and skew the OG card's headline numbers. These pools are
// excluded from the top-15 trajectory display until the chart's leftmost
// displayed epoch crosses 978 — by then the discontinuity rolls off the
// left edge naturally and inclusion is back to honest.
//
// Both /impact/page.tsx and /impact/opengraph-image.tsx import from
// here so the two views can't drift apart.
//
// REMOVE THIS WHEN: FIRST_EPOCH in page.tsx + opengraph-image.tsx is
// bumped past 978 (currently both are 969). Around epoch 987.

const TEMP_EXCLUDED_POOLS_UNTIL_EPOCH_987 = new Set<string>([
  'HQLwnQJFH7t9nBTP4vbdW4eHy62aecfDnj8te8VzqkFL', // BdMLRsol  — GDI ~1.80 → 2.63
  'spp1mo6shdcrRyqDK2zdurJ8H5uttZE6H6oVjHxN1QN', // xSHIN     — GDI ~2.54 → 2.99
]);

/**
 * Returns true if the given pool address should be hidden from /impact's
 * trajectory chart and OG card during the post-cutover transition window.
 */
export function isImpactExcluded(poolAddress: string): boolean {
  return TEMP_EXCLUDED_POOLS_UNTIL_EPOCH_987.has(poolAddress);
}
