// DoubleZero serviceability program reader.
//
// Pulls the live list of validators registered with DoubleZero by hitting
// the DZ mainnet-beta ledger RPC directly (no CLI, no daemon, no keypair).
// The serviceability program stores one User account per (validator, DZ-device)
// registration; we decode the Solana validator identity pubkey out of each
// active User account and return the deduped set.
//
// Why this exists: validators.app's `is_dz` flag has been unreliable
// (collapsed software_client labels in early 2026, possibly is_dz too).
// The fees CSV from doublezerofoundation/fees lags ~14 days. DZDP pool
// delegation is real-time but covers only ~380 validators out of ~600 on DZ.
// The on-chain User account list is the same data the DZ Foundation uses
// to bill fees — authoritative, real-time, complete.
//
// Schema reference (borsh-encoded User account):
//   https://github.com/malbeclabs/doublezero/blob/main/smartcontract/programs/doublezero-serviceability/src/state/user.rs
//
//   account_type: u8                  // = 7 (User)
//   owner: Pubkey                     // 32
//   index: u128                       // 16
//   bump_seed: u8                     // 1
//   user_type: u8                     // 0..3
//   tenant_pk: Pubkey                 // 32
//   device_pk: Pubkey                 // 32
//   cyoa_type: u8                     // 1
//   client_ip: [u8;4]                 // 4
//   dz_ip: [u8;4]                     // 4
//   tunnel_id: u16                    // 2
//   tunnel_net: (ip:4 + prefix:1)     // 5
//   status: u8                        // 0..8
//   publishers: Vec<Pubkey>           // 4 + 32*n
//   subscribers: Vec<Pubkey>          // 4 + 32*n
//   validator_pubkey: Pubkey          // 32  ← the Solana identity pubkey
//   tunnel_endpoint: [u8;4]           // 4
//   tunnel_flags: u8                  // 1
//   bgp_status: u8                    // 1
//   last_bgp_up_at: u64               // 8
//   last_bgp_reported_at: u64         // 8
//
// Fixed-size prefix (account_type..status inclusive) = 132 bytes.

import type { ModuleLogger } from '../logger.ts';
import { base58Encode } from './rpc.ts';

/** Mainnet-beta DZ ledger RPC URL — value from malbeclabs/doublezero source
 *  (config/src/constants.rs). Shared token; override with DZ_LEDGER_RPC_URL
 *  if we ever get our own. */
const DEFAULT_RPC_URL =
  'https://doublezero-mainnet-beta.rpcpool.com/db336024-e7a8-46b1-80e5-352dd77060ab';

/** DZ serviceability program on mainnet-beta. */
export const DZ_SERVICEABILITY_PROGRAM_ID =
  'ser2VaTMAcYTaauMrTSfSrxBaUDq7BLNs2xfUugTAGv';

/** AccountType::User discriminant. */
const ACCOUNT_TYPE_USER = 7;

const USER_TYPE_STR = ['IBRL', 'IBRLWithAllocatedIP', 'EdgeFiltering', 'Multicast'] as const;
const USER_STATUS_STR = [
  'Pending', 'Activated', 'SuspendedDeprecated', 'Deleting',
  'Rejected', 'PendingBan', 'Banned', 'Updating', 'OutOfCredits',
] as const;

export type DzUserType = (typeof USER_TYPE_STR)[number];
export type DzUserStatus = (typeof USER_STATUS_STR)[number] | 'Unknown';

const BGP_STATUS_STR = ['Unknown', 'Up', 'Down'] as const;
export type DzBgpStatus = (typeof BGP_STATUS_STR)[number];

export type DzUser = {
  /** Solana validator identity pubkey (the field we actually want). */
  validator_pubkey: string;
  /** Owner of the User PDA — sometimes the validator identity, sometimes a
   *  separate service / fee-payer keypair. validator_pubkey is the reliable
   *  field for correlating against Solana. */
  owner: string;
  /** Pubkey of the DZ device this user attaches to. */
  device_pk: string;
  /** DZ tenant pubkey (often zero/blank). */
  tenant_pk: string;
  user_type: DzUserType;
  status: DzUserStatus;
  /** Last reported state of the BGP session between validator and DZ device.
   *  'Up' means the tunnel is currently working as of the last report. */
  bgp_status: DzBgpStatus;
  /** Solana slot number when BGP was last reported Up. 0 if never reported up. */
  last_bgp_up_at: number;
  /** Solana slot number when the device agent last reported any BGP state.
   *  Recent value = liveness; very stale value = stuck registration. */
  last_bgp_reported_at: number;
};

const ZERO_PUBKEY = '11111111111111111111111111111111';

function decodeUserAccount(data: Buffer): DzUser | null {
  if (data.length < 100 || data[0] !== ACCOUNT_TYPE_USER) return null;

  let off = 1;
  const owner = base58Encode(data.subarray(off, off + 32)); off += 32;
  off += 16;                                                 // index: u128
  off += 1;                                                  // bump_seed: u8
  const userTypeByte = data[off]; off += 1;
  const tenant_pk = base58Encode(data.subarray(off, off + 32)); off += 32;
  const device_pk = base58Encode(data.subarray(off, off + 32)); off += 32;
  off += 1;                                                  // cyoa_type
  off += 8;                                                  // client_ip + dz_ip
  off += 2;                                                  // tunnel_id
  off += 5;                                                  // tunnel_net
  const statusByte = data[off]; off += 1;

  // publishers: Vec<Pubkey> — u32 LE len, then 32*n
  if (off + 4 > data.length) return null;
  const pubLen = data.readUInt32LE(off); off += 4;
  if (pubLen > 1024) return null;                            // sanity
  off += pubLen * 32;

  // subscribers: Vec<Pubkey>
  if (off + 4 > data.length) return null;
  const subLen = data.readUInt32LE(off); off += 4;
  if (subLen > 1024) return null;
  off += subLen * 32;

  if (off + 32 > data.length) return null;
  const validator_pubkey = base58Encode(data.subarray(off, off + 32));
  off += 32;

  // tunnel_endpoint (4), tunnel_flags (1), bgp_status (1), last_bgp_up_at (u64),
  // last_bgp_reported_at (u64). Older records may lack these; default to safe
  // values if the buffer is shorter than expected.
  let bgpStatusByte = 0;
  let last_bgp_up_at = 0;
  let last_bgp_reported_at = 0;
  if (off + 4 + 1 + 1 + 8 + 8 <= data.length) {
    off += 4 + 1; // skip tunnel_endpoint + tunnel_flags
    bgpStatusByte = data[off]; off += 1;
    last_bgp_up_at       = Number(data.readBigUInt64LE(off)); off += 8;
    last_bgp_reported_at = Number(data.readBigUInt64LE(off));
  }

  return {
    validator_pubkey,
    owner,
    device_pk,
    tenant_pk,
    user_type: USER_TYPE_STR[userTypeByte] ?? 'IBRL',
    status: (USER_STATUS_STR[statusByte] ?? 'Unknown') as DzUserStatus,
    bgp_status: (BGP_STATUS_STR[bgpStatusByte] ?? 'Unknown') as DzBgpStatus,
    last_bgp_up_at,
    last_bgp_reported_at,
  };
}

export type DoubleZeroOptions = {
  rpcUrl?: string;
  programId?: string;
  timeoutMs?: number;
  logger?: ModuleLogger;
};

export function createDoubleZero(opts: DoubleZeroOptions = {}) {
  const rpcUrl = opts.rpcUrl ?? process.env.DZ_LEDGER_RPC_URL ?? DEFAULT_RPC_URL;
  const programId = opts.programId ?? DZ_SERVICEABILITY_PROGRAM_ID;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const logger = opts.logger;

  async function rawFetchUsers(): Promise<DzUser[]> {
    const startedAt = Date.now();
    let res: Response;
    try {
      res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getProgramAccounts',
          params: [
            programId,
            {
              encoding: 'base64',
              // Filter to AccountType::User (discriminant byte = 7). base58 of
              // the single byte 0x07 is '8'.
              filters: [{ memcmp: { offset: 0, bytes: '8' } }],
            },
          ],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      logger?.warn('dz.network_error', { detail });
      throw new Error(`DZ getProgramAccounts network: ${detail}`);
    }

    const dur = Date.now() - startedAt;

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger?.warn('dz.http_error', { status: res.status, duration_ms: dur });
      throw new Error(`DZ RPC HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const json = (await res.json()) as {
      result?: Array<{ pubkey: string; account: { data: [string, 'base64'] } }>;
      error?: { code: number; message: string };
    };
    if (json.error) {
      logger?.warn('dz.rpc_error', { code: json.error.code, message: json.error.message });
      throw new Error(`DZ RPC error: ${json.error.message}`);
    }
    const accounts = json.result ?? [];

    const users: DzUser[] = [];
    for (const a of accounts) {
      const data = Buffer.from(a.account.data[0], 'base64');
      const u = decodeUserAccount(data);
      if (u) users.push(u);
    }

    logger?.info('dz.fetched', {
      duration_ms: Date.now() - startedAt,
      raw_accounts: accounts.length,
      decoded_users: users.length,
    });
    return users;
  }

  return {
    /** All decoded User accounts (no filtering). Useful for diagnostics. */
    fetchAllUsers: rawFetchUsers,

    /**
     * Set of Solana validator identity pubkeys currently active on
     * DoubleZero. Filters out: non-Activated status, Multicast user type,
     * and zero-valued validator_pubkey entries (a few legacy records).
     */
    async fetchActiveValidatorIdentities(): Promise<Set<string>> {
      const users = await rawFetchUsers();
      const set = new Set<string>();
      for (const u of users) {
        if (u.user_type === 'Multicast') continue;
        if (u.status !== 'Activated') continue;
        if (u.validator_pubkey === ZERO_PUBKEY) continue;
        set.add(u.validator_pubkey);
      }
      return set;
    },
  };
}
