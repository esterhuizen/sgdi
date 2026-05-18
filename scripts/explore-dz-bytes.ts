// Diagnostic: dump the raw byte size distribution of User accounts so we can
// figure out whether they actually contain the BGP fields.

export {}; // make this a module so top-level await is allowed

const url = process.env.DZ_LEDGER_RPC_URL ?? 'https://doublezero-mainnet-beta.rpcpool.com/db336024-e7a8-46b1-80e5-352dd77060ab';
const programId = 'ser2VaTMAcYTaauMrTSfSrxBaUDq7BLNs2xfUugTAGv';

const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'getProgramAccounts',
    params: [programId, {
      encoding: 'base64',
      filters: [{ memcmp: { offset: 0, bytes: '8' } }],  // AccountType::User = 7
    }],
  }),
});
const j = await res.json() as { result: Array<{ pubkey: string; account: { data: [string, 'base64'] } }> };
const accounts = j.result;

// Byte length distribution
const sizes = new Map<number, number>();
for (const a of accounts) {
  const len = Buffer.from(a.account.data[0], 'base64').length;
  sizes.set(len, (sizes.get(len) ?? 0) + 1);
}
console.log(`Total accounts: ${accounts.length}`);
console.log('Byte-size distribution:');
for (const [size, count] of [...sizes.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  ${size} bytes: ${count}`);
}
console.log('');

// Schema-expected sizes:
//   132 fixed prefix
//   + 4 (pub vec len) + 32*pub
//   + 4 (sub vec len) + 32*sub
//   + 32 validator_pubkey
//   + 4 tunnel_endpoint
//   + 1 tunnel_flags
//   + 1 bgp_status
//   + 8 last_bgp_up_at
//   + 8 last_bgp_reported_at
//   = 226 (with 0 pubs, 0 subs) — newer struct WITH BGP fields
//   = 222 (with BGP but missing last_bgp fields? no that would be inconsistent)
// Older struct (pre-BGP):
//   132 + 4 + 4 + 32 = 172 (with 0 pubs, 0 subs) — pre-BGP, pre-tunnel_endpoint, pre-tunnel_flags
// Or maybe the BGP fields were added incrementally:
//   132 + 4 + 4 + 32 + 4 + 1 = 177 (tunnel_endpoint + tunnel_flags only)
//   132 + 4 + 4 + 32 + 4 + 1 + 1 = 178 (+ bgp_status)
//   132 + 4 + 4 + 32 + 4 + 1 + 1 + 8 + 8 = 194 (full)

// Dump first 250 bytes of a few accounts to inspect manually
console.log('=== sample raw bytes (first 3 accounts) ===');
for (const a of accounts.slice(0, 3)) {
  const data = Buffer.from(a.account.data[0], 'base64');
  console.log(`account ${a.pubkey.slice(0, 10)}…  size=${data.length}`);
  // Hex dump in 32-byte rows
  for (let off = 0; off < data.length; off += 32) {
    const slice = data.subarray(off, Math.min(off + 32, data.length));
    console.log(`  ${off.toString().padStart(3)}: ${slice.toString('hex')}`);
  }
  console.log('');
}
