// Diagnostic: run the new 5-bucket classifier against current data and
// report the global breakdown by count and stake-weight.

import Database from 'better-sqlite3';
import { classifyClient } from '../src/lib/gdi/enrichment.ts';
import { createRpc } from '../src/lib/gdi/data-sources/rpc.ts';
import { createBam } from '../src/lib/gdi/data-sources/bam.ts';
import { adhocLogger } from '../src/lib/gdi/logger.ts';

const DB_PATH = process.env.SGDI_DB_PATH ?? '/var/lib/sgdi/gdi.db';
const RPC_URL = process.env.HELIUS_RPC_URL ?? 'https://api.mainnet-beta.solana.com';

const logger = adhocLogger('classify');

console.log('=== fetching cluster nodes ===');
const rpc = createRpc({ url: RPC_URL, logger });
const nodes = await rpc.getClusterNodes();
const versionByIdentity = new Map(nodes.map((n) => [n.pubkey, n.version]));
console.log(`cluster nodes: ${nodes.length}`);

console.log('=== fetching BAM connected ===');
const bam = createBam({ logger });
const bamSet = await bam.fetchConnectedIdentitySet();
console.log(`BAM connected: ${bamSet.size}`);

console.log('=== reading validators table ===');
const db = new Database(DB_PATH, { readonly: true });
const rows = db.prepare<[], {
  identity_pubkey: string | null;
  validator_pubkey: string;
  activated_stake_lamports: number | null;
  is_jito: number | null;
  delinquent: number | null;
}>(`
  SELECT identity_pubkey, validator_pubkey, activated_stake_lamports, is_jito, delinquent
  FROM validators
`).all();
const activeRows = rows.filter(
  (r) => r.delinquent === 0 && r.activated_stake_lamports != null && r.activated_stake_lamports > 0,
);
console.log(`active validators in DB: ${activeRows.length}`);
console.log('');

// Classify
const buckets = new Map<string, { count: number; stake_sol: number }>();
let noIdentity = 0;
let noVersion = 0;

for (const r of activeRows) {
  if (!r.identity_pubkey) {
    noIdentity++;
    continue;
  }
  const version = versionByIdentity.get(r.identity_pubkey) ?? null;
  if (!version) {
    noVersion++;
  }
  const label = classifyClient(version, r.is_jito === 1, bamSet.has(r.identity_pubkey)) ?? 'Unknown';
  const stakeSol = Number(r.activated_stake_lamports!) / 1e9;
  const cur = buckets.get(label) ?? { count: 0, stake_sol: 0 };
  cur.count += 1;
  cur.stake_sol += stakeSol;
  buckets.set(label, cur);
}

const totalStake = [...buckets.values()].reduce((s, b) => s + b.stake_sol, 0);
const totalCount = [...buckets.values()].reduce((s, b) => s + b.count, 0);

console.log('=== Global client breakdown (active validators) ===');
console.log(`${'Bucket'.padEnd(15)}  ${'count'.padStart(6)}  ${'count%'.padStart(7)}  ${'stake SOL'.padStart(13)}  ${'stake%'.padStart(7)}`);
console.log('-'.repeat(60));
const sorted = [...buckets.entries()].sort((a, b) => b[1].stake_sol - a[1].stake_sol);
for (const [label, b] of sorted) {
  console.log(
    `${label.padEnd(15)}  ${b.count.toString().padStart(6)}  ` +
    `${(100 * b.count / totalCount).toFixed(1).padStart(6)}%  ` +
    `${Math.round(b.stake_sol).toLocaleString().padStart(13)}  ` +
    `${(100 * b.stake_sol / totalStake).toFixed(1).padStart(6)}%`,
  );
}
console.log('-'.repeat(60));
console.log(`TOTAL          ${totalCount.toString().padStart(8)}            ${Math.round(totalStake).toLocaleString().padStart(13)}`);

console.log('');
console.log(`No identity_pubkey: ${noIdentity}`);
console.log(`No matching cluster version (validator in DB but not in gossip): ${noVersion}`);

// Effective clients (Shannon entropy across the 5 buckets) — same math as
// what gdi-publish computes per-pool, applied to whole network.
console.log('');
let entropy = 0;
for (const b of buckets.values()) {
  if (b.stake_sol > 0) {
    const p = b.stake_sol / totalStake;
    entropy -= p * Math.log(p);
  }
}
console.log(`effective_clients (network) = ${Math.exp(entropy).toFixed(2)}`);
console.log(`  (max possible with ${buckets.size} buckets = ${buckets.size}; closer to ${buckets.size} = more diverse)`);

// Also: how many distinct gossip version strings would fall into each bucket?
console.log('');
console.log('=== version-string detail (top 5 versions per non-empty bucket) ===');
const versionsByBucket = new Map<string, Map<string, number>>();
for (const r of activeRows) {
  if (!r.identity_pubkey) continue;
  const v = versionByIdentity.get(r.identity_pubkey);
  if (!v) continue;
  const label = classifyClient(v, r.is_jito === 1, bamSet.has(r.identity_pubkey)) ?? 'Unknown';
  let m = versionsByBucket.get(label);
  if (!m) { m = new Map(); versionsByBucket.set(label, m); }
  m.set(v, (m.get(v) ?? 0) + 1);
}
for (const [label, m] of versionsByBucket) {
  const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log(`  ${label}: ${top.map(([v, n]) => `${v}=${n}`).join(', ')}`);
}
