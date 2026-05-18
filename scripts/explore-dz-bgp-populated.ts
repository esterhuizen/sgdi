// Find DZ User accounts where BGP fields are actually populated, and report
// liveness vs cross-source confirmation for the 709 active set.

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { createDoubleZero } from '../src/lib/gdi/data-sources/doublezero.ts';
import { adhocLogger } from '../src/lib/gdi/logger.ts';

const DB_PATH = process.env.SGDI_DB_PATH ?? '/var/lib/sgdi/gdi.db';
const FEES_CSV_PATH = process.env.FEES_CSV_PATH ?? '/tmp/dz-check/fees.csv';
const DZDP_POOL = '3fV1sdGeXaNEZj6EPDTpub82pYxcRXwt2oie6jkSzeWi';

const dz = createDoubleZero({ logger: adhocLogger('dz-bgp') });
const users = await dz.fetchAllUsers();
const ZERO = '11111111111111111111111111111111';

// 1. How many users have populated BGP fields at all?
let bgpUp = 0, bgpDown = 0, bgpUnknown = 0;
let nonZeroReport = 0, nonZeroUp = 0;
const popValidatorsUp = new Set<string>();
const popValidatorsAny = new Set<string>();
for (const u of users) {
  if (u.user_type === 'Multicast') continue;
  if (u.validator_pubkey === ZERO) continue;
  if (u.bgp_status === 'Up')        { bgpUp++;       popValidatorsUp.add(u.validator_pubkey); popValidatorsAny.add(u.validator_pubkey); }
  else if (u.bgp_status === 'Down') { bgpDown++;     popValidatorsAny.add(u.validator_pubkey); }
  else                              { bgpUnknown++; }
  if (u.last_bgp_reported_at > 0)   { nonZeroReport++; popValidatorsAny.add(u.validator_pubkey); }
  if (u.last_bgp_up_at > 0)         { nonZeroUp++;     popValidatorsUp.add(u.validator_pubkey); }
}
console.log('=== BGP-field population across non-Multicast users ===');
console.log(`Users with bgp_status=Up:      ${bgpUp}`);
console.log(`Users with bgp_status=Down:    ${bgpDown}`);
console.log(`Users with bgp_status=Unknown: ${bgpUnknown}`);
console.log(`Users with last_bgp_reported_at > 0: ${nonZeroReport}`);
console.log(`Users with last_bgp_up_at > 0:       ${nonZeroUp}`);
console.log(`Distinct validators with ≥1 BGP=Up report: ${popValidatorsUp.size}`);
console.log(`Distinct validators with ANY BGP report:   ${popValidatorsAny.size}`);
console.log('');

// 2. Cross-source confirmation: of the 709 DZ-direct active validators,
//    how many are corroborated by DZDP, fees CSV, validators.app?
const activeSet = new Set<string>();
for (const u of users) {
  if (u.user_type === 'Multicast') continue;
  if (u.validator_pubkey === ZERO) continue;
  if (u.status !== 'Activated') continue;
  activeSet.add(u.validator_pubkey);
}

const db = new Database(DB_PATH, { readonly: true });
const vaRows = db.prepare<[], { identity_pubkey: string }>(`
  SELECT identity_pubkey FROM validators
  WHERE is_dz = 1 AND identity_pubkey IS NOT NULL
    AND delinquent = 0 AND activated_stake_lamports > 0
`).all();
const vaSet = new Set(vaRows.map(r => r.identity_pubkey));

const dzdpVotes = db.prepare<[string, string], { validator_pubkey: string }>(`
  SELECT DISTINCT validator_pubkey FROM pool_snapshots
  WHERE pool_address = ?
    AND epoch = (SELECT MAX(epoch) FROM pool_snapshots WHERE pool_address = ?)
`).all(DZDP_POOL, DZDP_POOL);
const allValRows = db.prepare<[], { identity_pubkey: string | null; validator_pubkey: string; activated_stake_lamports: number | null; identity_name: string | null }>(`
  SELECT identity_pubkey, validator_pubkey, activated_stake_lamports, identity_name FROM validators
`).all();
const voteToId = new Map<string, string>();
const idMeta = new Map<string, { stake_sol: number; name: string | null }>();
for (const r of allValRows) {
  if (r.identity_pubkey) {
    voteToId.set(r.validator_pubkey, r.identity_pubkey);
    if (r.activated_stake_lamports && r.activated_stake_lamports > 0) {
      idMeta.set(r.identity_pubkey, { stake_sol: r.activated_stake_lamports / 1e9, name: r.identity_name });
    }
  }
}
const dzdpSet = new Set<string>();
for (const v of dzdpVotes) {
  const id = voteToId.get(v.validator_pubkey);
  if (id) dzdpSet.add(id);
}
const feesRaw = readFileSync(FEES_CSV_PATH, 'utf8');
const feesSet = new Set<string>();
for (const line of feesRaw.split('\n').slice(1)) {
  const c = line.trim().split(',');
  if (c[0]) feesSet.add(c[0]);
}

// Of the 709 "DZ-direct Activated" set, count confirmations
let confDzdp = 0, confFees = 0, confVa = 0;
let confDzdpOrFees = 0;
let confAny = 0;
let activeInOurSet = 0;
let stakeCorroborated = 0;
let stakeUncorroborated = 0;
const uncorroboratedActive: { id: string; stake: number; name: string | null }[] = [];

for (const id of activeSet) {
  const inOurActive = idMeta.has(id);
  if (inOurActive) activeInOurSet++;
  const inDzdp = dzdpSet.has(id);
  const inFees = feesSet.has(id);
  const inVa   = vaSet.has(id);
  if (inDzdp) confDzdp++;
  if (inFees) confFees++;
  if (inVa)   confVa++;
  if (inDzdp || inFees) confDzdpOrFees++;
  if (inDzdp || inFees || inVa) confAny++;

  if (inOurActive) {
    const meta = idMeta.get(id)!;
    if (inDzdp || inFees) stakeCorroborated += meta.stake_sol;
    else {
      stakeUncorroborated += meta.stake_sol;
      uncorroboratedActive.push({ id, stake: meta.stake_sol, name: meta.name });
    }
  }
}

console.log('=== Of 709 DZ-direct Activated set, how many corroborated? ===');
console.log(`Total in DZ-direct Activated set:           ${activeSet.size}`);
console.log(`...that are in our SGDI active validator set: ${activeInOurSet}`);
console.log('');
console.log('Cross-source corroboration:');
console.log(`  Also in DZDP delegations (real-time):       ${confDzdp}`);
console.log(`  Also in fees CSV (foundation billing):      ${confFees}`);
console.log(`  Also in validators.app is_dz=1:             ${confVa}`);
console.log(`  In DZDP OR fees CSV:                        ${confDzdpOrFees}`);
console.log(`  In ANY legacy source (DZDP|fees|va):        ${confAny}`);
console.log('');
console.log(`Stake breakdown (across ${activeInOurSet} active validators):`);
console.log(`  corroborated (in DZDP or fees CSV): ${Math.round(stakeCorroborated).toLocaleString()} SOL`);
console.log(`  uncorroborated by DZDP/fees:        ${Math.round(stakeUncorroborated).toLocaleString()} SOL`);
console.log(`  → uncorroborated %:                 ${(100 * stakeUncorroborated / (stakeCorroborated + stakeUncorroborated)).toFixed(1)}%`);
console.log('');

// 3. Drill into the uncorroborated set — these are validators where:
//    - DZ-direct says they have an Activated User account
//    - But they're NOT in DZDP delegations
//    - And NOT in the fees CSV (last 5 epochs)
//    These should be smaller / newer validators. If high-stake ones appear,
//    that's suspicious and we should investigate.
console.log('=== Top 15 uncorroborated active validators (DZ-direct says yes, DZDP+fees say no) ===');
uncorroboratedActive.sort((a, b) => b.stake - a.stake);
for (const r of uncorroboratedActive.slice(0, 15)) {
  console.log(`  ${r.id.slice(0, 10)}…  ${Math.round(r.stake).toString().padStart(10)} SOL  ${r.name ?? ''}`);
}
console.log(`  ...and ${Math.max(0, uncorroboratedActive.length - 15)} more`);
