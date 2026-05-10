// Structured JSONL run logger.
//
// Every line is a single JSON object with a stable shape:
//   { ts, run_id, level, module, event, ...context }
//
// Daily files at SGDI_LOG_DIR/runs-YYYY-MM-DD.jsonl. A future operator can
// reconstruct exactly what one ingest run did with:
//
//   jq -c 'select(.run_id == "abc-123")' var/logs/runs-2026-05-10.jsonl
//
// Synchronous appendFileSync is intentional. The pipeline is sync end-to-end
// (better-sqlite3 + serial ingest), so async logging would add ceremony for
// no benefit. Throughput is hundreds of lines per minute at most.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LEVEL_RANK: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

export type LogContext = Record<string, unknown>;

export type Logger = {
  /** UUID identifying this run; same across every log line in a single ingest. */
  readonly runId: string;
  /** Module-bound child logger; keeps `module` field stable per call site. */
  forModule(module: string): ModuleLogger;
};

export type ModuleLogger = {
  readonly runId: string;
  readonly module: string;
  debug(event: string, ctx?: LogContext): void;
  info(event: string, ctx?: LogContext): void;
  warn(event: string, ctx?: LogContext): void;
  error(event: string, ctx?: LogContext): void;
};

const ENV_LEVEL: LogLevel = (process.env.SGDI_LOG_LEVEL as LogLevel) || 'INFO';
const LOG_DIR = process.env.SGDI_LOG_DIR || './var/logs';
const CONSOLE_MIRROR =
  process.env.SGDI_LOG_CONSOLE === '1' || process.env.NODE_ENV !== 'production';

function dailyFilePath(): string {
  const today = new Date().toISOString().slice(0, 10);
  return join(LOG_DIR, `runs-${today}.jsonl`);
}

let logDirEnsured = false;
function ensureLogDir(): void {
  if (logDirEnsured) return;
  mkdirSync(LOG_DIR, { recursive: true });
  logDirEnsured = true;
}

function write(line: object): void {
  ensureLogDir();
  const path = dailyFilePath();
  // Ensure the per-day file's parent dir exists too (in case LOG_DIR has slashes).
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(line) + '\n', 'utf8');
}

function emit(
  level: LogLevel,
  runId: string,
  module: string,
  event: string,
  ctx?: LogContext,
): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[ENV_LEVEL]) return;
  const line = {
    ts: new Date().toISOString(),
    run_id: runId,
    level,
    module,
    event,
    ...(ctx || {}),
  };
  write(line);
  if (CONSOLE_MIRROR && LEVEL_RANK[level] >= LEVEL_RANK.INFO) {
    const tag = `[${level}] ${module} ${event}`;
    if (level === 'ERROR' || level === 'WARN') console.error(tag, ctx || '');
    else console.log(tag, ctx || '');
  }
}

export function createLogger(runId?: string): Logger {
  const id = runId || randomUUID();
  return {
    runId: id,
    forModule(module: string): ModuleLogger {
      return {
        runId: id,
        module,
        debug: (event, ctx) => emit('DEBUG', id, module, event, ctx),
        info:  (event, ctx) => emit('INFO',  id, module, event, ctx),
        warn:  (event, ctx) => emit('WARN',  id, module, event, ctx),
        error: (event, ctx) => emit('ERROR', id, module, event, ctx),
      };
    },
  };
}

/** Convenience: a one-off logger for ad-hoc scripts that aren't a "run". */
export function adhocLogger(label: string): ModuleLogger {
  return createLogger(`adhoc-${label}-${Date.now()}`).forModule(label);
}
