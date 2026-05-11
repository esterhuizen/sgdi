// Scenario / what-if CLI for SGDI.
//
// Loads a pool's current validator set + stake from SQLite, fetches Stakewiz
// for current network shares (the rarity reference), then either:
//   (default)    Show current allocation + scores
//   --set        Apply absolute stake overrides + reshow scores
//   --delta      Apply ±stake adjustments + reshow scores
//   --optimize   Find the stake reallocation that maximises GDI on the same
//                validator set (total stake conserved)
//
// All operations are over the pool's CURRENT validator set — the optimiser
// won't suggest adding new operators. Use --min-stake to set a per-validator
// floor (e.g. for operational minimums).

import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { openStorage } from '../src/lib/gdi/storage.ts';
import { rarityFromShare, computeNetworkShares } from '../src/lib/gdi/scoring.ts';
import { scoreAllocation, optimize, type RarityVector, type Scores } from '../src/lib/gdi/scenario.ts';
import { createStakewiz } from '../src/lib/gdi/data-sources/stakewiz.ts';
import type { ValidatorMetadata, PoolStakeRow } from '../src/lib/gdi/scoring.ts';

const WATCHLIST_PATH = resolve('./config/pools-watchlist.json');

type Args = {
  pool: string;
  epoch?: number;
  optimize: boolean;
  sets: Map<string, number>;     // pubkey → absolute SOL
  deltas: Map<string, number>;   // pubkey → ± SOL
  topN: number;
  minStake: number;              // per-validator floor in SOL
  maxStake: number | null;       // per-validator ceiling in SOL
  epochBudget: number | null;    // max SOL transferable in a single epoch
  maxMove: number | null;        // max DECREASE per validator per epoch (additions uncapped)
  json: boolean;
  help: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    pool: 'definity',
    optimize: false,
    sets: new Map(),
    deltas: new Map(),
    topN: 10,
    minStake: 0,
    maxStake: null,
    epochBudget: null,
    maxMove: null,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--pool') args.pool = next();
    else if (a === '--epoch') args.epoch = Number(next());
    else if (a === '--optimize') args.optimize = true;
    else if (a === '--top') args.topN = Number(next());
    else if (a === '--min-stake') args.minStake = Number(next());
    else if (a === '--max-stake') args.maxStake = Number(next());
    else if (a === '--epoch-budget') args.epochBudget = Number(next());
    else if (a === '--max-move') args.maxMove = Number(next());
    else if (a === '--json') args.json = true;
    else if (a === '--set' || a === '--delta') {
      const spec = next();
      const eq = spec.indexOf('=');
      if (eq < 0) throw new Error(`bad ${a} format (expected pubkey=sol): ${spec}`);
      const pubkey = spec.slice(0, eq);
      const amount = Number(spec.slice(eq + 1));
      if (!Number.isFinite(amount)) throw new Error(`bad amount in ${a}: ${spec}`);
      (a === '--set' ? args.sets : args.deltas).set(pubkey, amount);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  return args;
}

function help() {
  console.log(`
gdi-scenario — what-if and optimisation for a pool's GDI score

Usage:
  npm run scenario -- [options]

Options:
  --pool <name|address>      Pool to analyse (default: definity)
  --epoch <n>                Use a specific epoch (default: latest scored)
  --set <pubkey>=<sol>       Set validator's stake to <sol> SOL (repeatable)
  --delta <pubkey>=<±sol>    Adjust validator's stake by <±sol> SOL (repeatable)
  --optimize                 Find the stake reallocation maximising GDI
  --top <n>                  Top N moves/transfers to print (default: 10)
  --min-stake <sol>          Per-validator floor (default: 0)
  --max-stake <sol>          Per-validator ceiling (default: none)
  --epoch-budget <sol>       Single-step mode: max stake transferable in
                             one epoch. Switches output to "best single
                             transfer(s) you can do this epoch" instead
                             of the full optimisation plan.
  --max-move <sol>           Max stake that can be REMOVED from any single
                             validator per epoch. Additions are uncapped
                             (only constrained by --max-stake). Use to
                             give validators time to migrate before they
                             lose most of their stake.
  --json                     Emit JSON instead of human-readable text
  -h, --help                 This help

Examples:
  # Show current allocation + scores
  npm run scenario --

  # What-if: shift 5k SOL from validator A to validator B
  npm run scenario -- --delta A=-5000 --delta B=+5000

  # Find the GLOBAL optimal allocation (no per-epoch limit)
  npm run scenario -- --optimize --top 15

  # Best single transfer this epoch: ≤20k SOL move, per-validator [2k, 30k]
  npm run scenario -- --epoch-budget 20000 --min-stake 2000 --max-stake 30000
`);
}

function findPoolAddress(name: string): string {
  // Allow either a pool address or a name (case-insensitive lookup in watchlist).
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(name)) return name;
  const wl = JSON.parse(readFileSync(WATCHLIST_PATH, 'utf8')) as { additions: Array<{ pool_address: string; name?: string }> };
  const lower = name.toLowerCase();
  const match = wl.additions.find((p) => (p.name || '').toLowerCase() === lower);
  if (!match) throw new Error(`pool name "${name}" not found in watchlist; pass --pool <address> instead`);
  return match.pool_address;
}

function fmtSol(sol: number): string {
  if (Math.abs(sol) >= 1_000_000) return `${(sol / 1_000_000).toFixed(2)}M`;
  if (Math.abs(sol) >= 10_000) return `${(sol / 1_000).toFixed(0)}k`;
  if (Math.abs(sol) >= 1_000) return `${(sol / 1_000).toFixed(1)}k`;
  return sol.toFixed(0);
}

function fmtSigned(sol: number): string {
  const sign = sol > 0 ? '+' : sol < 0 ? '−' : ' ';
  return sign + fmtSol(Math.abs(sol));
}

function pct(after: number, before: number): string {
  if (!Number.isFinite(before) || before === 0) return '—';
  const d = ((after - before) / before) * 100;
  const sign = d > 0 ? '+' : '';
  return `${sign}${d.toFixed(2)}%`;
}

function printScores(label: string, s: Scores) {
  console.log(`  ${label.padEnd(12)}  GDI ${s.gdi.toFixed(3)}    DC_country ${s.dc_country.toFixed(3)}    DC_city ${s.dc_city.toFixed(3)}    DC_asn ${s.dc_asn.toFixed(3)}`);
}

function printScoresDelta(label: string, after: Scores, before: Scores) {
  console.log(
    `  ${label.padEnd(12)}  GDI ${after.gdi.toFixed(3)} (${pct(after.gdi, before.gdi)})` +
    `   DC_country ${after.dc_country.toFixed(3)} (${pct(after.dc_country, before.dc_country)})` +
    `   DC_city ${after.dc_city.toFixed(3)} (${pct(after.dc_city, before.dc_city)})` +
    `   DC_asn ${after.dc_asn.toFixed(3)} (${pct(after.dc_asn, before.dc_asn)})`,
  );
}

function truncAddr(s: string): string {
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { help(); return; }

  const poolAddress = findPoolAddress(args.pool);
  // Read-only: this tool never mutates the DB and may run as the invoking
  // user (typically without write perms on /var/lib/sgdi/gdi.db).
  const storage = openStorage(process.env.SGDI_DB_PATH, { readonly: true });

  // Pick epoch — default = latest with scores for this pool
  let epoch = args.epoch;
  if (epoch == null) {
    const scores = storage.listScoresForPool(poolAddress);
    if (scores.length === 0) throw new Error(`no scores found for pool ${poolAddress}`);
    epoch = scores[0].epoch;
  }

  // Pool's snapshots for that epoch + per-validator metadata
  const snaps = storage.listSnapshotsForPoolEpoch(epoch, poolAddress);
  if (snaps.length === 0) throw new Error(`no snapshots for pool ${poolAddress} at epoch ${epoch}`);

  type Row = {
    pubkey: string;
    name: string | null;
    stake: number;        // current SOL on this validator
    country: string | null;
    city: string | null;
    asn: string | null;
    asnName: string | null;
  };

  const rows: Row[] = [];
  for (const s of snaps) {
    const v = storage.getValidator(s.validator_pubkey);
    rows.push({
      pubkey: s.validator_pubkey,
      name: v?.identity_name ?? null,
      stake: Number(s.stake_lamports) / 1e9,
      country: v?.country ?? null,
      city: v?.city ?? null,
      asn: v?.asn ?? null,
      asnName: v?.asn_name ?? null,
    });
  }

  // Network shares — fetch fresh from Stakewiz so rarities reflect "now"
  process.stderr.write('  ↻ fetching Stakewiz for current network shares… ');
  const stakewiz = createStakewiz({});
  const sw = await stakewiz.fetchAllValidators();
  const swMeta = new Map<string, ValidatorMetadata>();
  const swRows: PoolStakeRow[] = [];
  for (const v of sw) {
    swMeta.set(v.vote_identity, {
      pubkey: v.vote_identity,
      country: v.ip_country,
      city: v.ip_city,
      asn: v.ip_asn != null ? String(v.ip_asn) : null,
      wizScore: v.wiz_score,
    });
    if (v.activated_stake != null && v.activated_stake > 0) {
      swRows.push({
        pubkey: v.vote_identity,
        stakeLamports: BigInt(Math.floor(v.activated_stake * 1e9)),
      });
    }
  }
  const networkShares = computeNetworkShares(swRows, swMeta);
  process.stderr.write(`done (${sw.length} validators)\n`);

  // Compute rarity vectors for THIS pool's validators
  // Validators with ANY missing dim are excluded — they'd skew the optimiser.
  const placeable: { row: Row; rarity: RarityVector }[] = [];
  const excluded: Row[] = [];
  for (const r of rows) {
    if (!r.country || !r.city || !r.asn) {
      excluded.push(r);
      continue;
    }
    placeable.push({
      row: r,
      rarity: {
        country: rarityFromShare(networkShares.country.get(r.country) ?? 0),
        city:    rarityFromShare(networkShares.city.get(r.city) ?? 0),
        asn:     rarityFromShare(networkShares.asn.get(r.asn) ?? 0),
      },
    });
  }

  const totalCurrent = placeable.reduce((sum, x) => sum + x.row.stake, 0);
  const currentStake = placeable.map((x) => x.row.stake);
  const rarities = placeable.map((x) => x.rarity);
  const currentScores = scoreAllocation(currentStake, rarities);

  // Apply --set / --delta to derive a what-if allocation (vs current)
  const haveOverrides = args.sets.size > 0 || args.deltas.size > 0;
  let whatIfStake: number[] | null = null;
  if (haveOverrides) {
    whatIfStake = currentStake.slice();
    const idxByPubkey = new Map(placeable.map((x, i) => [x.row.pubkey, i]));
    for (const [pk, sol] of args.sets) {
      const i = idxByPubkey.get(pk);
      if (i == null) throw new Error(`--set: validator ${pk} not in pool's placeable set`);
      whatIfStake[i] = Math.max(0, sol);
    }
    for (const [pk, sol] of args.deltas) {
      const i = idxByPubkey.get(pk);
      if (i == null) throw new Error(`--delta: validator ${pk} not in pool's placeable set`);
      whatIfStake[i] = Math.max(0, whatIfStake[i] + sol);
    }
  }

  // Header
  const poolName = (storage.getPool(poolAddress)?.pool_name) || args.pool;
  if (args.json) {
    // JSON output is simpler to parse downstream — emit everything raw
    const out: Record<string, unknown> = {
      pool: { address: poolAddress, name: poolName },
      epoch,
      placeable_validators: placeable.length,
      excluded_validators: excluded.length,
      total_stake_sol: totalCurrent,
      current_scores: currentScores,
    };
    if (whatIfStake) {
      out.what_if = {
        stake_sol_total: whatIfStake.reduce((a, b) => a + b, 0),
        scores: scoreAllocation(whatIfStake, rarities),
        changes: whatIfStake.map((s, i) => ({
          pubkey: placeable[i].row.pubkey,
          before_sol: currentStake[i],
          after_sol: s,
          delta_sol: s - currentStake[i],
        })).filter((c) => Math.abs(c.delta_sol) > 1e-6),
      };
    }
    if (args.optimize) {
      const minWeight = totalCurrent > 0 ? args.minStake / totalCurrent : 0;
      const maxWeight = args.maxStake != null && totalCurrent > 0 ? args.maxStake / totalCurrent : 1;
      const opt = optimize(rarities, { minWeight, maxWeight });
      const optStake = opt.weights.map((w) => w * totalCurrent);
      out.optimize = {
        scores: opt.scores,
        iters: opt.iters,
        converged: opt.converged,
        allocation: optStake.map((s, i) => ({
          pubkey: placeable[i].row.pubkey,
          before_sol: currentStake[i],
          after_sol: s,
          delta_sol: s - currentStake[i],
        })),
      };
    }
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  // Human-readable
  console.log('');
  console.log(`Pool: ${poolName}  (${truncAddr(poolAddress)})  · epoch ${epoch}`);
  console.log(`Validators: ${placeable.length} placeable${excluded.length > 0 ? ` (${excluded.length} excluded — missing geo)` : ''}`);
  console.log(`Total stake: ${fmtSol(totalCurrent)} SOL`);
  console.log('');
  console.log('Scores:');
  printScores('current', currentScores);

  if (whatIfStake) {
    const newTotal = whatIfStake.reduce((a, b) => a + b, 0);
    const newScores = scoreAllocation(whatIfStake, rarities);
    console.log('');
    console.log(`What-if applied: ${args.sets.size} set + ${args.deltas.size} delta`);
    console.log(`New total stake: ${fmtSol(newTotal)} SOL (${fmtSigned(newTotal - totalCurrent)} vs current)`);
    printScoresDelta('what-if', newScores, currentScores);

    const changes = whatIfStake
      .map((s, i) => ({
        idx: i,
        delta: s - currentStake[i],
        before: currentStake[i],
        after: s,
      }))
      .filter((c) => Math.abs(c.delta) > 1e-6)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    if (changes.length > 0) {
      console.log('');
      console.log('Changes (largest first):');
      for (const c of changes) {
        const r = placeable[c.idx].row;
        const tag = `${r.country}/${r.city}/${r.asn}${r.asnName ? ` (${r.asnName})` : ''}`;
        console.log(`  ${fmtSigned(c.delta).padStart(8)} SOL  ${truncAddr(r.pubkey)}  ${tag}   ${fmtSol(c.before)} → ${fmtSol(c.after)}`);
      }
    }
  }

  if (args.optimize) {
    // Convert per-validator floor/ceiling (SOL) to weight bounds for optimiser
    const minWeight = totalCurrent > 0 ? args.minStake / totalCurrent : 0;
    const maxWeight = args.maxStake != null && totalCurrent > 0 ? args.maxStake / totalCurrent : 1;
    if (args.maxStake != null && args.maxStake * placeable.length < totalCurrent - 1e-6) {
      throw new Error(`--max-stake ${args.maxStake} × ${placeable.length} validators = ${fmtSol(args.maxStake * placeable.length)} < total ${fmtSol(totalCurrent)} SOL — infeasible`);
    }
    if (args.maxStake != null && args.minStake > args.maxStake) {
      throw new Error(`--min-stake (${args.minStake}) > --max-stake (${args.maxStake})`);
    }
    const opt = optimize(rarities, { minWeight, maxWeight });
    const optStake = opt.weights.map((w) => w * totalCurrent);
    console.log('');
    console.log(`Optimised allocation (total stake preserved at ${fmtSol(totalCurrent)} SOL):`);
    printScoresDelta('optimised', opt.scores, currentScores);
    const constraints = [
      args.minStake > 0 ? `floor ${fmtSol(args.minStake)} SOL` : null,
      args.maxStake != null ? `ceiling ${fmtSol(args.maxStake)} SOL` : null,
    ].filter(Boolean).join(', ');
    console.log(`  ${opt.converged ? 'converged' : 'maxIters reached'} after ${opt.iters} iters` + (constraints ? `  · ${constraints}` : ''));

    type Move = { idx: number; delta: number; before: number; after: number };
    const moves: Move[] = optStake.map((s, i) => ({ idx: i, before: currentStake[i], after: s, delta: s - currentStake[i] }));
    const ups = moves.filter((m) => m.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, args.topN);
    const downs = moves.filter((m) => m.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, args.topN);

    const printMove = (m: Move) => {
      const r = placeable[m.idx].row;
      const tag = `${r.country}/${r.city}/${r.asn}${r.asnName ? ` (${r.asnName})` : ''}`;
      // Show the rarity vector too — explains *why* the optimiser likes/dislikes this validator
      const rv = placeable[m.idx].rarity;
      const rstr = `r=[${rv.country.toFixed(2)},${rv.city.toFixed(2)},${rv.asn.toFixed(2)}]`;
      const name = r.name ? r.name.padEnd(20) : truncAddr(r.pubkey).padEnd(20);
      console.log(`  ${fmtSigned(m.delta).padStart(8)} SOL  ${name}  ${tag.padEnd(40)} ${rstr}   ${fmtSol(m.before)} → ${fmtSol(m.after)}`);
    };

    console.log('');
    console.log(`Top ${ups.length} INCREASES (sorted by Δ SOL):`);
    ups.forEach(printMove);
    console.log('');
    console.log(`Top ${downs.length} DECREASES:`);
    downs.forEach(printMove);

    const fullDeleg = moves.filter((m) => m.before > 0 && m.after < Math.max(args.minStake, 1)).length;
    if (fullDeleg > 0 && args.minStake === 0) {
      console.log('');
      console.log(`Note: ${fullDeleg} validators recommended for full de-delegation. Pass --min-stake N to set a floor.`);
    }
  }

  // Single-epoch PLAN: greedy gradient-driven set of changes that spends the
  // movement budget on the highest-impact source/sink shifts. The result is
  // ONE plan (not alternatives) — a list of per-validator net deltas. We
  // then display the top-N changes from that plan by |Δ|.
  //
  // Greedy step: at the current trial allocation, compute ∂log(GDI)/∂w for
  // every validator. Move stake from the lowest-gradient validator with
  // headroom (current > floor) to the highest-gradient validator with
  // headroom (current < ceiling). Update, decrement budget, repeat.
  // Stops when budget exhausted, no improving pair exists, or the next
  // move would be below the dust threshold.
  if (args.epochBudget != null) {
    const floor = Math.max(0, args.minStake);
    const ceil = args.maxStake ?? Infinity;
    const budget = args.epochBudget;
    const maxMovePerVal = args.maxMove ?? Infinity; // per-validator decrease cap
    const DUST = 100; // SOL — below this, a stake-pool tx isn't worth submitting
    const n = placeable.length;

    const trial = currentStake.slice();
    // Per-validator "still removable" cap: bounded by both the floor and the
    // user's --max-move (giving each validator a chance to migrate before
    // losing more than maxMovePerVal of stake this epoch).
    const removableLeft = currentStake.map((s) =>
      Math.min(Math.max(0, s - floor), maxMovePerVal),
    );

    let budgetLeft = budget;
    let iters = 0;
    const MAX_ITERS = 200;

    while (budgetLeft > DUST && iters < MAX_ITERS) {
      iters++;
      const total = trial.reduce((a, b) => a + b, 0);
      if (total <= 0) break;

      // DC scores at trial allocation
      let dcc = 0, dcity = 0, dca = 0;
      for (let i = 0; i < n; i++) {
        const w = trial[i] / total;
        dcc   += w * rarities[i].country;
        dcity += w * rarities[i].city;
        dca   += w * rarities[i].asn;
      }
      if (dcc <= 0 || dcity <= 0 || dca <= 0) break;

      // Per-validator gradient of log(GDI) wrt w_i.
      // ("value per SOL" of adding stake to validator i.)
      let bestSink = -1, bestSinkGrad = -Infinity;
      let bestSource = -1, bestSourceGrad = Infinity;
      for (let i = 0; i < n; i++) {
        const grad = (rarities[i].country / dcc
                    + rarities[i].city    / dcity
                    + rarities[i].asn     / dca) / 3;
        const room_up   = ceil - trial[i];   // can ADD this much (uncapped by --max-move)
        const room_down = removableLeft[i];  // can REMOVE this much (floor + per-val cap)
        if (room_up   > DUST && grad > bestSinkGrad)   { bestSinkGrad = grad;   bestSink = i; }
        if (room_down > DUST && grad < bestSourceGrad) { bestSourceGrad = grad; bestSource = i; }
      }
      if (bestSink < 0 || bestSource < 0 || bestSink === bestSource) break;
      if (bestSinkGrad - bestSourceGrad <= 1e-9) break;

      const sourceCapacity = removableLeft[bestSource];
      const sinkCapacity   = ceil - trial[bestSink];
      const amount = Math.min(sourceCapacity, sinkCapacity, budgetLeft);
      if (amount < DUST) break;

      trial[bestSource]         -= amount;
      trial[bestSink]           += amount;
      removableLeft[bestSource] -= amount;
      budgetLeft                -= amount;
    }

    const moved = budget - budgetLeft;
    const newScores = scoreAllocation(trial, rarities);

    // Per-validator gradient at the CURRENT (pre-plan) allocation — used as
    // a tie-break so the displayed order reflects actual greedy priority:
    //   adds:    higher gradient first (most valuable destinations first)
    //   removes: lower gradient first  (most "drainable" first)
    // When multiple removes hit the same |Δ| under --max-move, this orders
    // them as the optimiser would have picked them.
    const startGrad: number[] = (() => {
      const c = currentScores;
      if (c.dc_country <= 0 || c.dc_city <= 0 || c.dc_asn <= 0) return rarities.map(() => 0);
      return rarities.map((r) =>
        (r.country / c.dc_country + r.city / c.dc_city + r.asn / c.dc_asn) / 3,
      );
    })();

    // Collapse into one row per validator with net Δ. Sort:
    //   1° |Δ| desc — biggest visible moves first
    //   2° sign-aware gradient priority — among ties, "what would the
    //      optimiser pick first?"
    type Change = { idx: number; before: number; after: number; delta: number; grad: number };
    const changes: Change[] = trial
      .map((after, idx) => ({
        idx,
        before: currentStake[idx],
        after,
        delta: after - currentStake[idx],
        grad: startGrad[idx],
      }))
      .filter((c) => Math.abs(c.delta) >= DUST)
      .sort((a, b) => {
        const absDiff = Math.abs(b.delta) - Math.abs(a.delta);
        if (Math.abs(absDiff) > 1e-9) return absDiff;
        // Tie on |Δ|. Among adds: highest grad first. Among removes: lowest grad first.
        // Mixed (add vs remove same |Δ|): put adds before removes so the destination is visible first.
        const aSignKey = a.delta > 0 ? -1e9 - a.grad : a.grad;
        const bSignKey = b.delta > 0 ? -1e9 - b.grad : b.grad;
        return aSignKey - bSignKey;
      });

    const displayChanges = changes.slice(0, Math.max(1, args.topN));
    const pctDelta = currentScores.gdi > 0
      ? ((newScores.gdi - currentScores.gdi) / currentScores.gdi) * 100
      : 0;

    const constraintLine = [
      `≤${fmtSol(budget)} SOL movement`,
      `per-validator floor ${fmtSol(floor)} SOL`,
      `ceiling ${args.maxStake ? fmtSol(args.maxStake) + ' SOL' : 'none'}`,
      args.maxMove != null ? `max-decrease ${fmtSol(args.maxMove)} SOL/validator` : null,
    ].filter(Boolean).join(', ');
    console.log('');
    console.log(`Single-epoch plan (${constraintLine}):`);
    console.log(
      `  ${fmtSol(moved)} SOL of ${fmtSol(budget)} budget used    GDI ${currentScores.gdi.toFixed(3)} → ${newScores.gdi.toFixed(3)}    (${pctDelta >= 0 ? '+' : ''}${pctDelta.toFixed(2)}%)`,
    );

    if (changes.length === 0) {
      console.log('  No feasible move under these constraints.');
    } else {
      console.log('');
      console.log(`  Top ${displayChanges.length} of ${changes.length} change${changes.length === 1 ? '' : 's'} (sorted by |Δ stake|):`);
      console.log('');
      for (const [rank, c] of displayChanges.entries()) {
        const r = placeable[c.idx].row;
        const tag = `${r.country}/${r.city}/${r.asn}`;
        const dir = c.delta > 0 ? 'TO   ' : 'FROM ';
        const sign = c.delta > 0 ? '+' : '−';
        const name = (r.name || truncAddr(r.pubkey)).padEnd(28);
        console.log(
          `   #${(rank + 1).toString().padStart(2)}  ${sign}${fmtSol(Math.abs(c.delta)).padStart(6)} SOL  ${dir} ${name}  ${truncAddr(r.pubkey)}  ${tag}`,
        );
        console.log(
          `                              ${fmtSol(c.before).padStart(6)} SOL  →  ${fmtSol(c.after)} SOL`,
        );
      }
      // Sanity: adds should equal removes (stake conserved within pool)
      const adds = changes.filter((c) => c.delta > 0).reduce((s, c) => s + c.delta, 0);
      const removes = changes.filter((c) => c.delta < 0).reduce((s, c) => s - c.delta, 0);
      console.log('');
      console.log(`  Σ adds = ${fmtSol(adds)} SOL    Σ removes = ${fmtSol(removes)} SOL    (must match — stake is conserved within the pool)`);
    }
  }

  console.log('');
}

main().catch((err) => {
  console.error('error:', err.message ?? err);
  process.exit(1);
});
