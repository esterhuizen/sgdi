// SGDI staleness watchdog.
//
// Runs hourly via systemd timer. Two independent checks:
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
// Either check failing fires a Telegram alert. Repeat alerts within
// ALERT_COOLDOWN_H are suppressed so a sustained outage doesn't spam.
//
// State (last alert sent timestamp) is written to /var/lib/sgdi/watchdog.state.
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

const STATE_DIR  = process.env.SGDI_DATA_DIR ?? '/var/lib/sgdi';
const STATE_FILE = join(STATE_DIR, 'watchdog.state');

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
