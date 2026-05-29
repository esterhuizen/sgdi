#!/usr/bin/env node
// purge-cloudflare — invalidate the Cloudflare cache for gdindex.app.
//
// Used by deploy.sh after a prod release lands so the new build + new
// /gdi/* JSON show up to public users immediately rather than after the
// 4 h max-age. Can also be run by hand when you want to flush after an
// out-of-band publish.
//
// Env (loaded from /etc/default/sgdi.env in the systemd path; pass via
// shell env when invoking manually):
//   CLOUDFLARE_API_TOKEN          Bearer token with Zone:Cache Purge perm
//   CLOUDFLARE_ZONE_ID_GDINDEX    32-char hex zone id for gdindex.app
//
// Usage:
//   purge-cloudflare.mjs                  # purge_everything (default)
//   purge-cloudflare.mjs --files <urls>   # purge specific URLs (comma-sep)
//   purge-cloudflare.mjs --gdi-only       # purge only /gdi/*.json files
//                                          (preserves _next/static/ etc.)
//   purge-cloudflare.mjs --dry-run        # show what would be purged
//
// Free tier limit: 30 URLs per request. The --files / --gdi-only paths
// chunk into batches automatically.
//
// Exit codes:
//   0  purge requested + accepted by CF (one or more requests)
//   1  config missing
//   2  CF rejected a request

import { parseArgs } from 'node:util';

const CF_API = 'https://api.cloudflare.com/client/v4';
const ZONE_ID = process.env.CLOUDFLARE_ZONE_ID_GDINDEX;
const TOKEN   = process.env.CLOUDFLARE_API_TOKEN;
const BATCH_SIZE = 30;

// Static /gdi/* files Pass A + Pass B publish each cycle. We don't try
// to enumerate per-pool files here — instead we use a per-pool purge in
// the --gdi-only path below by querying the leaderboard for tracked addresses.
const GDI_STATIC_PATHS = [
  '/gdi/leaderboard-latest.json',
  '/gdi/network-baseline.json',
  '/gdi/validator-index.json',
  '/gdi/validators.json',
  '/gdi/methodology.json',
  '/gdi/pool-fees-latest.json',
  '/gdi/concentration-crosscheck.json',
];

function parseCli() {
  const { values } = parseArgs({
    options: {
      files:      { type: 'string' },
      'gdi-only': { type: 'boolean', default: false },
      'dry-run':  { type: 'boolean', default: false },
      help:       { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.log(`purge-cloudflare — flush gdindex.app Cloudflare cache

Default (no flags): purge entire zone. Safest after a deploy; takes ~1s,
costs nothing on free tier.

Options:
  --files <a,b,c>   Comma-separated URLs to purge (chunked at 30/req)
  --gdi-only        Purge only /gdi/*.json + per-pool files (preserves
                    immutable assets like /_next/static/)
  --dry-run         Print the plan without calling CF
  --help            This help
`);
    process.exit(0);
  }
  return values;
}

async function cfPost(path, body) {
  const res = await fetch(`${CF_API}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ success: false, errors: [{ message: `non-JSON response: HTTP ${res.status}` }] }));
  return { status: res.status, json };
}

function chunked(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function loadTrackedPoolPaths() {
  // Read leaderboard-latest.json from the local published tree to get
  // tracked pool addresses, then construct the per-pool /gdi/ URLs.
  // We can't rely on parsing it via fetch because Cloudflare might serve
  // the stale cached copy.
  const { readFile } = await import('node:fs/promises');
  const dir = process.env.SGDI_PUBLISHED_DIR ?? '/var/lib/sgdi/published';
  try {
    const lb = JSON.parse(await readFile(`${dir}/leaderboard-latest.json`, 'utf8'));
    const paths = [];
    for (const p of lb.pools ?? []) {
      paths.push(`/gdi/pools/${p.pool_address}/latest.json`);
      paths.push(`/gdi/pools/${p.pool_address}/history.json`);
    }
    return paths;
  } catch (e) {
    console.error(`warn: could not read leaderboard-latest.json from ${dir} — falling back to static paths only (${e.message})`);
    return [];
  }
}

function urlFor(path) {
  return `https://gdindex.app${path}`;
}

async function main() {
  const opts = parseCli();

  if (!TOKEN || !ZONE_ID) {
    console.error('error: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID_GDINDEX must be set');
    process.exit(1);
  }

  let body;
  let summary;
  if (opts.files) {
    const urls = opts.files.split(',').map((s) => s.trim()).filter(Boolean);
    if (urls.length === 0) {
      console.error('error: --files given but no URLs');
      process.exit(1);
    }
    body = { mode: 'files', items: urls };
    summary = `purge ${urls.length} specific URL${urls.length === 1 ? '' : 's'}`;
  } else if (opts['gdi-only']) {
    const poolPaths = await loadTrackedPoolPaths();
    const urls = [...GDI_STATIC_PATHS, ...poolPaths].map(urlFor);
    body = { mode: 'files', items: urls };
    summary = `purge ${urls.length} /gdi/* URLs (${GDI_STATIC_PATHS.length} static + ${poolPaths.length} per-pool)`;
  } else {
    body = { mode: 'all' };
    summary = 'purge entire zone (purge_everything)';
  }

  console.log(`plan: ${summary}`);
  if (opts['dry-run']) {
    if (body.mode === 'files') {
      console.log(`would chunk into ${Math.ceil(body.items.length / BATCH_SIZE)} request(s) of up to ${BATCH_SIZE} URLs each:`);
      for (const url of body.items.slice(0, 10)) console.log(`  ${url}`);
      if (body.items.length > 10) console.log(`  ... and ${body.items.length - 10} more`);
    }
    process.exit(0);
  }

  if (body.mode === 'all') {
    const r = await cfPost(`/zones/${ZONE_ID}/purge_cache`, { purge_everything: true });
    if (!r.json.success) {
      console.error(`CF purge failed (HTTP ${r.status}):`, JSON.stringify(r.json.errors));
      process.exit(2);
    }
    console.log(`purged: id=${r.json.result?.id ?? '(none)'}`);
    process.exit(0);
  }

  // Files mode: chunk + send
  const batches = chunked(body.items, BATCH_SIZE);
  let okCount = 0;
  for (const [i, batch] of batches.entries()) {
    const r = await cfPost(`/zones/${ZONE_ID}/purge_cache`, { files: batch });
    if (!r.json.success) {
      console.error(`batch ${i + 1}/${batches.length} failed (HTTP ${r.status}):`, JSON.stringify(r.json.errors));
      process.exit(2);
    }
    okCount += batch.length;
  }
  console.log(`purged: ${okCount} URLs in ${batches.length} request${batches.length === 1 ? '' : 's'}`);
}

main().catch((e) => {
  console.error('uncaught:', e);
  process.exit(2);
});
