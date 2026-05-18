// Diagnostic: are the 709 validators we'd mark as is_dz actually live on DZ?
//
// Spot-checks each User account's BGP status + last report slot to distinguish
// real working tunnels from stale/zombie registrations. Reports:
//   - Per-validator BGP roll-up (max across that validator's User accounts)
//   - Breakdown of the 709 "active" set by BGP liveness
//   - Drill-down on the contentious high-stake cases (DZ-direct vs legacy disagreements)

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { createDoubleZero, type DzUser } from '../src/lib/gdi/data-sources/doublezero.ts';
import { adhocLogger } from '../src/lib/gdi/logger.ts';

const DB_PATH = process.env.SGDI_DB_PATH ?? '/var/lib/sgdi/gdi.db';
const FEES_CSV_PATH = process.env.FEES_CSV_PATH ?? '/tmp/dz-check/fees.csv';
const DZDP_POOL = '3fV1sdGeXaNEZj6EPDTpub82pYxcRXwt2oie6jkSzeWi';

const dz = createDoubleZero({ logger: adhocLogger('dz-liveness') });
const users = await dz.fetchAllUsers();

// ───────────────────────────────────────────────────────────────────────────
// Roll up Users by validator identity
// ───────────────────────────────────────────────────────────────────────────

type ValidatorRoll = {
  identity: string;
  user_count: number;
  any_activated: boolean;
  any_bgp_up: boolean;
  any_bgp_down: boolean;
  any_bgp_unknown: boolean;
  latest_report_slot: number;
  latest_up_slot: number;
  user_types: Set<string>;
};

const byValidator = new Map<string, ValidatorRoll>();
const ZERO = '11111111111111111111111111111111';
for (const u of users) {
  if (u.user_type === 'Multicast') continue;
  if (u.validator_pubkey === ZERO) continue;
  let r = byValidator.get(u.validator_pubkey);
  if (!r) {
    r = {
      identity: u.validator_pubkey,
      user_count: 0,
      any_activated: false,
      any_bgp_up: false,
      any_bgp_down: false,
      any_bgp_unknown: false,
      latest_report_slot: 0,
      latest_up_slot: 0,
      user_types: new Set(),
    };
    byValidator.set(u.validator_pubkey, r);
  }
  r.user_count += 1;
  r.user_types.add(u.user_type);
  if (u.status === 'Activated') r.any_activated = true;
  if (u.bgp_status === 'Up') r.any_bgp_up = true;
  else if (u.bgp_status === 'Down') r.any_bgp_down = true;
  else if (u.bgp_status === 'Unknown') r.any_bgp_unknown = true;
  if (u.last_bgp_reported_at > r.latest_report_slot) r.latest_report_slot = u.last_bgp_reported_at;
  if (u.last_bgp_up_at > r.latest_up_slot) r.latest_up_slot = u.last_bgp_up_at;
}

// Get current Solana slot to compute recency. The DZ ledger is its own chain
// so slot numbers there don't directly map to Solana slots — but the LAST
// reported slot across the population gives us a "now" anchor.
let maxObservedSlot = 0;
for (const r of byValidator.values()) {
  if (r.latest_report_slot > maxObservedSlot) maxObservedSlot = r.latest_report_slot;
}
console.log(`Max reported slot across all DZ users (≈ current chain head): ${maxObservedSlot.toLocaleString()}`);
console.log('');

// ───────────────────────────────────────────────────────────────────────────
// Headline: of the 709 "Activated" validators, how many have a working tunnel?
// ───────────────────────────────────────────────────────────────────────────

const activated = [...byValidator.values()].filter(r => r.any_activated);
console.log(`Validators with at least one Activated User: ${activated.length}`);

const upOnly      = activated.filter(r =>  r.any_bgp_up);
const noUp        = activated.filter(r => !r.any_bgp_up);
const downNoUp    = activated.filter(r => !r.any_bgp_up &&  r.any_bgp_down);
const unkNoUp     = activated.filter(r => !r.any_bgp_up && !r.any_bgp_down &&  r.any_bgp_unknown);
const recentUp    = activated.filter(r =>  r.any_bgp_up && (maxObservedSlot - r.latest_up_slot) < 100_000);

console.log(`  ≥1 User BGP=Up at any point:        ${upOnly.length}  (real tunnel established)`);
console.log(`  BGP=Up reported within last ~100k slots:  ${recentUp.length}`);
console.log(`  No User BGP=Up, but some BGP=Down:  ${downNoUp.length}  (tried, tunnel currently down)`);
console.log(`  No BGP=Up, all Unknown:             ${unkNoUp.length}  (never connected? probably stale registrations)`);
console.log('');

// Distribution of latest_report_slot — recency of *any* report
function reportAgeBuckets() {
  const buckets = { recent: 0, day: 0, week: 0, month: 0, ancient: 0, never: 0 };
  const SLOTS_PER_DAY = 216_000;  // ~ Solana, also ~DZ since clock-synced
  for (const r of activated) {
    if (r.latest_report_slot === 0) { buckets.never++; continue; }
    const age = maxObservedSlot - r.latest_report_slot;
    if (age < SLOTS_PER_DAY)         buckets.recent++;
    else if (age < SLOTS_PER_DAY * 7)  buckets.day++;
    else if (age < SLOTS_PER_DAY * 30) buckets.week++;
    else if (age < SLOTS_PER_DAY * 90) buckets.month++;
    else                               buckets.ancient++;
  }
  return buckets;
}
console.log('Recency of last BGP report (among Activated validators):');
for (const [k, v] of Object.entries(reportAgeBuckets())) console.log(`  ${k.padEnd(8)} ${v}`);
console.log('');

// ───────────────────────────────────────────────────────────────────────────
// Drill-down: contentious cases against legacy sources
// ───────────────────────────────────────────────────────────────────────────

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

function describe(r: ValidatorRoll, label: string) {
  const meta = idMeta.get(r.identity);
  const stake = meta ? Math.round(meta.stake_sol).toLocaleString() : '?';
  const name = meta?.name ?? '';
  const recencyAge = r.latest_report_slot === 0 ? '?' :
    ((maxObservedSlot - r.latest_report_slot) / 216_000).toFixed(1);
  const upAge = r.latest_up_slot === 0 ? 'never' :
    ((maxObservedSlot - r.latest_up_slot) / 216_000).toFixed(1) + 'd';
  console.log(`${label}  ${r.identity.slice(0, 10)}…  stake=${stake.padStart(10)}  bgp_up_seen=${r.any_bgp_up ? 'Y' : 'N'}  last_up=${upAge}  last_report=${recencyAge}d  users=${r.user_count}  ${name}`);
}

// Case A: DZ-direct says YES but ALL legacy sources say NO. Are these real or zombies?
console.log('=== A. DZ-direct YES, ALL legacy NO (the "only-DZ-knows" set) — high stake first ===');
const onlyDz = activated
  .filter(r => !vaSet.has(r.identity) && !dzdpSet.has(r.identity) && !feesSet.has(r.identity))
  .filter(r => idMeta.has(r.identity))
  .sort((a, b) => (idMeta.get(b.identity)!.stake_sol) - (idMeta.get(a.identity)!.stake_sol));
console.log(`count: ${onlyDz.length}`);
for (const r of onlyDz.slice(0, 15)) describe(r, '  ');
console.log('');

// Case B: DZ-direct says NO but legacy (fees CSV in particular) says YES
console.log('=== B. fees CSV YES, DZ-direct NO — what happened? (top 15 by stake) ===');
const feesOnly = [...feesSet]
  .filter(id => !byValidator.get(id)?.any_activated)
  .filter(id => idMeta.has(id))
  .sort((a, b) => idMeta.get(b)!.stake_sol - idMeta.get(a)!.stake_sol);
console.log(`count: ${feesOnly.length}`);
for (const id of feesOnly.slice(0, 15)) {
  const r = byValidator.get(id);
  const meta = idMeta.get(id)!;
  if (r) {
    describe(r, '  in_dz_db ');
  } else {
    console.log(`  no_user_acct  ${id.slice(0, 10)}…  stake=${Math.round(meta.stake_sol).toLocaleString().padStart(10)}  ${meta.name ?? ''}`);
  }
}
console.log('');

// Case C: Sanity-check the headline major operators
console.log('=== C. Major operators — spot check ===');
const spotCheck = [
  { name: 'Ledger by Figment', id: 'q9XWcZ7T1w' },
  { name: 'Galaxy',            id: '9eGrDohdNT' },
  { name: 'Helius',            id: 'he1iusunGw' },
  { name: 'Everstake',         id: 'EvnRmnMrd6' },
  { name: 'Drift',             id: 'DrifTrN923' },
  { name: 'Nansen',            id: 'CoG8d9Fp2T' },
];
for (const sc of spotCheck) {
  const match = [...byValidator.values()].find(r => r.identity.startsWith(sc.id));
  const meta = match && idMeta.get(match.identity);
  if (match) {
    const recency = match.latest_report_slot === 0 ? '?' : ((maxObservedSlot - match.latest_report_slot) / 216_000).toFixed(1);
    const upAge = match.latest_up_slot === 0 ? 'never' : ((maxObservedSlot - match.latest_up_slot) / 216_000).toFixed(1) + 'd';
    console.log(`  ${sc.name.padEnd(20)}  IN DZ-direct  stake=${meta ? Math.round(meta.stake_sol).toLocaleString() : '?'}  users=${match.user_count}  bgp_up_seen=${match.any_bgp_up ? 'Y' : 'N'}  last_up=${upAge}  last_report=${recency}d`);
  } else {
    console.log(`  ${sc.name.padEnd(20)}  NOT in DZ-direct user list`);
  }
}
