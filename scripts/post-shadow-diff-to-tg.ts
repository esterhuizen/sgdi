// Daily Telegram summary of canonical vs shadow output diff.
//
// Runs via sgdi-shadow-diff-tg.timer (default 19:00 UTC = 7 am NZ standard
// time). Calls bin/geo-shadow-diff.mjs --json, formats a short message,
// posts it to the SGDI ops chat via sendSgdiAlert.
//
// Purpose: passive monitoring during the ≥2-week shadow window so the
// operator can spot stability or sudden shocks without having to log in
// and run the diff CLI by hand.
//
// Failure modes:
//   - Diff CLI exits non-zero (missing files) → send a "diff unavailable"
//     alert instead of silently doing nothing. Operator wants to know.
//   - Telegram not configured → log and exit 0 (matches watchdog behaviour).
//   - sendSgdiAlert returns non-ok → log + exit non-zero so systemd surfaces
//     the failure in journal.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { sendSgdiAlert } from '../src/lib/gdi/telegram.ts';

const exec = promisify(execFile);

const REPO_ROOT      = resolve(import.meta.dirname, '..');
const DIFF_CLI       = resolve(REPO_ROOT, 'bin/geo-shadow-diff.mjs');
const CANONICAL_DIR  = process.env.SGDI_PUBLISHED_DIR ?? '/var/lib/sgdi/published';
const SHADOW_DIR     = process.env.SGDI_SHADOW_PUBLISHED_DIR ?? '/var/lib/sgdi/published-shadow';
const TOP_N          = Number.parseInt(process.env.SGDI_SHADOW_DIFF_TOP ?? '3', 10);

// ─────────────────────────────────────────────────────────────────────────
// Number formatters that match the CLI's text output (kept compact for TG)
// ─────────────────────────────────────────────────────────────────────────
const fmt = (n: number | null | undefined, d = 3): string =>
  n == null || Number.isNaN(n) ? '—' : n.toFixed(d);
const fmtSigned = (n: number | null | undefined, d = 3): string =>
  n == null || Number.isNaN(n) ? '—' : (n >= 0 ? '+' : '') + n.toFixed(d);
const fmtSignedInt = (n: number | null | undefined): string =>
  n == null ? '—' : (n >= 0 ? '+' : '') + n;
const fmtPct1 = (n: number | null | undefined): string =>
  n == null || Number.isNaN(n) ? '—' : `${(n * 100).toFixed(1)}%`;

// ─────────────────────────────────────────────────────────────────────────
// Compose the TG message from the diff JSON
// ─────────────────────────────────────────────────────────────────────────
function composeMessage(diff: Record<string, any>): string {
  const n = diff.network;
  const p = diff.pools;
  const v = diff.validators;

  const lines: string[] = [];
  const date = new Date().toISOString().slice(0, 10);
  lines.push(`Shadow diff · epoch ${n.epoch_canonical} · ${date}`);
  if (n.epoch_canonical !== n.epoch_shadow) {
    lines.push(`⚠ epoch mismatch: canonical=${n.epoch_canonical} shadow=${n.epoch_shadow}`);
  }
  lines.push('');

  // Network
  lines.push(`Network GDI: ${fmt(n.gdi.canonical)} → ${fmt(n.gdi.shadow)} (${fmtSigned(n.gdi.delta)})`);
  lines.push(`  country: ${fmt(n.dc_country.canonical)} → ${fmt(n.dc_country.shadow)} (${fmtSigned(n.dc_country.delta)})`);
  lines.push(`  city:    ${fmt(n.dc_city.canonical)} → ${fmt(n.dc_city.shadow)} (${fmtSigned(n.dc_city.delta)})`);
  lines.push(`  asn:     ${fmt(n.dc_asn.canonical)} → ${fmt(n.dc_asn.shadow)} (${fmtSigned(n.dc_asn.delta)})`);
  lines.push('');

  // Pools
  lines.push(`Pools: ${p.total_pools} tracked, ${p.rank_changed_count} changed rank`);
  if (p.top_rank_movers.length > 0) {
    lines.push('  top rank movers:');
    for (const r of p.top_rank_movers.slice(0, TOP_N)) {
      const name = (r.pool_name ?? r.pool_address.slice(0, 8)).padEnd(12).slice(0, 12);
      lines.push(`    ${name} #${r.canonical_rank} → #${r.shadow_rank} (${fmtSignedInt(r.rank_delta)})`);
    }
  }
  if (p.top_gdi_movers.length > 0) {
    lines.push('  top GDI movers:');
    for (const r of p.top_gdi_movers.slice(0, TOP_N)) {
      const name = (r.pool_name ?? r.pool_address.slice(0, 8)).padEnd(12).slice(0, 12);
      lines.push(`    ${name} ${fmt(r.canonical_gdi, 2)} → ${fmt(r.shadow_gdi, 2)} (${fmtSigned(r.gdi_delta, 2)})`);
    }
  }
  lines.push('');

  // Validators
  lines.push(`Validators: ${v.active_shadow} active, ${v.rankable_shadow} rankable`);
  lines.push(`  median composite: ${fmt(v.median_composite_rarity.canonical)} → ${fmt(v.median_composite_rarity.shadow)} (${fmtSigned(v.median_composite_rarity.delta)})`);
  lines.push(`  real geo Δ: ${v.geo_changed_count_normalised}` +
    ` (country ${v.geo_changed_by_field_normalised.country}` +
    `, city ${v.geo_changed_by_field_normalised.city}` +
    `, asn ${v.geo_changed_by_field_normalised.asn})`);
  lines.push('  source mix by active stake:');
  for (const f of ['country', 'city', 'asn'] as const) {
    const m = v.source_mix_stake_share[f];
    const parts: string[] = [];
    if (m.override > 0)         parts.push(`override ${fmtPct1(m.override)}`);
    if (m.maxmind > 0)          parts.push(`maxmind ${fmtPct1(m.maxmind)}`);
    if (m.stakewiz > 0)         parts.push(`stakewiz ${fmtPct1(m.stakewiz)}`);
    if (m['validators-app'] > 0) parts.push(`va ${fmtPct1(m['validators-app'])}`);
    if (m.none > 0)             parts.push(`none ${fmtPct1(m.none)}`);
    lines.push(`    ${f.padEnd(7)} ${parts.join(', ')}`);
  }

  // Top validator rank movers (most expensive section — keep tight)
  if (v.top_rank_movers.length > 0) {
    lines.push('');
    lines.push('Top validator rank movers:');
    for (const r of v.top_rank_movers.slice(0, TOP_N)) {
      const name = ((r.identity_name && String(r.identity_name).trim()) || r.vote_pubkey.slice(0, 8)).slice(0, 22);
      lines.push(`  ${name.padEnd(22)} #${r.canonical_rank} → #${r.shadow_rank} (${fmtSignedInt(r.rank_delta)})`);
      lines.push(`    ${r.canonical_geo}  →  ${r.shadow_geo}`);
    }
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────
async function runDiff(): Promise<{ ok: true; diff: Record<string, any> } | { ok: false; reason: string }> {
  try {
    const { stdout } = await exec('/usr/bin/node', [
      DIFF_CLI,
      '--canonical-dir', CANONICAL_DIR,
      '--shadow-dir',    SHADOW_DIR,
      '--top',           String(TOP_N),
      '--json',
    ], { maxBuffer: 16 * 1024 * 1024, timeout: 30_000 });
    return { ok: true, diff: JSON.parse(stdout) };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return { ok: false, reason: (err.stderr ?? '').trim() || err.message || String(e) };
  }
}

async function main(): Promise<void> {
  const result = await runDiff();
  let body: string;
  if (result.ok) {
    body = composeMessage(result.diff);
  } else {
    body = `Shadow diff failed: ${result.reason.slice(0, 1500)}\n\n(Canonical: ${CANONICAL_DIR}\n Shadow:    ${SHADOW_DIR})`;
  }

  const tg = await sendSgdiAlert(body);
  if (tg.ok) {
    console.log('sent (' + body.length + ' chars)');
    process.exit(0);
  }
  if (tg.reason === 'not_configured') {
    // Match watchdog behaviour: be silent + successful when TG isn't set up
    // (e.g. in dev). The journal still has the composed message above.
    console.log('TELEGRAM_* env vars not set; would have sent:');
    console.log(body);
    process.exit(0);
  }
  console.error(`telegram send failed: ${tg.reason}${tg.detail ? ' — ' + tg.detail : ''}`);
  process.exit(1);
}

main().catch((e) => {
  console.error('uncaught:', e);
  process.exit(1);
});
