#!/usr/bin/env node
// refresh-pool-fees.mjs — pull per-pool fee structures from chain via splsp.
//
// Reads the current leaderboard, picks pools above SGDI_FEE_MIN_STAKE_SOL
// (default 100k), shells out to `splsp list` for each, parses the TOML-ish
// output, writes a structured JSON snapshot to:
//
//   $SGDI_PUBLISHED_DIR/pool-fees-latest.json       (pointer to current)
//   $SGDI_PUBLISHED_DIR/pool-fees-{epoch}.json      (frozen per-epoch)
//
// Both files are atomic-written (temp+rename). Old per-epoch files are
// never overwritten by a later epoch (write-once on epoch advance).
//
// splsp wants a Solana CLI config file with the RPC URL; we generate
// a minimal one at runtime using HELIUS_RPC_URL (or SOLANA_RPC_URL).
//
// Env required:
//   HELIUS_RPC_URL or SOLANA_RPC_URL    Solana RPC endpoint
//   SGDI_PUBLISHED_DIR                  default /var/lib/sgdi/published
//   SPLSP_BIN                           default /home/sol/.cargo/bin/splsp
//   SGDI_FEE_MIN_STAKE_SOL              default 100000

import { writeFile, rename, mkdtemp, rm, readFile, mkdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const SPLSP    = process.env.SPLSP_BIN ?? '/home/sol/.cargo/bin/splsp';
const PUB_DIR  = process.env.SGDI_PUBLISHED_DIR ?? '/var/lib/sgdi/published';
const MIN_STAKE = Number(process.env.SGDI_FEE_MIN_STAKE_SOL ?? '100000');
const RPC_URL = process.env.HELIUS_RPC_URL ?? process.env.SOLANA_RPC_URL;
if (!RPC_URL) { console.error('fatal: HELIUS_RPC_URL or SOLANA_RPC_URL not set'); process.exit(2); }

async function atomicWriteJson(path, obj) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  await rename(tmp, path);
}

async function fileExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

function runSplsp(configPath, addr) {
  return new Promise((resolve, reject) => {
    const child = spawn(SPLSP, ['-c', configPath, 'list', addr], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`splsp exited ${code}: ${err.slice(0, 400) || out.slice(0, 400)}`));
      resolve(out);
    });
  });
}

// Parse a single `[pool.<section>]` fee block. Returns null if missing.
function parseFee(body, section) {
  const re = new RegExp(`\\[pool\\.${section}\\]\\s*\\n(?:.*\\n)?(numerator|denominator) = (\\d+)\\s*\\n(numerator|denominator) = (\\d+)`);
  const m = body.match(re);
  if (!m) return null;
  const map = { [m[1]]: Number(m[2]), [m[3]]: Number(m[4]) };
  const num = map.numerator, den = map.denominator;
  return {
    numerator: num,
    denominator: den,
    pct: den === 0 ? 0 : (num / den) * 100,
  };
}

function parseListOutput(addr, leaderboardEntry, body) {
  const program = body.match(/^program\s*=\s*"([^"]+)"/m)?.[1] ?? null;
  const mint    = body.match(/^mint\s*=\s*"([^"]+)"/m)?.[1] ?? null;
  const manager = body.match(/^manager\s*=\s*"([^"]+)"/m)?.[1] ?? null;
  const sdrf    = body.match(/^stake-deposit-referral-fee\s*=\s*(\d+)/m)?.[1];
  const sodrf   = body.match(/^sol-deposit-referral-fee\s*=\s*(\d+)/m)?.[1];
  const cleanOpt = (s) => {
    if (s == null) return null;
    s = s.replace(/^"|"$/g, '').trim();
    return s === 'None' ? null : s;
  };
  const nextE = cleanOpt(body.match(/^next-epoch-fee\s*=\s*(.+)$/m)?.[1]);
  const nextSW = cleanOpt(body.match(/^next-stake-withdrawal-fee\s*=\s*(.+)$/m)?.[1]);
  const nextSolW = cleanOpt(body.match(/^next-sol-withdrawal-fee\s*=\s*(.+)$/m)?.[1]);

  return {
    pool_address: addr,
    pool_name: leaderboardEntry.pool_name ?? null,
    pool_token_mint: mint,
    pool_program: leaderboardEntry.pool_program ?? null,
    spl_pool_variant: program,
    manager,
    total_stake_sol: leaderboardEntry.total_stake_sol ?? 0,
    fees: {
      epoch:            parseFee(body, 'epoch-fee'),
      stake_deposit:    parseFee(body, 'stake-deposit-fee'),
      sol_deposit:      parseFee(body, 'sol-deposit-fee'),
      stake_withdrawal: parseFee(body, 'stake-withdrawal-fee'),
      sol_withdrawal:   parseFee(body, 'sol-withdrawal-fee'),
      stake_deposit_referral_pct: sdrf == null ? null : Number(sdrf),
      sol_deposit_referral_pct:   sodrf == null ? null : Number(sodrf),
    },
    pending_fee_changes: {
      next_epoch_fee: nextE,
      next_stake_withdrawal_fee: nextSW,
      next_sol_withdrawal_fee: nextSolW,
    },
  };
}

async function main() {
  const lbPath = join(PUB_DIR, 'leaderboard-latest.json');
  const lb = JSON.parse(await readFile(lbPath, 'utf8'));
  const epoch = lb.epoch;
  const eligible = (lb.pools ?? [])
    .filter((p) => (p.total_stake_sol ?? 0) >= MIN_STAKE)
    .sort((a, b) => (b.total_stake_sol ?? 0) - (a.total_stake_sol ?? 0));
  console.log(`epoch ${epoch}: ${eligible.length} pools above ${MIN_STAKE.toLocaleString()} SOL`);

  // Generate a minimal Solana CLI config in a temp dir (splsp wants a config
  // file path). We don't need a keypair since `list` is read-only.
  const tmpRoot = await mkdtemp(join(tmpdir(), 'sgdi-pool-fees-'));
  const configPath = join(tmpRoot, 'solana-cli-config.yml');
  await writeFile(configPath, [
    '---',
    `json_rpc_url: ${RPC_URL}`,
    'websocket_url: ""',
    'keypair_path: /dev/null',
    'commitment: confirmed',
    '',
  ].join('\n'), 'utf8');

  try {
    const pools = [];
    let failed = 0;
    for (const entry of eligible) {
      try {
        const out = await runSplsp(configPath, entry.pool_address);
        pools.push(parseListOutput(entry.pool_address, entry, out));
        process.stdout.write('.');
      } catch (e) {
        console.error(`\n  ✗ ${entry.pool_name ?? entry.pool_address}: ${e.message.slice(0, 200)}`);
        failed++;
      }
    }
    console.log(`\n  ${pools.length} ok, ${failed} failed`);

    const doc = {
      captured_at: new Date().toISOString(),
      epoch,
      source: 'splsp list (Sanctum SPL Stake Pool CLI) against mainnet',
      min_stake_filter_sol: MIN_STAKE,
      pool_count: pools.length,
      pools,
    };

    const perEpoch = join(PUB_DIR, `pool-fees-${epoch}.json`);
    if (await fileExists(perEpoch)) {
      // Write-once on epoch advance — already have a snapshot for this epoch.
      // The latest pointer still gets refreshed so consumers see today's data.
      console.log(`  per-epoch file already exists; not overwriting ${perEpoch}`);
    } else {
      await atomicWriteJson(perEpoch, doc);
      console.log(`  wrote ${perEpoch}`);
    }
    await atomicWriteJson(join(PUB_DIR, 'pool-fees-latest.json'), doc);
    console.log(`  wrote ${join(PUB_DIR, 'pool-fees-latest.json')}`);

    if (failed > 0) process.exit(1);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error('fatal:', e?.message ?? e); process.exit(1); });
