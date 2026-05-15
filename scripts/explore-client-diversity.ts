// scripts/explore-client-diversity.ts
//
// Read-only discovery: pull validator client labels from validators.app
// (`software_client` field), cross-check against the Jito flag, and print
// a summary. No DB writes, no published-JSON changes, no service touches.
//
// validators.app already maintains client labels per validator — they
// disambiguate things gossip can't (Frankendancer vs Firedancer, Agave
// vs Jito-Agave). So we use their classification rather than parsing
// version strings ourselves.
//
// Trust model: `jito` is on-chain-verifiable. `software_client` for
// non-Jito distinctions involves operator self-attestation. We use both,
// log disagreements, and document the trust model in /methodology.
//
// Run on the prod box:
//   sudo bash -c 'set -a; . /etc/default/sgdi.env; set +a;
//     sudo -u ubuntu --preserve-env=VALIDATORS_APP_TOKEN \
//       node --experimental-strip-types \
//       /home/ubuntu/build/sgdi/scripts/explore-client-diversity.ts'

const BASE_URL =
  process.env.VALIDATORS_APP_BASE_URL || 'https://www.validators.app/api/v1';

// We only need a subset of fields — declare them explicitly so unexpected
// shape changes upstream are caught at compile/type-check time.
type RawValidator = {
  account: string;            // node identity
  vote_account?: string | null;
  name?: string | null;
  active_stake?: number | null;
  delinquent?: boolean | null;
  software_client?: string | null;
  software_client_id?: number | null;
  software_version?: string | null;
  jito?: boolean | null;
};

async function main() {
  const token = process.env.VALIDATORS_APP_TOKEN ?? '';
  const url = `${BASE_URL}/validators/mainnet.json?per_page=9999`;
  console.log(`Fetching ${url} ${token ? '(with token)' : '(anonymous)'} ...`);
  const t0 = Date.now();
  const headers: Record<string, string> = { 'user-agent': 'sgdi-explore/0.1' };
  if (token) headers.Token = token;
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    process.exit(1);
  }
  const validators = (await res.json()) as RawValidator[];
  console.log(`Got ${validators.length} validators in ${Date.now() - t0}ms\n`);

  // ──── Active-only filter ────
  const active = validators.filter((v) => v.delinquent === false);
  const delinquent = validators.length - active.length;
  console.log(
    `Active: ${active.length}    Delinquent (excluded from stake share): ${delinquent}\n`,
  );

  // ──── Total stake — used for stake-weighted breakdown ────
  // validators.app reports `active_stake` in lamports — divide for SOL.
  const LAMPORTS_PER_SOL = 1_000_000_000;
  const toSol = (lamports: number) => lamports / LAMPORTS_PER_SOL;
  const totalStake = active.reduce((acc, v) => acc + toSol(v.active_stake ?? 0), 0);
  console.log(`Total active stake: ${totalStake.toLocaleString(undefined, { maximumFractionDigits: 0 })} SOL\n`);

  // ──── Helpers ────
  const fmtPct = (n: number, total: number) =>
    `${((n / total) * 100).toFixed(2)}%`.padStart(7);
  const fmtSol = (sol: number) => {
    if (sol >= 1e6) return `${(sol / 1e6).toFixed(2)}M`;
    if (sol >= 1e3) return `${(sol / 1e3).toFixed(0)}k`;
    return sol.toFixed(0);
  };

  // ──── Per-software_client breakdown (validator count + stake-weighted) ────
  type Agg = { validators: number; stake: number };
  const byClient = new Map<string, Agg>();
  for (const v of active) {
    const k = v.software_client ?? '<null>';
    const a = byClient.get(k) ?? { validators: 0, stake: 0 };
    a.validators += 1;
    a.stake += toSol(v.active_stake ?? 0);
    byClient.set(k, a);
  }

  console.log('=== Client breakdown (active validators only) ===\n');
  console.log(
    `  ${'client'.padEnd(25)}${'validators'.padStart(12)}${'val %'.padStart(9)}${'stake'.padStart(12)}${'stake %'.padStart(10)}`,
  );
  console.log('  ' + '-'.repeat(67));
  const ranked = [...byClient.entries()].sort((a, b) => b[1].stake - a[1].stake);
  for (const [client, a] of ranked) {
    const valPct = fmtPct(a.validators, active.length);
    const stakePct = fmtPct(a.stake, totalStake);
    console.log(
      `  ${client.padEnd(25)}${a.validators.toString().padStart(12)}${valPct}${fmtSol(a.stake).padStart(12)}${stakePct}`,
    );
  }

  // ──── Cross-check: software_client × jito flag ────
  // Catches mismatches like JitoLabs/AgaveBam with jito=false (probably bad data),
  // or Agave with jito=true (e.g. just running on Jito infra).
  console.log('\n=== software_client × jito flag (sanity check) ===\n');
  const xt = new Map<string, Agg>();
  for (const v of active) {
    const k = `${v.software_client ?? '<null>'} | jito=${v.jito === true}`;
    const a = xt.get(k) ?? { validators: 0, stake: 0 };
    a.validators += 1;
    a.stake += toSol(v.active_stake ?? 0);
    xt.set(k, a);
  }
  const rows = [...xt.entries()].sort((a, b) => b[1].validators - a[1].validators);
  for (const [key, a] of rows) {
    console.log(
      `  ${key.padEnd(42)}  ${a.validators.toString().padStart(5)}  ${fmtSol(a.stake).padStart(7)} SOL`,
    );
  }

  // ──── Distinct versions per client (sanity-check the labels) ────
  // If "Frankendancer" suddenly contained "3.1.13" we'd know something's wrong.
  console.log('\n=== Top version strings per software_client ===\n');
  const versionsPerClient = new Map<string, Map<string, number>>();
  for (const v of active) {
    const c = v.software_client ?? '<null>';
    if (!versionsPerClient.has(c)) versionsPerClient.set(c, new Map());
    const m = versionsPerClient.get(c)!;
    const ver = v.software_version ?? '<null>';
    m.set(ver, (m.get(ver) ?? 0) + 1);
  }
  for (const [client] of ranked) {
    const m = versionsPerClient.get(client)!;
    const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    console.log(`  ${client}:`);
    for (const [ver, n] of top) console.log(`    ${n.toString().padStart(4)}  ${ver}`);
  }

  // ──── Validators missing client info ────
  const missing = active.filter((v) => !v.software_client || v.software_client === 'Unknown');
  if (missing.length > 0) {
    console.log(`\n=== Validators with no/unknown client label: ${missing.length} ===`);
    const missStake = missing.reduce((a, v) => a + toSol(v.active_stake ?? 0), 0);
    console.log(`  total stake: ${fmtSol(missStake)} SOL (${fmtPct(missStake, totalStake)})`);
  }

  console.log('\nDone. No DB writes performed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
