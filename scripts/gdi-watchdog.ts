// SGDI staleness + sanity watchdog.
//
// Runs hourly via systemd timer. Three independent check groups:
//
//   1. HEARTBEAT — has the gdi-ingest.timer fired in the last
//      HEARTBEAT_HOURS hours? If not, systemd is broken or the timer was
//      masked. Queried via `systemctl show gdi-ingest.timer LastTriggerUSec`.
//
//   2. DATA FRESHNESS — has any ingestion_run recorded status='success' or
//      'partial' within STALE_HOURS hours? If not, we've missed at least
//      one expected epoch transition. Solana epochs are ~48h, so the
//      default threshold is 60h.
//
//   3. PUBLISHED-OUTPUT SANITY — is what we just published *plausible*?
//      (a) active-set stake hasn't swung > STAKE_DELTA_PCT between ticks,
//      (b) no pool's GDI moved > POOL_GDI_DELTA_PCT within one epoch,
//      (c) no published pool carries stake-weighted floor-rarity values.
//      Catches upstream data blips (e.g. the 2026-06-10 transient Stakewiz
//      delinquency flag that briefly inflated BNSOL's GDI by +106%).
//
// Any check failing fires a Telegram alert. Repeat alerts within
// ALERT_COOLDOWN_H are suppressed so a sustained outage doesn't spam.
//
// State: /var/lib/sgdi/watchdog.state (last alert timestamp) and
// /var/lib/sgdi/watchdog-sanity.state (last-seen epoch/stake/pool-GDIs).
//
// Why two checks: the ingest's own failure-alert handles "ran and failed";
// HEARTBEAT handles "didn't run at all"; FRESHNESS handles "ran but always
// skipped — yet we should have moved to a new epoch by now". Together,
// these cover the realistic failure modes for an unattended pipeline.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStorage } from '../src/lib/gdi/storage.ts';
import { sendSgdiAlert } from '../src/lib/gdi/telegram.ts';

const exec = promisify(execFile);

const HEARTBEAT_HOURS   = Number(process.env.SGDI_WATCHDOG_HEARTBEAT_HOURS ?? 2);
const STALE_HOURS       = Number(process.env.SGDI_WATCHDOG_STALE_HOURS ?? 60);
const ALERT_COOLDOWN_H  = Number(process.env.SGDI_WATCHDOG_COOLDOWN_HOURS ?? 6);

// ── Check 3 (SANITY) thresholds ──
// Added after the 2026-06-10 incident: one bad Stakewiz delinquency sample
// removed a 13.4M-SOL validator from the active set for one 30-min cycle and
// inflated BNSOL's published GDI by +106%. These bounds catch that class of
// event at the next watchdog tick instead of relying on someone eyeballing
// the leaderboard.
const STAKE_DELTA_PCT     = Number(process.env.SGDI_WATCHDOG_STAKE_DELTA_PCT ?? 2);     // active-stake move between ticks
const POOL_GDI_DELTA_PCT  = Number(process.env.SGDI_WATCHDOG_POOL_GDI_DELTA_PCT ?? 15); // per-pool intra-epoch GDI move
const FLOOR_RARITY_MIN    = Number(process.env.SGDI_WATCHDOG_FLOOR_RARITY_MIN ?? 15);   // rarity this high on real stake ⇒ floor blowup
// Dust validators alone in a tiny bucket legitimately reach r ≈ 15 (e.g.
// 0.3 SOL alone in its own city: -ln(0.3/4e8)). At ≥ 1,000 SOL the largest
// legitimate rarity is ~12.9, safely under FLOOR_RARITY_MIN — so the stake
// gate makes the floor scan false-positive-free.
const FLOOR_SCAN_MIN_SOL  = Number(process.env.SGDI_WATCHDOG_FLOOR_SCAN_MIN_SOL ?? 1000);

const STATE_DIR  = process.env.SGDI_DATA_DIR ?? '/var/lib/sgdi';
const STATE_FILE = join(STATE_DIR, 'watchdog.state');
const SANITY_STATE_FILE = join(STATE_DIR, 'watchdog-sanity.state');
const PUBLISHED_DIR = process.env.SGDI_PUBLISHED_DIR ?? '/var/lib/sgdi/published';

function fmtAge(ms: number): string {
  const hr = ms / 3_600_000;
  if (hr < 1) return `${Math.round(ms / 60_000)}m`;
  if (hr < 24) return `${hr.toFixed(1)}h`;
  return `${(hr / 24).toFixed(1)}d`;
}

type AlertState = { ts_ms: number };

function readLastAlert(): AlertState | null {
  if (!existsSync(STATE_FILE)) return null;
  try {
    const ms = Date.parse(readFileSync(STATE_FILE, 'utf8').trim());
    return Number.isFinite(ms) ? { ts_ms: ms } : null;
  } catch {
    return null;
  }
}

function writeLastAlert(now: Date): void {
  try {
    writeFileSync(STATE_FILE, now.toISOString() + '\n', { mode: 0o644 });
  } catch (e) {
    console.error('watchdog: failed to persist alert state:', (e as Error).message);
  }
}

// Returns last-trigger time in epoch-ms, or null if the timer is inactive /
// has never fired / systemctl can't tell us.
// ── Check 3 (SANITY) helpers ──
type SanityState = {
  epoch: number;
  active_stake_sol: number;
  pools: Record<string, number>; // pool_address → gdi
};

function readSanityState(): SanityState | null {
  try {
    if (!existsSync(SANITY_STATE_FILE)) return null;
    return JSON.parse(readFileSync(SANITY_STATE_FILE, 'utf8')) as SanityState;
  } catch {
    return null;
  }
}

function writeSanityState(s: SanityState): void {
  try {
    writeFileSync(SANITY_STATE_FILE, JSON.stringify(s));
  } catch (e) {
    console.error('watchdog: failed to persist sanity state:', (e as Error).message);
  }
}

/**
 * Published-output sanity: compare the current leaderboard against the last
 * watchdog tick and scan per-pool files for floor-rarity blowups. Pushes
 * human-readable problems; never throws (a broken sanity check must not take
 * the heartbeat/freshness checks down with it).
 */
function runSanityChecks(problems: string[]): void {
  let lb: {
    epoch?: number;
    pools?: { pool_address: string; pool_name?: string; gdi?: number | null }[];
  };
  try {
    lb = JSON.parse(readFileSync(join(PUBLISHED_DIR, 'leaderboard-latest.json'), 'utf8'));
  } catch (e) {
    console.error('watchdog: sanity skipped (no leaderboard):', (e as Error).message);
    return;
  }
  if (lb.epoch == null || !Array.isArray(lb.pools)) return;

  // Active stake total from the published validator index (same artifact the
  // public sees, so we alert on what was actually published).
  let activeStakeSol = 0;
  try {
    const vj = JSON.parse(readFileSync(join(PUBLISHED_DIR, 'validators.json'), 'utf8')) as {
      validators?: { delinquent?: boolean; activated_stake_lamports?: string | null }[];
    };
    for (const v of vj.validators ?? []) {
      if (v.delinquent) continue;
      const lamports = v.activated_stake_lamports != null ? Number(v.activated_stake_lamports) : 0;
      if (Number.isFinite(lamports) && lamports > 0) activeStakeSol += lamports / 1e9;
    }
  } catch (e) {
    console.error('watchdog: sanity active-stake read failed:', (e as Error).message);
  }

  const prev = readSanityState();

  // 3a. Active-stake swing between ticks. Legitimate drift (rewards, normal
  // delegation flow) is well under this; a multi-million-SOL validator
  // dropping out of the active set is not.
  if (prev && prev.active_stake_sol > 0 && activeStakeSol > 0) {
    const pct = Math.abs(activeStakeSol - prev.active_stake_sol) / prev.active_stake_sol * 100;
    if (pct > STAKE_DELTA_PCT) {
      problems.push(
        `Active-set stake moved ${pct.toFixed(1)}% since the last watchdog tick ` +
        `(${Math.round(prev.active_stake_sol).toLocaleString()} → ${Math.round(activeStakeSol).toLocaleString()} SOL, ` +
        `threshold ${STAKE_DELTA_PCT}%). A large validator may have entered/left the active set ` +
        `(upstream delinquency blip?). Check the leaderboard before trusting current scores.`,
      );
    }
  }

  // 3b. Per-pool GDI jump within the same epoch. Scores legitimately step at
  // epoch boundaries; an intra-epoch jump this size means the inputs moved
  // under the pool, not the pool itself.
  if (prev && prev.epoch === lb.epoch) {
    for (const p of lb.pools) {
      const old = prev.pools[p.pool_address];
      if (old == null || old <= 0 || p.gdi == null || p.gdi <= 0) continue;
      const pct = Math.abs(p.gdi - old) / old * 100;
      if (pct > POOL_GDI_DELTA_PCT) {
        problems.push(
          `${p.pool_name ?? p.pool_address}: GDI moved ${pct.toFixed(0)}% within epoch ${lb.epoch} ` +
          `(${old.toFixed(3)} → ${p.gdi.toFixed(3)}, threshold ${POOL_GDI_DELTA_PCT}%).`,
        );
      }
    }
  }

  // 3c. Stake-weighted floor rarity in any published pool file. After
  // gdi-1.1.1 the scorer excludes missing-bucket validators, so any r_* this
  // high on real stake means something new is wrong.
  for (const p of lb.pools) {
    try {
      const detail = JSON.parse(
        readFileSync(join(PUBLISHED_DIR, 'pools', p.pool_address, 'latest.json'), 'utf8'),
      ) as { validators?: { stake_sol?: number; r_country?: number | null; r_city?: number | null; r_asn?: number | null }[] };
      for (const v of detail.validators ?? []) {
        if ((v.stake_sol ?? 0) < FLOOR_SCAN_MIN_SOL) continue;
        const worst = Math.max(v.r_country ?? 0, v.r_city ?? 0, v.r_asn ?? 0);
        if (worst > FLOOR_RARITY_MIN) {
          problems.push(
            `${p.pool_name ?? p.pool_address}: validator with ${Math.round(v.stake_sol!).toLocaleString()} SOL ` +
            `scored rarity ${worst.toFixed(1)} (> ${FLOOR_RARITY_MIN} ⇒ floor blowup; a bucket vanished from the denominator).`,
          );
          break; // one example per pool is enough for the alert
        }
      }
    } catch {
      // pool file missing/corrupt is the freshness check's territory
    }
  }

  // Update the baseline every tick so a one-off event alerts once and the
  // cooldown handles repeats; a persistent condition re-fires after cooldown.
  const pools: Record<string, number> = {};
  for (const p of lb.pools) if (p.gdi != null) pools[p.pool_address] = p.gdi;
  writeSanityState({ epoch: lb.epoch, active_stake_sol: activeStakeSol, pools });
}

async function getTimerLastTriggerMs(): Promise<number | null> {
  try {
    const { stdout } = await exec(
      '/usr/bin/systemctl',
      ['show', 'gdi-ingest.timer', '-p', 'LastTriggerUSec', '--value'],
      { timeout: 5_000 },
    );
    const raw = stdout.trim();
    // Empty / "0" / "n/a" → never fired
    if (!raw || raw === '0' || raw === 'n/a') return null;
    // systemd format: "Sun 2026-05-10 22:01:15 UTC"
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function main() {
  const now = Date.now();
  const problems: string[] = [];

  // ── Check 1: HEARTBEAT
  const lastFireMs = await getTimerLastTriggerMs();
  if (lastFireMs == null) {
    problems.push(
      `Timer not firing — systemctl could not report a LastTriggerUSec for gdi-ingest.timer.`,
    );
  } else {
    const ageMs = now - lastFireMs;
    const ageHr = ageMs / 3_600_000;
    if (ageHr > HEARTBEAT_HOURS) {
      problems.push(
        `Timer hasn't fired in ${fmtAge(ageMs)} (threshold ${HEARTBEAT_HOURS}h). ` +
        `Check: systemctl status gdi-ingest.timer`,
      );
    }
  }

  // ── Check 2: DATA FRESHNESS
  const storage = openStorage(process.env.SGDI_DB_PATH, { readonly: true });
  const recent = storage.listRecentRuns(20);
  storage.close();

  const lastSuccess = recent.find((r) => r.status === 'success' || r.status === 'partial');
  if (!lastSuccess) {
    problems.push(
      `No successful ingest found in the last ${recent.length} run records. ` +
      `Check: journalctl -u gdi-ingest --since '12 hours ago'`,
    );
  } else {
    const lastMs = (lastSuccess.finished_at ?? lastSuccess.started_at) * 1000;
    const ageMs = now - lastMs;
    const ageHr = ageMs / 3_600_000;
    if (ageHr > STALE_HOURS) {
      problems.push(
        `No successful ingest in ${fmtAge(ageMs)} (threshold ${STALE_HOURS}h — about one Solana epoch). ` +
        `Last success: epoch ${lastSuccess.epoch} at ${new Date(lastMs).toISOString()}. ` +
        `An epoch transition has probably been missed.`,
      );
    }
  }

  // ── Check 3: PUBLISHED-OUTPUT SANITY (never throws)
  runSanityChecks(problems);

  if (problems.length === 0) {
    const lastSuccessSummary = lastSuccess
      ? `last success epoch ${lastSuccess.epoch}, ${fmtAge(now - (lastSuccess.finished_at ?? lastSuccess.started_at) * 1000)} ago`
      : 'no success on record';
    const heartbeatSummary = lastFireMs
      ? `timer fired ${fmtAge(now - lastFireMs)} ago`
      : 'timer fire time unknown';
    console.log(`watchdog OK: ${heartbeatSummary}; ${lastSuccessSummary}`);
    return;
  }

  // ── Alert path — collapse multiple problems into one message
  const text = `⚠ Watchdog alert(s):\n\n${problems.map((p, i) => `${i + 1}. ${p}`).join('\n\n')}`;
  // Always mirror the problems to the journal: an alert that fails to send
  // (or is cooldown-suppressed) must still be diagnosable from logs.
  console.error(text);

  const last = readLastAlert();
  if (last && now - last.ts_ms < ALERT_COOLDOWN_H * 3_600_000) {
    console.log(
      `watchdog STALE but within cooldown (last alert ${fmtAge(now - last.ts_ms)} ago, ` +
      `cooldown ${ALERT_COOLDOWN_H}h) — suppressing.`,
    );
    return;
  }

  const result = await sendSgdiAlert(text);
  if (result.ok) {
    writeLastAlert(new Date(now));
    console.log(`watchdog alert sent (${problems.length} problem(s)).`);
  } else {
    console.error('watchdog alert failed to send:', result.reason, result.detail ?? '');
  }
}

main().catch((err) => {
  console.error('watchdog: unhandled error:', err.message ?? err);
  process.exit(1);
});
