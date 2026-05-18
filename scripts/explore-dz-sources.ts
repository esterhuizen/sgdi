// One-shot diagnostic comparing every source we have for the "is this validator
// on DoubleZero?" question. Read-only — does not write to DB or publish.
//
// Usage: node --experimental-strip-types scripts/explore-dz-sources.ts

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { createDoubleZero } from '../src/lib/gdi/data-sources/doublezero.ts';
import { adhocLogger } from '../src/lib/gdi/logger.ts';

const DB_PATH = process.env.SGDI_DB_PATH ?? '/var/lib/sgdi/gdi.db';
const FEES_CSV_PATH = process.env.FEES_CSV_PATH ?? '/tmp/dz-check/fees.csv';
const DZDP_POOL = '3fV1sdGeXaNEZj6EPDTpub82pYxcRXwt2oie6jkSzeWi';

const logger = adhocLogger('dz-explore');

// ───────────────────────────────────────────────────────────────────────────
// 1. Pull DZ-direct (on-chain User accounts on DZ mainnet-beta ledger)
// ───────────────────────────────────────────────────────────────────────────

console.log('=== fetching DZ User accounts from on-chain ledger ===');
const dz = createDoubleZero({ logger });
const t0 = Date.now();
const dzAll = await dz.fetchAllUsers();
const dzActiveIdentities = new Set<string>();
const dzAllIdentities = new Set<string>();
const byType: Record<string, number> = {};
const byStatus: Record<string, number> = {};
for (const u of dzAll) {
  byType[u.user_type] = (byType[u.user_type] ?? 0) + 1;
  byStatus[u.status] = (byStatus[u.status] ?? 0) + 1;
  if (u.validator_pubkey !== '11111111111111111111111111111111') {
    dzAllIdentities.add(u.validator_pubkey);
    if (u.user_type !== 'Multicast' && u.status === 'Activated') {
      dzActiveIdentities.add(u.validator_pubkey);
    }
  }
}
console.log(`fetched in ${Date.now() - t0}ms`);
console.log(`raw User accounts: ${dzAll.length}`);
console.log(`by user_type:`, byType);
console.log(`by status:`, byStatus);
console.log(`distinct validator pubkeys (any status): ${dzAllIdentities.size}`);
console.log(`distinct ACTIVE non-Multicast validator pubkeys: ${dzActiveIdentities.size}`);
console.log('');

// ───────────────────────────────────────────────────────────────────────────
// 2. Pull other sources we already have
// ───────────────────────────────────────────────────────────────────────────

const db = new Database(DB_PATH, { readonly: true });

// validators.app's is_dz=1 set — keyed by IDENTITY pubkey (since DZ list is
// keyed by identity).
const vaRows = db.prepare<[], { identity_pubkey: string; vote_pubkey: string; stake_sol: number; name: string | null }>(`
  SELECT identity_pubkey, validator_pubkey AS vote_pubkey,
         activated_stake_lamports/1e9 AS stake_sol,
         identity_name AS name
  FROM validators
  WHERE is_dz = 1 AND identity_pubkey IS NOT NULL
    AND delinquent = 0 AND activated_stake_lamports > 0
`).all();
const vaIdSet = new Set(vaRows.map(r => r.identity_pubkey));
console.log(`validators.app is_dz=1 set (identity): ${vaIdSet.size} validators`);

// DZDP — pool_snapshots is keyed by VOTE pubkey. We need to map to identity.
const dzdpVotes = db.prepare<[string, string], { validator_pubkey: string }>(`
  SELECT DISTINCT validator_pubkey FROM pool_snapshots
  WHERE pool_address = ?
    AND epoch = (SELECT MAX(epoch) FROM pool_snapshots WHERE pool_address = ?)
`).all(DZDP_POOL, DZDP_POOL);
const dzdpVoteSet = new Set(dzdpVotes.map(r => r.validator_pubkey));
// Translate to identity pubkeys via validators table
const voteToIdentity = new Map<string, string>();
const allValRows = db.prepare<[], { identity_pubkey: string | null; validator_pubkey: string; activated_stake_lamports: number | null; identity_name: string | null }>(`
  SELECT identity_pubkey, validator_pubkey, activated_stake_lamports, identity_name FROM validators
`).all();
for (const r of allValRows) {
  if (r.identity_pubkey) voteToIdentity.set(r.validator_pubkey, r.identity_pubkey);
}
const dzdpIdSet = new Set<string>();
for (const vote of dzdpVoteSet) {
  const id = voteToIdentity.get(vote);
  if (id) dzdpIdSet.add(id);
}
console.log(`DZDP-delegated set (identity): ${dzdpIdSet.size} validators (from ${dzdpVoteSet.size} votes)`);

// fees CSV (col 1 = identity pubkey)
const feesRaw = readFileSync(FEES_CSV_PATH, 'utf8');
const feesIdSet = new Set<string>();
const feesLines = feesRaw.split('\n');
for (let i = 1; i < feesLines.length; i++) {
  const line = feesLines[i].trim();
  if (!line) continue;
  const cols = line.split(',');
  if (cols[0]) feesIdSet.add(cols[0]);
}
console.log(`fees CSV (identity): ${feesIdSet.size} validators`);
console.log('');

// Also build a full identity-→-(stake, name) lookup for the active set so we
// can size + name interesting cells.
const activeById = new Map<string, { stake_sol: number; name: string | null; vote: string }>();
for (const r of allValRows) {
  if (r.identity_pubkey && r.activated_stake_lamports && r.activated_stake_lamports > 0) {
    activeById.set(r.identity_pubkey, {
      stake_sol: r.activated_stake_lamports / 1e9,
      name: r.identity_name,
      vote: r.validator_pubkey,
    });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 3. Cross-source comparison
// ───────────────────────────────────────────────────────────────────────────

function classify(id: string) {
  return {
    dz: dzActiveIdentities.has(id),
    va: vaIdSet.has(id),
    dzdp: dzdpIdSet.has(id),
    fees: feesIdSet.has(id),
  };
}

console.log('=== pairwise overlap (across distinct identity pubkeys) ===');
function pair(label: string, a: Set<string>, b: Set<string>) {
  const inter = [...a].filter(x => b.has(x)).length;
  const aOnly = [...a].filter(x => !b.has(x)).length;
  const bOnly = [...b].filter(x => !a.has(x)).length;
  console.log(`${label.padEnd(40)}  both=${inter}  A-only=${aOnly}  B-only=${bOnly}`);
}
pair('DZ-direct vs validators.app',   dzActiveIdentities, vaIdSet);
pair('DZ-direct vs DZDP',             dzActiveIdentities, dzdpIdSet);
pair('DZ-direct vs fees CSV',         dzActiveIdentities, feesIdSet);
pair('validators.app vs DZDP',        vaIdSet,            dzdpIdSet);
pair('validators.app vs fees CSV',    vaIdSet,            feesIdSet);
pair('DZDP vs fees CSV',              dzdpIdSet,          feesIdSet);
console.log('');

// 4-way: how does DZ-direct compare to ALL three legacy sources combined?
const union3 = new Set([...vaIdSet, ...dzdpIdSet, ...feesIdSet]);
console.log(`union of (validators.app ∪ DZDP ∪ fees): ${union3.size}`);
console.log(`DZ-direct ∩ union3: ${[...dzActiveIdentities].filter(x => union3.has(x)).length}`);
console.log(`DZ-direct \\ union3 (DZ knows about but nothing else does): ${[...dzActiveIdentities].filter(x => !union3.has(x)).length}`);
console.log(`union3 \\ DZ-direct (legacy says yes but DZ on-chain says no): ${[...union3].filter(x => !dzActiveIdentities.has(x)).length}`);
console.log('');

// ───────────────────────────────────────────────────────────────────────────
// 4. Drill-down: high-stake disagreements
// ───────────────────────────────────────────────────────────────────────────

function top(label: string, ids: string[]) {
  const rows = ids
    .map(id => ({ id, ...(activeById.get(id) ?? { stake_sol: 0, name: null, vote: '' }) }))
    .sort((a, b) => b.stake_sol - a.stake_sol);
  console.log(`\n=== ${label} (top 10 by stake; total in set = ${ids.length}) ===`);
  for (const r of rows.slice(0, 10)) {
    console.log(`  ${r.id.slice(0, 10)}…  ${Math.round(r.stake_sol).toString().padStart(10)} SOL  ${r.name ?? ''}`);
  }
  const totalStake = rows.reduce((s, r) => s + r.stake_sol, 0);
  console.log(`  total stake in set: ${Math.round(totalStake).toLocaleString()} SOL`);
}

top('validators.app says YES, DZ-direct says NO',
  [...vaIdSet].filter(id => !dzActiveIdentities.has(id) && activeById.has(id)));
top('DZ-direct says YES, validators.app says NO',
  [...dzActiveIdentities].filter(id => !vaIdSet.has(id) && activeById.has(id)));
top('fees CSV says YES, DZ-direct says NO',
  [...feesIdSet].filter(id => !dzActiveIdentities.has(id) && activeById.has(id)));
top('DZ-direct says YES, fees CSV says NO',
  [...dzActiveIdentities].filter(id => !feesIdSet.has(id) && activeById.has(id)));

console.log('\nDONE');
