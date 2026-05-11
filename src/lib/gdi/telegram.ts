// Minimal Telegram sender for SGDI operational alerts.
//
// Used by:
//   - scripts/gdi-ingest.ts    on run.status === 'failed'
//   - scripts/gdi-watchdog.ts  when last successful ingest is too stale
//
// Why curl-via-execFile rather than native fetch: on the AWS host this
// service runs on, Node's TLS specifically fails to api.telegram.org —
// the kernel RSTs ~25µs after SYN-ACK, before TLS can start. curl over
// the same socket works fine; same Node binary reaches Helius / Stakewiz
// / Anthropic without issue. Documented in definity-website/src/lib/telegram.ts.
//
// Env at runtime (loaded via systemd EnvironmentFile=-/etc/default/sgdi.env):
//   TELEGRAM_BOT_TOKEN   bot token from @BotFather
//   TELEGRAM_CHAT_ID     numeric chat id (positive=user, negative=group)
//
// If either is missing, returns { ok: false, reason: 'not_configured' }
// and callers are expected to skip silently. Never throws.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export type TelegramResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'not_configured' | 'http_error' | 'network_error' | 'timeout';
      detail?: string;
    };

const TELEGRAM_MAX = 4096;
const PREFIX = '🟧 [GDI] ';

/**
 * Send a plain-text message to the configured chat. Best-effort, never throws.
 * Caller passes the raw body; this function prefixes it with [GDI] so the
 * alert is visually distinguishable from definity.finance ops messages.
 */
export async function sendSgdiAlert(text: string): Promise<TelegramResult> {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { ok: false, reason: 'not_configured' };

  // Trim/truncate to Telegram's 4096 limit. Practically all our alerts are <500.
  const body = JSON.stringify({
    chat_id: chatId,
    text: (PREFIX + text).slice(0, TELEGRAM_MAX),
    disable_web_page_preview: true,
  });

  let stdout: string;
  try {
    const r = await exec(
      '/usr/bin/curl',
      [
        '-sS',
        '-X', 'POST',
        '-H', 'Content-Type: application/json',
        '--max-time', '10',
        '-w', '\n%{http_code}',
        '-d', body,
        `https://api.telegram.org/bot${token}/sendMessage`,
      ],
      { maxBuffer: 1024 * 1024, timeout: 12_000 },
    );
    stdout = r.stdout;
  } catch (e) {
    const err = e as { killed?: boolean; signal?: string; message?: string };
    if (err.killed && err.signal === 'SIGTERM') return { ok: false, reason: 'timeout' };
    return { ok: false, reason: 'network_error', detail: err.message || String(e) };
  }

  const lastNewline = stdout.lastIndexOf('\n');
  const httpCode = stdout.slice(lastNewline + 1).trim();
  const respBody = lastNewline >= 0 ? stdout.slice(0, lastNewline) : '';
  if (httpCode !== '200') {
    return { ok: false, reason: 'http_error', detail: `${httpCode} ${respBody.slice(0, 300)}` };
  }
  return { ok: true };
}
