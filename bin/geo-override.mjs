#!/usr/bin/env node
// geo-override — manage validator_geo_overrides.
//
// Operator-supplied corrections for cases where automated geo lookup
// (MaxMind / Stakewiz / VA) gets the answer wrong. Partial overrides
// supported: any combination of {country, city, asn, asn_name} may be
// set; null/missing fields fall through to the next source.
//
// Currently affects ONLY the shadow computation (validator_geo_shadow).
// Promotion to canonical (pickField in enrichment.ts) is a later change.
//
// Commands:
//   geo-override list                                 # all overrides, last-added first
//   geo-override show <pubkey>                        # one entry
//   geo-override set <pubkey> [flags] --reason="..." [--source-evidence=URL]
//                                                    # add / update (upsert)
//   geo-override clear-field <pubkey> --field <f>     # null one dimension
//   geo-override remove <pubkey>                      # delete row entirely
//   geo-override validate                             # schema check
//
// Flags for `set` (any subset):
//   --country=DE        --city="Frankfurt"
//   --asn=24940         --asn-name="Hetzner Online"
//   --added-by=tielman  (default: $USER / whoami)

import { parseArgs } from 'node:util';
import { openStorage } from '../src/lib/gdi/storage.ts';

const DB_PATH = process.env.SGDI_DB_PATH ?? '/var/lib/sgdi/gdi.db';
const FIELDS = ['country', 'city', 'asn', 'asn_name'];

function parseCli() {
  const { values, positionals } = parseArgs({
    options: {
      country:          { type: 'string' },
      city:             { type: 'string' },
      asn:              { type: 'string' },
      'asn-name':       { type: 'string' },
      reason:           { type: 'string' },
      'source-evidence':{ type: 'string' },
      'added-by':       { type: 'string' },
      field:            { type: 'string' },
      help:             { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });
  if (values.help || positionals.length === 0) {
    printHelp();
    process.exit(values.help ? 0 : 1);
  }
  return { values, command: positionals[0], args: positionals.slice(1) };
}

function printHelp() {
  console.log(`geo-override — manage validator_geo_overrides

Usage:
  bin/geo-override.mjs <command> [args]

Commands:
  list                                       List all overrides, newest first
  show <pubkey>                              Show one override
  set <pubkey> [flags] --reason="..."        Upsert. Any combination of
                                             --country / --city / --asn /
                                             --asn-name supported; NULL means
                                             "fall through" on that dimension.
  clear-field <pubkey> --field <name>        Null one dimension (country/
                                             city/asn/asn_name)
  remove <pubkey>                            Delete the override entirely
  validate                                   Schema check

Affects only the shadow pipeline today. Live scoring is unchanged.
`);
}

function whoami() {
  return process.env.USER || process.env.LOGNAME || 'unknown';
}

function requireReason(values) {
  const r = values.reason?.trim();
  if (!r) {
    console.error('error: --reason is required (every override needs a rationale)');
    process.exit(2);
  }
  return r;
}

function looksLikePubkey(s) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

function validateExists(storage, pubkey) {
  // Refuse unknown pubkeys: typos lose work and operators sometimes confuse
  // identity ↔ vote pubkey. If the validator isn't in our table, surface a
  // clear error instead of silently writing an orphan row.
  const v = storage.getValidator(pubkey);
  if (!v) {
    console.error(`error: pubkey ${pubkey} not found in validators table`);
    console.error('       (geo-override is keyed by VOTE pubkey — if you have the');
    console.error('        identity pubkey, look up the matching vote pubkey first)');
    process.exit(2);
  }
  return v;
}

function fmtField(v, label) {
  if (v == null) return `${label}=—`;
  return `${label}=${v}`;
}

function showOne(o) {
  if (!o) { console.log('(no override)'); return; }
  console.log(`  ${o.validator_pubkey}`);
  console.log(`    ${fmtField(o.country, 'country')}  ${fmtField(o.city, 'city')}  ${fmtField(o.asn, 'asn')}  ${fmtField(o.asn_name, 'asn_name')}`);
  console.log(`    reason: ${o.reason}`);
  if (o.source_evidence) console.log(`    evidence: ${o.source_evidence}`);
  console.log(`    added: ${new Date(o.added_at * 1000).toISOString()} by ${o.added_by}`);
}

function cmdList(s) {
  const all = s.listGeoOverrides();
  console.log(`${all.length} override${all.length === 1 ? '' : 's'}`);
  if (all.length === 0) return;
  console.log('');
  for (const o of all) {
    showOne(o);
    console.log('');
  }
}

function cmdShow(s, [pubkey]) {
  if (!pubkey) { console.error('usage: show <pubkey>'); process.exit(2); }
  const o = s.getGeoOverride(pubkey);
  showOne(o);
}

function cmdSet(s, [pubkey], values) {
  if (!pubkey) { console.error('usage: set <pubkey> [flags] --reason="..."'); process.exit(2); }
  if (!looksLikePubkey(pubkey)) {
    console.error(`error: "${pubkey}" doesn't look like a base58 pubkey (32-44 chars)`);
    process.exit(2);
  }
  validateExists(s, pubkey);
  const reason = requireReason(values);

  // At least one of the four dimensions must be set or the override is a no-op.
  const country  = values.country  != null ? values.country  : null;
  const city     = values.city     != null ? values.city     : null;
  const asn      = values.asn      != null ? values.asn      : null;
  const asn_name = values['asn-name'] != null ? values['asn-name'] : null;

  // If we're UPSERTING (pubkey already has a row), the user might be adding to
  // an existing override. Preserve any field they didn't pass.
  const existing = s.getGeoOverride(pubkey);
  const merged = {
    validator_pubkey: pubkey,
    country:   country  ?? existing?.country  ?? null,
    city:      city     ?? existing?.city     ?? null,
    asn:       asn      ?? existing?.asn      ?? null,
    asn_name:  asn_name ?? existing?.asn_name ?? null,
    reason,
    source_evidence: values['source-evidence'] ?? existing?.source_evidence ?? null,
    added_at: Math.floor(Date.now() / 1000),
    added_by: values['added-by'] ?? whoami(),
  };

  if (!merged.country && !merged.city && !merged.asn && !merged.asn_name) {
    console.error('error: nothing to override — provide at least one of --country / --city / --asn / --asn-name');
    process.exit(2);
  }

  s.upsertGeoOverride(merged);
  console.log(`${existing ? 'updated' : 'created'} override for ${pubkey}`);
  console.log('');
  showOne(s.getGeoOverride(pubkey));
}

function cmdClearField(s, [pubkey], values) {
  if (!pubkey || !values.field) { console.error('usage: clear-field <pubkey> --field <name>'); process.exit(2); }
  if (!FIELDS.includes(values.field)) {
    console.error(`error: bad --field "${values.field}"; expected one of ${FIELDS.join(', ')}`);
    process.exit(2);
  }
  const existing = s.getGeoOverride(pubkey);
  if (!existing) { console.error(`no override for ${pubkey}`); process.exit(1); }
  const updated = { ...existing, [values.field]: null, added_at: Math.floor(Date.now() / 1000), added_by: values['added-by'] ?? whoami() };
  // If clearing this field leaves the override completely empty, prompt to remove instead.
  if (!updated.country && !updated.city && !updated.asn && !updated.asn_name) {
    console.error(`error: clearing --field ${values.field} would leave the override empty; use "remove" instead`);
    process.exit(2);
  }
  s.upsertGeoOverride(updated);
  console.log(`cleared --field ${values.field} on ${pubkey}`);
  console.log('');
  showOne(s.getGeoOverride(pubkey));
}

function cmdRemove(s, [pubkey]) {
  if (!pubkey) { console.error('usage: remove <pubkey>'); process.exit(2); }
  const n = s.deleteGeoOverride(pubkey);
  if (n === 0) console.log(`(no-op) no override for ${pubkey}`);
  else console.log(`removed override for ${pubkey}`);
}

function cmdValidate(s) {
  const all = s.listGeoOverrides();
  let bad = 0;
  for (const o of all) {
    if (!o.reason || o.reason.trim().length === 0) { console.error(`  ✗ ${o.validator_pubkey}: missing reason`); bad++; }
    if (!o.added_by || o.added_by.trim().length === 0) { console.error(`  ✗ ${o.validator_pubkey}: missing added_by`); bad++; }
    if (!o.country && !o.city && !o.asn && !o.asn_name) { console.error(`  ✗ ${o.validator_pubkey}: empty override (all dimensions null)`); bad++; }
  }
  if (bad === 0) console.log(`✓ ${all.length} override${all.length === 1 ? '' : 's'} valid`);
  else process.exit(1);
}

async function main() {
  const { values, command, args } = parseCli();
  const needsWrite = ['set', 'clear-field', 'remove'].includes(command);
  const s = openStorage(DB_PATH, needsWrite ? {} : { readonly: true });

  switch (command) {
    case 'list':        cmdList(s);                       break;
    case 'show':        cmdShow(s, args);                 break;
    case 'set':         cmdSet(s, args, values);          break;
    case 'clear-field': cmdClearField(s, args, values);   break;
    case 'remove':      cmdRemove(s, args);               break;
    case 'validate':    cmdValidate(s);                   break;
    default:
      console.error(`unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((e) => { console.error('fatal:', e?.message ?? e); process.exit(1); });
