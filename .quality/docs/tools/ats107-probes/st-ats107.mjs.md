# Technical Design: `tools/ats107-probes/st-ats107.mjs`

Source: `tools/ats107-probes/st-ats107.mjs`

Source-SHA256: `10298aebe9d00034b0801b68c780a4b051160fbe2eb6ff9e5e9708343c4098a8`

## Responsibility

The ATS-107 acceptance criterion is 「Chromium 上至少 1 PASS 1 FAIL；结果和错误信息与 CLI 一致」.

This probe is the thing that MEASURES it. It runs the ATS-107 fixture -- `examples/real-browser-fixture/` -- twice:

- **once directly through the Playwright CLI** (the engine's own verdict), and
- **once through the real Bridge** (`POST /api/projects/{id}/run`, i.e. the product's own path),

and then compares the two. The comparison IS the acceptance criterion:

> 「与 CLI 一致」 can only mean something if there is a CLI run to be consistent WITH.

The probe prints `PASS`/`FAIL` per check and `RESULT: <passed>/<total>`; it exits 0 only when every check passed.

## Why the comparison has to be against a SEPARATE CLI run

The obvious -- and wrong -- way to write this probe is to let the Bridge's own summary be the expected value. That would make the check tautological: the Bridge would be compared against itself, and a Bridge that reported "2 passed" for a run in which one case failed would still pass.

So the expected values come from TWO independent sources that must agree with each other AND with the Bridge:

1. the **direct CLI run** -- the engine's own report, read by the probe with the probe's own code, not the Bridge's parser;
2. the fixture's **`tests/expected.json`** -- the fixture's declared contract, committed as data.

If the three disagree, the probe fails. A reviewer can therefore not argue with the result by disagreeing with the Bridge: the CLI run is the arbiter.

## Dependencies

- Upstream: `server/index.mjs` (the real Bridge), `server/adapters/playwright.mjs` (the adapter under test), `examples/real-browser-fixture/` (the fixture), the npm registry (for `npm ci` only).
- Downstream: `tools/ats107-probes/collect-evidence.sh` (which runs it and records the log), `docs/31-REAL-BROWSER-FIXTURE.md`, `docs/evidence/ATS-107/`.

## Public Contract

```
node tools/ats107-probes/st-ats107.mjs <repo> <scratch-dir>
```

- `<repo>`: the repository root (the Bridge is started from it).
- `<scratch-dir>`: a writable directory for the data directory of the Bridge and for the copied fixture.
- Exit code 0 when every check passed, 1 otherwise.
- On stdout, one `PASS <id> -- <detail>` / `FAIL <id> -- <detail>` line per check, then `RESULT: <passed>/<total>`.

### The checks

| ID | What it asserts |
| --- | --- |
| ST-1 | the fixture installs from its committed lockfile (`npm ci`) and pins an exact `@playwright/test` version |
| ST-2 | the direct CLI run produced 1 expected + 1 unexpected, i.e. at least 1 PASS and 1 FAIL, on Chromium |
| ST-3 | the Bridge run finished, and its summary says 1 passed + 1 failed |
| ST-4 | the Bridge's per-case verdicts are IDENTICAL to the CLI's per-case verdicts |
| ST-5 | the Bridge's failing case carries the ENGINE's error message (the assertion text is in it) -- the Bridge neither drops nor rewrites it |
| ST-6 | the Bridge's verdicts match the fixture's `tests/expected.json` |
| ST-7 | the run folder holds the engine's `report.json` and a real `trace.zip` |
| ST-8 | the Bridge's counters agree with the CLI's counters (passed/failed/total) |

### The three sources of truth, and which one wins

| Source | What it provides | Can it be wrong? |
| --- | --- | --- |
| the direct CLI run | the engine's own verdicts, counters and error text | only if the engine is broken |
| the fixture's `expected.json` | the verdicts the fixture promises | only if the fixture was edited |
| the Bridge run | the product's own report | yes -- this is the thing under test |

A failure therefore says which of the three diverged, and the message names it.

## Design decisions

- **The Bridge runs on a free port.** The probe reserves one with `net` (the same trick as `tests/helpers/free-port.mjs`) and passes it via `ATS_PORT`, so the probe does not fight with a developer's running instance on the default port. The ATS-101 constraint (the Next UI hardcodes the default port) is irrelevant here: this probe drives the HTTP API, not the UI.

- **The fixture is COPIED into the scratch directory**, and the copy gets its own `node_modules` from `npm ci`. The Bridge must never run against the repository's own working tree: a run would write `test-results/` and `playwright-report/` into the source tree, and the run's `gitCommit` would then name a dirty tree.

- **The probe reads the CLI's report with its OWN walker**, not with the Bridge's `parseReport`. If the probe used the product's parser, a bug in that parser would hide itself: both sides would agree because they read the report the same (wrong) way. The probe therefore walks the raw JSON itself and compares the raw facts.

- **The error message comparison is a CONTAINMENT check, not an equality check.** The engine's error text contains ANSI escape sequences and a call log; the Bridge stores `r.error.message` verbatim, but a future product change (e.g. stripping ANSI) would break a strict equality. What the criterion actually requires is that the engine's own error text reaches the reader, so the probe checks that the **assertion text the engine reported is present** in the Bridge's copy. The probe additionally reports both strings' lengths and their ANSI-stripped forms, so a reviewer can see the difference.

- **A missing browser is a SKIP, not a PASS.** If the engine's browser is not installed, the probe says so and exits non-zero, and the collector records it as SKIPPED with the reason. The criterion is about a real browser; a machine without one has not met it.

- **The probe never mutates the repository.** Everything it writes goes to the scratch directory.

## Invariants

- The probe is read-only with respect to the repository (it only reads the fixture and starts the Bridge).
- The probe leaves no running process behind: the Bridge is killed in the `finally` block, and the process TREE is killed on Windows (`taskkill /T /F`), because the Bridge spawns the Playwright CLI as a child.
- Every check prints a line, so a failing check is always visible in the evidence log even when an earlier check threw.

## Change Notes

New in ATS-107.
