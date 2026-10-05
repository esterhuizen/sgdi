// SGDI staleness + sanity watchdog.
//
// Runs hourly via systemd timer. Four independent check groups:
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
//      (b) no pool's GDI moved > POOL_GDI_DELTA_PCT within one epoch, once
//          that epoch is past its settle window (re-scores before then are
//          the ingest correcting a pre-crank photo, not a fault),
//      (c) no published pool carries stake-weighted floor-rarity values.
//      Catches upstream data blips (e.g. the 2026-06-10 transient Stakewiz
//      delinquency flag that briefly inflated BNSOL's GDI by +106%).
//
//   4. LIVE-GEO PASS — is the always-on geo tick (src/lib/gdi/geo-live.ts)
//      actually ticking, and not re-mapping the fleet wholesale? Its whole
//      purpose is freshness, so a silently-stalled pass is the one failure that
//      would leave consumers reading a frozen map while believing it live.
//      Skipped when SGDI_GEO_LIVE_ENABLED=false.
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
import { openStorage, type GeoLiveMetaRow, type IngestionRun } from '../src/lib/gdi/storage.ts';
import { settleWindowState } from '../src/lib/gdi/epoch-gate.ts';
import { sendSgdiAlert } from '../src/lib/gdi/telegram.ts';

const exec = promisify(execFile);

const HEARTBEAT_HOURS   = Number(process.env.SGDI_WATCHDOG_HEARTBEAT_HOURS ?? 2);
const STALE_HOURS       = Number(process.env.SGDI_WATCHDOG_STALE_HOURS ?? 60);
const ALERT_COOLDOWN_H  = Number(process.env.SGDI_WATCHDOG_COOLDOWN_HOURS ?? 6);
// Print what would be sent and touch nothing: no Telegram, no state write.
// Added 2026-10-05 after a manual test run fired a real alert AND wrote the
// cooldown state, which would have suppressed any genuine alert for the next
// six hours. A monitor you cannot rehearse safely is a monitor people stop
// rehearsing — and the cooldown makes a careless test actively dangerous.
const DRY_RUN = process.argv.includes('--dry-run') || process.env.SGDI_WATCHDOG_DRY_RUN === '1';

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

// ── Check 4 (LIVE GEO) thresholds ──
// The pass runs on every 15-min ingest tick, so 2h is ~8 missed ticks — the
// same order as the HEARTBEAT bound, and short enough that a stalled pass is
// caught long before an epoch's worth of stake decisions is priced off it.
const GEO_STALE_HOURS   = Number(process.env.SGDI_WATCHDOG_GEO_STALE_HOURS ?? 2);

// ── Check 5 (PUBLIC SITE) ──
// Checked through the public URL, not localhost, so Cloudflare and nginx are
// in the path too — a cached 404 at the edge is just as broken as one at the
// origin. Set to 'off' to disable.
const SITE_CHECK_URL = process.env.SGDI_WATCHDOG_SITE_URL ?? 'https://gdindex.app/';
const SITE_EXPECT    = process.env.SGDI_WATCHDOG_SITE_EXPECT ?? 'Decentralisation Index';
const SITE_TIMEOUT_MS = Number(process.env.SGDI_WATCHDOG_SITE_TIMEOUT_MS ?? 15_000);
// Promotions in the last hour, counted from validator_geo_events.
//
// Counting EVENTS rather than reading geo_live_meta.mass_change_pct is
// deliberate: that column is overwritten every 15 minutes and this watchdog
// runs hourly, so sampling it would miss roughly three of every four spikes —
// including most of the Wednesday-morning GeoLite2-refresh cluster this check
// exists to catch. The events table is a complete record over the window.
//
// There is no coverage check here. With the stamp gate in geo-live.ts, any
// geo_live_meta row that exists ALREADY cleared coverage — re-testing it would
// be dead code by construction.
const GEO_PROMOTE_ALERT_PER_HOUR = Number(process.env.SGDI_GEO_PROMOTE_ALERT_PER_HOUR ?? 10);

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
  // First tick that saw this epoch, in ms. Ages the settle window for check 3b
  // without needing chain access. Absent on state files written before this
  // field existed, and stays absent for the rest of that epoch — read as "long
  // ago", i.e. 3b armed, matching the old behaviour.
  epoch_first_seen_ms?: number;
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
  //
  // Exception: the settle window. gdi-ingest re-captures and re-scores the
  // current epoch until every pool has been photographed after its own update
  // crank (see epoch-gate.ts), and those re-scores move GDI legitimately —
  // that is the whole point of them. The window is bounded by
  // SETTLE_WINDOW_SECONDS, so 3b simply stands down for the first hours of an
  // epoch and is armed for the remaining ~40+. Suppressing on "the score was
  // recomputed since the last tick" instead would disarm the check entirely:
  // published GDI comes straight from the merged-geo publish (the served JSON this
  // watchdog reads — NOT the canonical pool_scores table), so it can ONLY move when
  // a recompute happened — the two conditions are the same event.
  //
  // settleWindowState only stamps epoch_first_seen_ms when the epoch CHANGES,
  // and reads an absent stamp (state file older than the field) as "armed" —
  // back-stamping it with `now` would blind the check for a full window on an
  // epoch that has in fact been running for two days. It ages the window off
  // the wall clock, while the ingest gate uses slot-derived epoch age; close
  // but deliberately not identical windows.
  const { firstSeenMs: epochFirstSeenMs, inSettleWindow } = settleWindowState({
    prevEpoch: prev?.epoch ?? null,
    currentEpoch: lb.epoch,
    prevFirstSeenMs: prev?.epoch_first_seen_ms,
    nowMs: Date.now(),
  });
  if (prev && prev.epoch === lb.epoch && !inSettleWindow) {
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
  writeSanityState({
    epoch: lb.epoch,
    active_stake_sol: activeStakeSol,
    pools,
    epoch_first_seen_ms: epochFirstSeenMs,
  });
}

type GeoLiveSnapshot = {
  meta: GeoLiveMetaRow | undefined;
  promotesLastHour: number;
};

type DbReads = {
  recent: IngestionRun[];
  geoLive: GeoLiveSnapshot | null;   // null when the live-geo pass is switched off
  error: string | null;
};

/**
 * Every DB read this script does, in one guarded place.
 *
 * The guard has to wrap the OPEN, not just the queries: openStorage prepares
 * every statement up front, so a database that predates any table this build
 * knows about — on a unit whose user cannot write, so the idempotent migration
 * never runs — throws from `openStorage` itself. Wrapping only the reads leaves
 * that throw uncaught, which is what this function was written to stop.
 *
 * Checks 1 (systemd heartbeat) and 3 (published-JSON sanity) touch no database
 * at all, so a failure here must not reach them: they are the checks that
 * matter most precisely when the box is unwell. On failure the caller alerts
 * about the unreadable DB and the live-geo group degrades to "never run",
 * which is the honest reading — we cannot show that the pass is healthy.
 */
function readDb(nowMs: number, geoLiveEnabled: boolean): DbReads {
  try {
    const storage = openStorage(process.env.SGDI_DB_PATH, { readonly: true });
    try {
      return {
        recent: storage.listRecentRuns(20),
        geoLive: geoLiveEnabled
          ? {
              meta: storage.getGeoLiveMeta(),
              promotesLastHour: storage.countGeoPromotesSince(Math.floor(nowMs / 1000) - 3600),
            }
          : null,
        error: null,
      };
    } finally {
      storage.close();
    }
  } catch (e) {
    const message = (e as Error).message;
    console.error('watchdog: database read failed:', message);
    return {
      recent: [],
      geoLive: geoLiveEnabled ? { meta: undefined, promotesLastHour: 0 } : null,
      error: message,
    };
  }
}

/**
 * Live-geo pass health, from the one-row geo_live_meta stamp plus the promotion
 * rate from the events log. Every number comes from the tick itself (never from
 * a publish or from this script's clock), so a stalled writer shows up as an
 * old `last_tick_at` rather than as a fresh-looking artifact.
 */
function runGeoLiveChecks(problems: string[], geo: GeoLiveSnapshot, nowMs: number): void {
  const { meta, promotesLastHour } = geo;
  if (!meta) {
    problems.push(
      `Live-geo pass has never run — no geo_live_meta row. ` +
      `Geo consumers are reading the frozen per-epoch capture only. ` +
      `Check: journalctl -u gdi-ingest --since '2 hours ago' | grep geo.live`,
    );
    return;
  }

  const ageMs = nowMs - meta.last_tick_at * 1000;
  if (ageMs > GEO_STALE_HOURS * 3_600_000) {
    problems.push(
      `Live geo stale — last tick ${fmtAge(ageMs)} ago (threshold ${GEO_STALE_HOURS}h). ` +
      `The pass runs on every ingest tick, so this means ingest is failing, the pass ` +
      `is erroring out, or its ticks are failing the stamp gate ` +
      `(grep geo.live.failed / geo.live.skipped / geo.live.no_coverage).`,
    );
  }

  if (promotesLastHour >= GEO_PROMOTE_ALERT_PER_HOUR) {
    problems.push(
      `Live geo promoted ${promotesLastHour} validators in the last hour ` +
      `(threshold ${GEO_PROMOTE_ALERT_PER_HOUR}). The fleet does not relocate together — ` +
      `suspect a GeoLite2 refresh (city .mmdb mtime ` +
      `${meta.city_mmdb_mtime_ms != null ? new Date(meta.city_mmdb_mtime_ms).toISOString() : 'unknown'}). ` +
      `Inspect: SELECT * FROM validator_geo_events WHERE kind='promote' ORDER BY at DESC LIMIT 20;`,
    );
  }
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

/**
 * Check 5: DOES THE PUBLIC SITE ACTUALLY RENDER?
 *
 * Every other check in this file asks whether the DATA is fresh. None of them
 * asks whether anyone can see it. On 2026-08-31 a deploy left gdindex.app
 * serving Next's "404: This page could not be found." and it stayed that way
 * for five weeks — through every X post that cited gdindex.app as the source —
 * while this watchdog reported healthy the entire time, because the ingest was
 * fine. The data was never the problem.
 *
 * It is also why the status code is not the test. That 404 was served under an
 * HTTP 200: Next had cached a not-found page as the body, so any uptime monitor
 * watching status codes would have agreed nothing was wrong. We assert on
 * CONTENT, and we assert both directions — the marker we expect present, and
 * the 404 text we expect absent — because an empty 200 is its own failure.
 *
 * Never throws: a broken check must not take the rest of the watchdog with it.
 */
async function runSiteChecks(problems: string[]): Promise<void> {
  if (SITE_CHECK_URL === 'off') return;
  let body: string;
  try {
    const res = await fetch(SITE_CHECK_URL, {
      headers: { 'user-agent': 'gdi-watchdog' },
      signal: AbortSignal.timeout(SITE_TIMEOUT_MS),
      cache: 'no-store',
    });
    body = await res.text();
    if (!res.ok) {
      problems.push(
        `Public site ${SITE_CHECK_URL} returned HTTP ${res.status}. ` +
        `Check: systemctl status sgdi; curl -sI ${SITE_CHECK_URL}`,
      );
      return;
    }
  } catch (e) {
    problems.push(
      `Public site ${SITE_CHECK_URL} is unreachable: ${(e as Error).message}. ` +
      `Check: systemctl status sgdi nginx`,
    );
    return;
  }

  // Match the TITLE, not the body. Every healthy Next page embeds the
  // not-found component in its RSC flight payload, so the literal string
  // "404: This page could not be found." appears in perfectly good HTML —
  // a body-wide grep alerts hourly on a healthy site, which is worse than
  // no alert at all. The rendered <title> is what actually differs.
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.trim() ?? '';
  if (/^404\b|could not be found/i.test(title)) {
    problems.push(
      `Public site ${SITE_CHECK_URL} is serving a 404 PAGE UNDER HTTP 200. ` +
      `This is the 2026-08-31 failure: the build bakes empty ISR pages, deploy deletes them, ` +
      `and whatever the first request after restart renders gets cached permanently — ` +
      `revalidate never replaces a cached not-found. ` +
      `Fix: redeploy (sudo -u definity bash deploy/deploy.sh), which now smoke-tests and rolls back.`,
    );
    return;
  }

  // Assert on the title too: SITE_EXPECT appears in the flight payload of most
  // pages on this site, so checking the body alone would pass a wrong page.
  if (!title.includes(SITE_EXPECT)) {
    problems.push(
      `Public site ${SITE_CHECK_URL} rendered ${body.length} bytes with title ${JSON.stringify(title.slice(0, 80))}, ` +
      `which does not contain ${JSON.stringify(SITE_EXPECT)}. The page is up but may be rendering the wrong thing.`,
    );
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

  // ── Checks 2 + 4 read the DB — one guarded open, one close (see readDb).
  const geoLiveEnabled = process.env.SGDI_GEO_LIVE_ENABLED !== 'false';
  const { recent, geoLive, error: dbError } = readDb(now, geoLiveEnabled);
  if (dbError) {
    problems.push(
      `Could not read the GDI database at ${process.env.SGDI_DB_PATH ?? '(default path)'}: ${dbError}. ` +
      `Freshness and live-geo checks are blind this tick; the heartbeat and published-output ` +
      `checks below still ran. Check the file's existence, ownership and the unit's User=.`,
    );
  }

  // ── Check 2: DATA FRESHNESS
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

  // ── Check 4: LIVE-GEO PASS (skipped when the pass is switched off)
  if (geoLive) runGeoLiveChecks(problems, geoLive, now);

  // ── Check 5: PUBLIC SITE RENDERS (content, not status code)
  await runSiteChecks(problems);

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
  if (DRY_RUN) {
    console.log(`[dry-run] would alert with ${problems.length} problem(s); no Telegram sent, no state written.`);
    return;
  }
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
