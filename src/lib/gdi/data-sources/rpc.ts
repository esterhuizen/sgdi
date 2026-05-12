// Helius RPC client + hand-decoded SPL stake-pool layout.
//
// We deliberately avoid @solana/web3.js (huge dep, lots of surface for our
// modest needs). Just JSON-RPC over fetch, and a small Buffer-slicing decoder
// for the two account types we care about: StakePool and ValidatorList.
//
// The standard SPL stake-pool program (SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy)
// is what most pools use, including most Sanctum LSTs (Sanctum's "infinity" /
// LST router is a higher layer; the underlying pools are standard SPL).
// Pools using Sanctum's custom programs (e.g. Single-Validator pools, multi-
// pools) need their own decoders — added when first encountered.
//
// Layout reference: https://github.com/solana-labs/solana-program-library/tree/master/stake-pool/program/src/state.rs
// The program is deployed and immutable on mainnet-beta; if offsets change
// it would be a new program-id, not silent layout drift.

import type { ModuleLogger } from '../logger.ts';

// ───────────────────────────────────────────────────────────────────────────
// Program IDs
// ───────────────────────────────────────────────────────────────────────────

// The "spl-stake-pool" family — programs that use the StakePool / ValidatorList
// account layout from solana-program-library/stake-pool. Multiple deployed
// programs use this layout (the canonical SPL one, plus a few Sanctum-deployed
// forks). Adding a program ID here is the only step needed if its layout matches.
export const SPL_STAKE_POOL_PROGRAM_ID = 'SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy';

// Sanctum's "Single-Validator Stake Pool" program — SPL fork, same layout.
export const SANCTUM_SVSP_PROGRAM_ID = 'SVSPxpvHdN29nkVg9rPapPNDddN5DipNLRUFhyjFThE';

// Sanctum's "Multi-validator SPL stake pool" program — SPL fork, same layout.
// Used by Definity and several other Sanctum-launched LSTs. Verified by
// successful round-trip decoding against Definity's pool on mainnet.
export const SANCTUM_MULTI_PROGRAM_ID = 'SPMBzsVUuoHA4Jm6KunbsotaahvVikZs1JyTW6iJvbn';

/** Maps a known program ID to a layout family. Add new families here. */
export const POOL_PROGRAM_FAMILIES: Record<string, 'spl-stake-pool'> = {
  [SPL_STAKE_POOL_PROGRAM_ID]:    'spl-stake-pool',
  [SANCTUM_SVSP_PROGRAM_ID]:      'spl-stake-pool',
  [SANCTUM_MULTI_PROGRAM_ID]:     'spl-stake-pool',
};

// ───────────────────────────────────────────────────────────────────────────
// JSON-RPC client
// ───────────────────────────────────────────────────────────────────────────

export type RpcOptions = {
  url: string;
  /** Per-call timeout. Default 30s. */
  timeoutMs?: number;
  logger?: ModuleLogger;
};

export class RpcError extends Error {
  readonly httpStatus: number | null;
  readonly rpcCode: number | null;
  constructor(message: string, httpStatus: number | null, rpcCode: number | null) {
    super(message);
    this.name = 'RpcError';
    this.httpStatus = httpStatus;
    this.rpcCode = rpcCode;
  }
}

export function createRpc({ url, timeoutMs = 30_000, logger }: RpcOptions) {
  let id = 0;

  async function singleCall<T>(method: string, params: unknown[]): Promise<T> {
    const reqId = ++id;
    const startedAt = Date.now();
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: reqId, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      logger?.warn('rpc.network_error', { method, detail });
      throw new RpcError(`RPC ${method} network: ${detail}`, null, null);
    }

    const dur = Date.now() - startedAt;

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger?.warn('rpc.http_error', { method, status: res.status, duration_ms: dur });
      throw new RpcError(
        `RPC ${method} HTTP ${res.status}: ${text.slice(0, 200)}`,
        res.status,
        null,
      );
    }

    const j = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (j.error) {
      // Helius returns HTTP 200 + JSON-RPC error code -32429 for rate-limit.
      // Surface the rate-limit code explicitly so the retry layer can detect it.
      logger?.warn('rpc.error', { method, code: j.error.code, message: j.error.message, duration_ms: dur });
      throw new RpcError(`RPC ${method}: ${j.error.message}`, res.status, j.error.code);
    }
    logger?.debug('rpc.ok', { method, duration_ms: dur });
    return j.result as T;
  }

  // Retry wrapper: backs off on 429 / -32429 (rate-limit) with exponential
  // delay (500ms, 1.5s, 4s) up to 3 retries, then gives up. Other errors
  // pass through unretried — fail fast on bad request shapes etc.
  async function call<T>(method: string, params: unknown[]): Promise<T> {
    const delays = [500, 1500, 4000];
    let lastError: unknown;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        return await singleCall<T>(method, params);
      } catch (e) {
        lastError = e;
        const isRateLimit =
          e instanceof RpcError && (e.httpStatus === 429 || e.rpcCode === -32429);
        if (!isRateLimit || attempt === delays.length) throw e;
        const wait = delays[attempt];
        logger?.warn('rpc.retry', { method, attempt: attempt + 1, wait_ms: wait });
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    throw lastError;
  }

  return {
    /** Raw JSON-RPC call (escape hatch for methods we haven't wrapped). */
    call,

    async getEpochInfo(): Promise<{
      epoch: number;
      slotIndex: number;
      slotsInEpoch: number;
      absoluteSlot: number;
      blockHeight: number;
      transactionCount?: number;
    }> {
      return call('getEpochInfo', []);
    },

    /** Returns null if the account doesn't exist; raw base64 buffer otherwise. */
    async getAccountInfoBase64(pubkey: string): Promise<Buffer | null> {
      const r = await call<{
        value: { data: [string, 'base64']; owner: string; lamports: number } | null;
      }>('getAccountInfo', [pubkey, { encoding: 'base64' }]);
      if (!r?.value?.data?.[0]) return null;
      return Buffer.from(r.value.data[0], 'base64');
    },

    /** Get an account's owning program id (cheap; avoids decoding). */
    async getAccountOwner(pubkey: string): Promise<string | null> {
      const r = await call<{
        value: { owner: string } | null;
      }>('getAccountInfo', [pubkey, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]);
      return r?.value?.owner ?? null;
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// base58 encode (no `bs58` dependency)
// ───────────────────────────────────────────────────────────────────────────

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes: Buffer | Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) {
    s = B58_ALPHABET[Number(n % 58n)] + s;
    n = n / 58n;
  }
  // Preserve leading zero bytes as leading '1' chars.
  for (const b of bytes) {
    if (b === 0) s = '1' + s;
    else break;
  }
  return s;
}

// ───────────────────────────────────────────────────────────────────────────
// SPL stake-pool layout decoders
//
// Source of truth:
//   solana-program-library/stake-pool/program/src/state.rs
// Account discriminator (first byte): 0=Uninitialized, 1=StakePool, 2=ValidatorList.
// ───────────────────────────────────────────────────────────────────────────

const ACCOUNT_TYPE = {
  UNINITIALIZED: 0,
  STAKE_POOL: 1,
  VALIDATOR_LIST: 2,
} as const;

export type StakePoolAccount = {
  validatorListAddress: string;
  totalLamports: bigint;
  poolTokenSupply: bigint;
  poolMint: string;
};

export function parseStakePoolAccount(buf: Buffer): StakePoolAccount {
  if (buf[0] !== ACCOUNT_TYPE.STAKE_POOL) {
    throw new Error(
      `Stake-pool account type byte = ${buf[0]} (expected ${ACCOUNT_TYPE.STAKE_POOL})`,
    );
  }
  // Offsets:
  //   account_type(1) + manager(32) + staker(32) + stake_deposit_authority(32)
  //   + stake_withdraw_bump_seed(1) + validator_list(32) + reserve_stake(32)
  //   + pool_mint(32) + manager_fee_account(32) + token_program_id(32)
  //   + total_lamports(u64) + pool_token_supply(u64)
  const validatorListBytes = buf.subarray(98, 130);
  const poolMintBytes      = buf.subarray(162, 194);
  const totalLamports      = buf.readBigUInt64LE(258);
  const poolTokenSupply    = buf.readBigUInt64LE(266);
  return {
    validatorListAddress: base58Encode(validatorListBytes),
    poolMint: base58Encode(poolMintBytes),
    totalLamports,
    poolTokenSupply,
  };
}

export type PoolValidatorEntry = {
  votePubkey: string;
  /** Currently-producing stake. Used for our snapshots. */
  activeStakeLamports: bigint;
  /** Stake in flight (activating or deactivating). Reported but not used for scoring. */
  transientStakeLamports: bigint;
  /** Status byte: 0=Active, 1=DeactivatingTransient, 2=ReadyForRemoval, etc. Reported as-is. */
  status: number;
};

export type ValidatorListAccount = {
  maxValidators: number;
  count: number;
  validators: PoolValidatorEntry[];
};

export function parseValidatorListAccount(buf: Buffer): ValidatorListAccount {
  if (buf[0] !== ACCOUNT_TYPE.VALIDATOR_LIST) {
    throw new Error(
      `Validator-list account type byte = ${buf[0]} (expected ${ACCOUNT_TYPE.VALIDATOR_LIST})`,
    );
  }
  // Header: account_type(1) + max_validators(u32) + count(u32) = 9 bytes.
  const maxValidators = buf.readUInt32LE(1);
  const count         = buf.readUInt32LE(5);
  if (count > maxValidators) {
    throw new Error(`validators_count (${count}) > max_validators (${maxValidators})`);
  }

  // Each ValidatorStakeInfo entry is 73 bytes:
  //   active_stake_lamports(u64)        offset 0..8
  //   transient_stake_lamports(u64)     offset 8..16
  //   last_update_epoch(u64)            offset 16..24
  //   transient_seed_suffix(u64)        offset 24..32
  //   unused(u32)                       offset 32..36
  //   validator_seed_suffix(u32)        offset 36..40
  //   status(u8)                        offset 40
  //   vote_account_address(32 bytes)    offset 41..73
  const HEADER_SIZE = 9;
  const ITEM_SIZE   = 73;

  const validators: PoolValidatorEntry[] = [];
  for (let i = 0; i < count; i++) {
    const start = HEADER_SIZE + i * ITEM_SIZE;
    validators.push({
      activeStakeLamports:    buf.readBigUInt64LE(start + 0),
      transientStakeLamports: buf.readBigUInt64LE(start + 8),
      status:                 buf.readUInt8(start + 40),
      votePubkey: base58Encode(buf.subarray(start + 41, start + 73)),
    });
  }

  return { maxValidators, count, validators };
}

// ───────────────────────────────────────────────────────────────────────────
// Composite: pool address → list of (validator, stake) tuples
// ───────────────────────────────────────────────────────────────────────────

export type PoolDelegation = {
  poolAddress: string;
  poolProgram: string;
  poolMint: string;
  totalLamports: bigint;
  /** One entry per validator with non-zero stake from the pool. Sorted by stake desc. */
  delegations: PoolValidatorEntry[];
  /** Validators returned by chain that had zero active+transient stake (excluded from `delegations`). */
  zeroStakeCount: number;
};

// ───────────────────────────────────────────────────────────────────────────
// Pool discovery — enumerate all StakePool accounts owned by known programs,
// rank by TVL.
// ───────────────────────────────────────────────────────────────────────────

export type DiscoveredPool = {
  address: string;
  program: string;
  poolMint: string;
  totalLamports: bigint;
};

/**
 * For each program in `programIds`, calls getProgramAccounts with a
 * discriminator filter (account_type byte == 1 → StakePool), decodes each
 * result with `parseStakePoolAccount`, then merges + sorts by TVL desc and
 * returns the top N.
 *
 * Failure handling is per-program and per-account: a single bad decode or a
 * single program 429 doesn't stop the rest. Returns an empty array only if
 * EVERY program call failed.
 */
export async function discoverTopStakePoolsByTvl(
  rpc: ReturnType<typeof createRpc>,
  programIds: readonly string[],
  topN: number,
  logger?: ModuleLogger,
): Promise<DiscoveredPool[]> {
  // memcmp filter: bytes=base58(0x01) → '2'. Restricts results to StakePool
  // accounts (skipping ValidatorList accounts owned by the same program).
  const ACCOUNT_TYPE_STAKE_POOL_B58 = '2';

  const all: DiscoveredPool[] = [];
  for (const programId of programIds) {
    try {
      const result = await rpc.call<
        Array<{ pubkey: string; account: { data: [string, 'base64']; owner: string } }>
      >('getProgramAccounts', [
        programId,
        {
          encoding: 'base64',
          filters: [{ memcmp: { offset: 0, bytes: ACCOUNT_TYPE_STAKE_POOL_B58 } }],
        },
      ]);
      let parsed = 0;
      let failed = 0;
      for (const acc of result) {
        try {
          const buf = Buffer.from(acc.account.data[0], 'base64');
          const pool = parseStakePoolAccount(buf);
          all.push({
            address: acc.pubkey,
            program: programId,
            poolMint: pool.poolMint,
            totalLamports: pool.totalLamports,
          });
          parsed++;
        } catch (e) {
          failed++;
          logger?.warn('pool.discover.parse_failed', {
            program: programId,
            address: acc.pubkey,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      logger?.info('pool.discover.program', {
        program: programId,
        returned: result.length,
        parsed,
        parse_failed: failed,
      });
    } catch (e) {
      logger?.warn('pool.discover.program_failed', {
        program: programId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  all.sort((a, b) => {
    const diff = b.totalLamports - a.totalLamports;
    return diff > 0n ? 1 : diff < 0n ? -1 : 0;
  });
  return all.slice(0, topN);
}

/**
 * Read a pool's current delegation set from chain.
 * - Verifies the pool is owned by a known SPL-stake-pool family program.
 * - Decodes the pool account → finds the validator-list account.
 * - Decodes the validator-list account → list of (validator, active stake).
 *
 * Throws if the pool isn't owned by a known family or any decode fails.
 */
export async function fetchPoolDelegations(
  rpc: ReturnType<typeof createRpc>,
  poolAddress: string,
): Promise<PoolDelegation> {
  const ownerProgram = await rpc.getAccountOwner(poolAddress);
  if (!ownerProgram) {
    throw new Error(`Pool ${poolAddress} not found on chain`);
  }
  const family = POOL_PROGRAM_FAMILIES[ownerProgram];
  if (!family) {
    throw new Error(
      `Pool ${poolAddress} owner ${ownerProgram} is not a known SPL-stake-pool family program`,
    );
  }

  const poolBuf = await rpc.getAccountInfoBase64(poolAddress);
  if (!poolBuf) throw new Error(`Pool ${poolAddress} account empty`);
  const pool = parseStakePoolAccount(poolBuf);

  const listBuf = await rpc.getAccountInfoBase64(pool.validatorListAddress);
  if (!listBuf) throw new Error(`Validator-list ${pool.validatorListAddress} account empty`);
  const list = parseValidatorListAccount(listBuf);

  const nonZero = list.validators.filter(
    (v) => v.activeStakeLamports + v.transientStakeLamports > 0n,
  );
  nonZero.sort((a, b) => {
    const diff = b.activeStakeLamports - a.activeStakeLamports;
    return diff > 0n ? 1 : diff < 0n ? -1 : 0;
  });

  return {
    poolAddress,
    poolProgram: ownerProgram,
    poolMint: pool.poolMint,
    totalLamports: pool.totalLamports,
    delegations: nonZero,
    zeroStakeCount: list.count - nonZero.length,
  };
}
