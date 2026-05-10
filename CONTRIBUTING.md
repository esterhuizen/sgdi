# Contributing to SGDI

Thanks for your interest. SGDI is intentionally simple — small surface area, transparent methodology, no surprise dependencies. Contributions that preserve those properties are welcome.

## Filing issues

- **Score disagreement**: if a number on [sgdi.app](https://sgdi.app) doesn't match what you compute locally for the same epoch, that's the highest-priority kind of issue. Include the pool address, the epoch, your computed numbers, and the JSON from `public/gdi/leaderboard-<epoch>.json`.
- **Data source quirks**: if Stakewiz / Validators.app / Helius returns surprising data, the run log under `/var/lib/sgdi/logs/runs-YYYY-MM-DD.jsonl` should already capture it as a WARN. Quote the relevant lines.
- **Methodology objections**: open an issue, propose a concrete change, ideally with a back-test of how scores would shift on the last 30 epochs. See "Methodology version policy" below.

## Pull requests

- One change per PR. Small PRs land faster.
- Run the test suite (`npm test`) before submitting. The pure-function tests in `tests/scoring.test.ts` must pass; the e2e fixture in `tests/e2e/` must reproduce its known scores.
- For UI changes, include a screenshot.
- For methodology changes, see the next section.

## Methodology version policy

The metric definition is versioned under semver: the current version is in `MethodologyVersion` (search the repo) and on `/methodology`.

- **PATCH** (e.g. `1.0.0` → `1.0.1`): bug fixes that change historical numbers. The PR must include a list of affected epochs and the magnitude of the change. The methodology page transparently flags re-computed historical points.
- **MINOR** (e.g. `1.0.0` → `1.1.0`): adding a new sub-score, swapping a data source, or a meaningful change in trust ordering. Existing scores remain valid under their original version; the leaderboard shows mixed-version data with a clear note.
- **MAJOR** (e.g. `1.0.0` → `2.0.0`): substantive change to the scoring formula (e.g. swapping geometric mean for weighted average). MAJOR bumps require:
  - A written rationale in `docs/methodology-changelog.md`
  - A back-test on at least 30 prior epochs showing the rank shift
  - A community review window (open an issue with the proposal at least 14 days before merging)

Historical scores remain available under their original methodology version forever.

## Code style

- TypeScript everywhere on the app side. `.mjs` for the periodic scripts (so they can be `node`-run without a bundler).
- Synchronous SQLite via `better-sqlite3` is a feature, not a bug — embrace it. No async ceremony around DB access.
- The pure functions in `src/lib/gdi/scoring.ts` must remain pure. No I/O. Ever. This is the one place that can be reasoned about without the whole system; keep it that way.
- Match the existing minimal-dependency posture. New deps should be argued for in the PR description. We added `better-sqlite3`; everything else uses Node 22 built-ins.
- Idempotency is non-negotiable. Every script must be safe to re-run. Re-running for an already-ingested epoch is a no-op (logged, but no DB writes).

## Logging

Every pipeline log line is structured JSON: `{ ts, run_id, level, module, event, ...context }`. If you add new log events, document them — a future reviewer will want to grep for them.

## Releases

There are no published releases yet; the project is currently launching. Once stable, releases are tagged with the current methodology version (e.g. `v1.0.0`).

## Trademark / mission

The methodology is named neutrally on purpose: "Solana GDI" / "SGDI". The repository's stewardship may be transferred to a neutral party in the future. PRs that explicitly couple the project to one publisher (logos, brand voice, etc.) will be politely declined; the methodology page is the only place a publisher is named.

## Questions

Open an issue or DM `@realtielman` on Telegram. The fastest path to a merged PR is filing an issue first to align on direction.
