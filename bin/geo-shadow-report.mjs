#!/usr/bin/env node
// geo-shadow-report — read-only CLI for inspecting validator_geo_shadow.
//
// The shadow ingest pass (scripts/gdi-ingest.ts) writes per-epoch
// (shadow, canonical, match) triples for every active validator into the
// validator_geo_shadow table. This CLI is the operator-facing window
// into that data — agreement percentages, lists of disagreements, and
// per-validator history.
//
// Nothing in this script can mutate the DB. We open storage in read-only
// mode and only call the list* helpers.
//
// Usage:
//   bin/geo-shadow-report.mjs                              # latest-epoch summary
//   bin/geo-shadow-report.mjs --epoch 978
//   bin/geo-shadow-report.mjs --epoch 978 --field country --mismatch
//   bin/geo-shadow-report.mjs --epoch 978 --field country --mismatch --limit 30
//   bin/geo-shadow-report.mjs --validator <pubkey>         # full history for one
//   bin/geo-shadow-report.mjs --trend                      # last 10 epochs
//   bin/geo-shadow-report.mjs --trend --epochs 20

import { parseArgs } from 'node:util';
import { openStorage } from '../src/lib/gdi/storage.ts';

const DB_PATH = process.env.SGDI_DB_PATH ?? '/var/lib/sgdi/gdi.db';
const FIELDS = ['country', 'city', 'asn'];

function parseCli() {
  const { values } = parseArgs({
    options: {
      epoch:     { type: 'string' },
      field:     { type: 'string' },          // country | city | asn
      mismatch:  { type: 'boolean', default: false },
      validator: { type: 'string' },
      trend:     { type: 'boolean', default: false },
      epochs:    { type: 'string', default: '10' },
      limit:     { type: 'string', default: '20' },
      help:      { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  if (values.help) { printHelp(); process.exit(0); }
  return values;
}

function printHelp() {
  console.log(`geo-shadow-report — inspect MaxMind shadow vs canonical agreement

Modes (mutually exclusive):
  (default)                       summary for the latest epoch
  --epoch <N>                     summary for a specific epoch
  --epoch <N> --field <f> --mismatch   list disagreements (f in [country|city|asn])
  --validator <pubkey>            full per-epoch history for one validator
  --trend                         agreement % across recent epochs

Options:
  --epochs <N>     trend window length (default 10)
  --limit <N>      max disagreement rows to list (default 20)

Read-only against SGDI_DB_PATH (default /var/lib/sgdi/gdi.db).
`);
}

function abbrev(s, n = 8) {
  return s.length > n + 4 ? s.slice(0, n) + '…' + s.slice(-4) : s;
}

function pct(numer, denom) {
  if (denom === 0) return '—';
  return ((100 * numer) / denom).toFixed(1) + '%';
}

function summary(rows, label) {
  // Each dimension: matches / mismatches / nulls
  const dims = { country: { m: 0, x: 0, n: 0 }, city: { m: 0, x: 0, n: 0 }, asn: { m: 0, x: 0, n: 0 } };
  for (const r of rows) {
    for (const d of FIELDS) {
      const v = r[`${d}_match`];
      if (v === 1) dims[d].m++;
      else if (v === 0) dims[d].x++;
      else dims[d].n++;
    }
  }
  console.log(`=== ${label} · ${rows.length} validators ===\n`);
  const w = 16;
  console.log(`  ${'dimension'.padEnd(10)} ${'match'.padStart(8)} ${'mismatch'.padStart(10)} ${'null'.padStart(8)} ${'agreement'.padStart(11)}`);
  console.log(`  ${'-'.repeat(10)} ${'-'.repeat(8)} ${'-'.repeat(10)} ${'-'.repeat(8)} ${'-'.repeat(11)}`);
  for (const d of FIELDS) {
    const compared = dims[d].m + dims[d].x;
    console.log(`  ${d.padEnd(10)} ${String(dims[d].m).padStart(8)} ${String(dims[d].x).padStart(10)} ${String(dims[d].n).padStart(8)} ${pct(dims[d].m, compared).padStart(11)}`);
  }
  console.log('');
  console.log(`  agreement = matches / (matches + mismatches); null rows excluded`);
}

function listMismatches(s, epoch, field, limit) {
  const all = s.listGeoShadowForEpoch(epoch);
  const matchKey = `${field}_match`;
  const sCol = `shadow_${field}`;
  const cCol = `canonical_${field}`;
  const orgCols = field === 'asn' ? ['shadow_asn_name', 'canonical_asn_name'] : null;
  const mismatches = all.filter((r) => r[matchKey] === 0);
  console.log(`=== mismatches on '${field}' · epoch ${epoch} · ${mismatches.length} row${mismatches.length === 1 ? '' : 's'} ===\n`);
  if (mismatches.length === 0) return;
  const names = new Map();
  for (const r of mismatches) {
    const vr = s.getValidator(r.validator_pubkey);
    names.set(r.validator_pubkey, vr?.identity_name ?? null);
  }
  const shown = mismatches.slice(0, limit);
  // Table: pubkey · name · ip · shadow → canonical [+org line for asn]
  for (const r of shown) {
    const name = (names.get(r.validator_pubkey) || '').slice(0, 28);
    const ip = (r.ip_used ?? '').padEnd(15);
    const sh = String(r[sCol] ?? 'null').padEnd(22);
    const cn = String(r[cCol] ?? 'null').padEnd(22);
    console.log(`  ${abbrev(r.validator_pubkey, 10).padEnd(16)}  ${name.padEnd(28)}  ${ip}  shadow=${sh}  canonical=${cn}`);
    if (orgCols) {
      const so = String(r[orgCols[0]] ?? '').padEnd(22);
      const co = String(r[orgCols[1]] ?? '').padEnd(22);
      console.log(`  ${''.padEnd(16)}  ${''.padEnd(28)}  ${''.padEnd(15)}  org=${so}     org=${co}`);
    }
  }
  if (mismatches.length > limit) {
    console.log(`\n  … ${mismatches.length - limit} more (pass --limit ${mismatches.length} to see all)`);
  }
}

function validatorHistory(s, pubkey) {
  const rows = s.listGeoShadowForValidator(pubkey);
  if (rows.length === 0) { console.log(`no shadow rows for ${pubkey}`); return; }
  const vr = s.getValidator(pubkey);
  console.log(`=== ${pubkey} ===`);
  if (vr) console.log(`    ${vr.identity_name ?? '(unnamed)'} · identity ${vr.identity_pubkey ?? '?'}\n`);
  console.log(`  ${'epoch'.padEnd(7)} ${'ip'.padEnd(15)}  shadow vs canonical (mismatches starred)`);
  console.log(`  ${'-'.repeat(7)} ${'-'.repeat(15)}  ${'-'.repeat(60)}`);
  for (const r of rows) {
    const star = (k) => r[`${k}_match`] === 0 ? ' *' : '  ';
    console.log(`  ${String(r.epoch).padEnd(7)} ${(r.ip_used ?? '?').padEnd(15)}  country: ${(r.shadow_country ?? '?').padEnd(4)} vs ${(r.canonical_country ?? '?').padEnd(18)}${star('country')}`);
    console.log(`  ${''.padEnd(7)} ${''.padEnd(15)}  city:    ${(r.shadow_city ?? '?').padEnd(22)} vs ${r.canonical_city ?? '?'}${star('city')}`);
    console.log(`  ${''.padEnd(7)} ${''.padEnd(15)}  asn:     ${(r.shadow_asn ?? '?').padEnd(22)} vs ${r.canonical_asn ?? '?'}${star('asn')}`);
    console.log('');
  }
}

function trendReport(s, lookback) {
  // Pull every epoch present in validator_geo_shadow, take the last N
  const all = s.listBaselines(); // ordered DESC by epoch; cheap proxy for "epochs we know about"
  const epochs = all.map((b) => b.epoch).filter((e) => e != null).slice(0, lookback).reverse();
  if (epochs.length === 0) { console.log('no epochs found'); return; }
  console.log(`=== shadow vs canonical agreement · last ${epochs.length} epoch${epochs.length === 1 ? '' : 's'} ===\n`);
  console.log(`  ${'epoch'.padEnd(7)} ${'rows'.padStart(6)} ${'country'.padStart(10)} ${'city'.padStart(10)} ${'asn'.padStart(10)}`);
  console.log(`  ${'-'.repeat(7)} ${'-'.repeat(6)} ${'-'.repeat(10)} ${'-'.repeat(10)} ${'-'.repeat(10)}`);
  for (const epoch of epochs) {
    const rows = s.listGeoShadowForEpoch(epoch);
    if (rows.length === 0) { console.log(`  ${String(epoch).padEnd(7)} ${'(no shadow data)'.padStart(40)}`); continue; }
    const t = (f) => {
      let m = 0, x = 0;
      for (const r of rows) {
        if (r[`${f}_match`] === 1) m++;
        else if (r[`${f}_match`] === 0) x++;
      }
      return pct(m, m + x);
    };
    console.log(`  ${String(epoch).padEnd(7)} ${String(rows.length).padStart(6)} ${t('country').padStart(10)} ${t('city').padStart(10)} ${t('asn').padStart(10)}`);
  }
}

async function main() {
  const args = parseCli();
  const s = openStorage(DB_PATH, { readonly: true });

  if (args.validator) {
    validatorHistory(s, args.validator);
    return;
  }
  if (args.trend) {
    trendReport(s, Number(args.epochs) || 10);
    return;
  }

  const epoch = args.epoch ? Number(args.epoch) : (s.latestScoredEpoch() ?? null);
  if (epoch == null) { console.error('no epoch available'); process.exit(1); }

  if (args.field && args.mismatch) {
    if (!FIELDS.includes(args.field)) {
      console.error(`bad --field "${args.field}"; expected one of ${FIELDS.join(', ')}`);
      process.exit(2);
    }
    listMismatches(s, epoch, args.field, Number(args.limit) || 20);
    return;
  }

  const rows = s.listGeoShadowForEpoch(epoch);
  if (rows.length === 0) {
    console.error(`no shadow rows for epoch ${epoch}`);
    process.exit(1);
  }
  summary(rows, `epoch ${epoch}`);
}

main().catch((e) => { console.error('fatal:', e?.message ?? e); process.exit(1); });
