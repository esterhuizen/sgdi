// Diagnostic: figure out whether DZ User account's `validator_pubkey` field
// is the Solana identity pubkey or the vote pubkey, and how it relates to
// the `owner` field. Read-only; prints classification.

import Database from 'better-sqlite3';
import { createDoubleZero } from '../src/lib/gdi/data-sources/doublezero.ts';
import { adhocLogger } from '../src/lib/gdi/logger.ts';

const DB_PATH = process.env.SGDI_DB_PATH ?? '/var/lib/sgdi/gdi.db';

const dz = createDoubleZero({ logger: adhocLogger('dz-keytype') });
const users = await dz.fetchAllUsers();

// Build lookup sets from our DB
const db = new Database(DB_PATH, { readonly: true });
const allValRows = db.prepare<[], { identity_pubkey: string | null; validator_pubkey: string }>(`
  SELECT identity_pubkey, validator_pubkey FROM validators
`).all();
const identitySet = new Set<string>();
const voteSet = new Set<string>();
const idToVote = new Map<string, string>();
const voteToId = new Map<string, string>();
for (const r of allValRows) {
  voteSet.add(r.validator_pubkey);
  if (r.identity_pubkey) {
    identitySet.add(r.identity_pubkey);
    idToVote.set(r.identity_pubkey, r.validator_pubkey);
    voteToId.set(r.validator_pubkey, r.identity_pubkey);
  }
}
console.log(`SGDI validators table: ${voteSet.size} vote pks, ${identitySet.size} identity pks`);
console.log('');

// Classify each User account
let ownerEqValidator = 0;
let ownerNeqValidator = 0;
let ownerIsIdentity = 0, ownerIsVote = 0, ownerUnknown = 0;
let validatorIsIdentity = 0, validatorIsVote = 0, validatorUnknown = 0, validatorIsZero = 0;

const ZERO = '11111111111111111111111111111111';
const samples: Array<{owner: string; validator_pubkey: string; ownerClass: string; valClass: string; user_type: string}> = [];

for (const u of users) {
  if (u.owner === u.validator_pubkey) ownerEqValidator++;
  else ownerNeqValidator++;

  let oc = 'unknown', vc = 'unknown';
  if (identitySet.has(u.owner))      { oc = 'identity'; ownerIsIdentity++; }
  else if (voteSet.has(u.owner))     { oc = 'vote';     ownerIsVote++; }
  else                                ownerUnknown++;

  if (u.validator_pubkey === ZERO)        { vc = 'ZERO';     validatorIsZero++; }
  else if (identitySet.has(u.validator_pubkey)) { vc = 'identity'; validatorIsIdentity++; }
  else if (voteSet.has(u.validator_pubkey))     { vc = 'vote';     validatorIsVote++; }
  else                                          { validatorUnknown++; }

  if (samples.length < 8 && oc !== 'unknown' && vc !== 'unknown' && u.user_type !== 'Multicast') {
    samples.push({ owner: u.owner, validator_pubkey: u.validator_pubkey, ownerClass: oc, valClass: vc, user_type: u.user_type });
  }
}

console.log(`Total decoded User accounts: ${users.length}`);
console.log('');
console.log('owner field classification:');
console.log(`  matches SGDI identity_pubkey: ${ownerIsIdentity}`);
console.log(`  matches SGDI vote pubkey:     ${ownerIsVote}`);
console.log(`  unknown (not in our DB):      ${ownerUnknown}`);
console.log('');
console.log('validator_pubkey field classification:');
console.log(`  zero/empty:                   ${validatorIsZero}`);
console.log(`  matches SGDI identity_pubkey: ${validatorIsIdentity}`);
console.log(`  matches SGDI vote pubkey:     ${validatorIsVote}`);
console.log(`  unknown (not in our DB):      ${validatorUnknown}`);
console.log('');
console.log(`owner == validator_pubkey:    ${ownerEqValidator}`);
console.log(`owner != validator_pubkey:    ${ownerNeqValidator}`);
console.log('');

console.log('=== sample rows ===');
for (const s of samples) {
  console.log(`  user_type=${s.user_type}`);
  console.log(`    owner=${s.owner.slice(0, 12)}…  (${s.ownerClass})`);
  console.log(`    val=  ${s.validator_pubkey.slice(0, 12)}…  (${s.valClass})`);
}
