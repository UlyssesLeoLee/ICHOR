# Test Design: `server/index.mjs`

Source: `server/index.mjs`

Source-SHA256: `e6ff1240012934ef2e162b4ff6b3bb13d9e2e11bc89b3cc58bd35946c1683e32`

## Test Strategy

**Integration tests.** `tests/instance-lock-it.test.mjs` starts real `node server/index.mjs` processes.
- Each process gets its own `ATS_DATA_DIR` under a `mkdtemp` directory and its own port from `freePort()`. No port literal is used.
- Readiness is `GET /api/health` returning 200.
- A refusal is the process exiting by itself with code 1, plus the stderr text.
- A hard kill is `SIGKILL` on POSIX and `taskkill /PID <pid> /T /F` on Windows. Both leave the lock file behind, exactly as a crash does.
- The holder-check tests set `ATS_LOCK_VERIFY_MS=100`, so a tick happens within the test's time budget.

**System test.** `tools/ats207-probes/st-ats207.mjs` runs the same guard end to end with a real Playwright run. It is executed separately, and its output is the ST evidence.

Process-level IT in `tests/preflight-it.test.mjs`: a real Bridge (`node server/index.mjs`) on a free port with an isolated `ATS_DATA_DIR`, projects built from test-double CLIs whose `cli.js` writes a marker file when executed, so the test proves whether the engine was spawned.

## Test Cases

| Case ID | Input / Setup | Expected Outcome | Test Location |
| --- | --- | --- | --- |
| TC-001 | IT-LOCK-001: Bridge A up; Bridge B on another port, same data dir | B exits 1 by itself; stderr contains `holds the data directory lock`, the lock path, A's pid, `no Bridge is running` before `delete the lock file`; A still answers health; the lock file bytes are unchanged | `tests/instance-lock-it.test.mjs` |
| TC-002 | IT-LOCK-002: two Bridges spawned in the same tick on a fresh data dir, 3 rounds | each round exactly one serves health and the other exits 1; the lock names the serving pid | `tests/instance-lock-it.test.mjs` |
| TC-003 | IT-LOCK-003: Bridge A with a run in flight (fake CLI that never exits) is hard-killed; Bridge C started on the same data dir | C takes over the stale lock (lock pid = C) and serves; the run is `interrupted`, not passed; replay agrees | `tests/instance-lock-it.test.mjs` |
| TC-004 | IT-LOCK-004: Bridge A up; Bridge B with `ATS_LOCK_WAIT_MS=20000`; A is hard-killed 1.5 s later | B is still waiting while A lives, then starts and serves; the lock names B | `tests/instance-lock-it.test.mjs` |
| TC-005 | IT-LOCK-005: Bridge A up with `ATS_LOCK_VERIFY_MS=100`; the lock file is overwritten with a live foreign record (the test process's pid, start time and token) | A exits 1 by itself; stderr contains `lost the data directory lock`; the foreign lock is not removed by A's exit handler | `tests/instance-lock-it.test.mjs` |
| TC-006 | IT-LOCK-006: Bridge A up with `ATS_LOCK_VERIFY_MS=100`; the lock file is deleted | the file reappears with A's pid; stderr reports `re-acquired`; A still serves | `tests/instance-lock-it.test.mjs` |
| TC-007 | IT-DATA-001: `state.json` is non-JSON; a second data dir has a zero-length `state.json` | the Bridge exits 1; stderr names `STATE_CORRUPT`, the file and the recovery steps; the file bytes are unchanged; no lock file remains | `tests/instance-lock-it.test.mjs` |
| TC-008 | IT-DATA-002: a child process loops `saveState` (growing generations); it is hard-killed 12 times at staggered moments; then a Bridge starts | after every kill `state.json` parses and holds one complete generation; the Bridge starts, removes the leftover temp files, keeps the projects | `tests/instance-lock-it.test.mjs` |
| TC-009 | IT-WAL-001: a child commits 50 rows with auto-checkpoint off, opens `BEGIN IMMEDIATE`, inserts 50 more, prints `IN-TX`; it is hard-killed on that line | before reopening the `-wal` file is non-empty; after reopening `integrity_check` = ok, the 50 committed rows are present, the 50 uncommitted rows are absent | `tests/instance-lock-it.test.mjs` |
| TC-010 | IT-WAL-002: `metadata.db` is replaced by non-database bytes, then the Bridge starts | stderr reports `quarantined`; `metadata.db.corrupt-*` exists; the rebuilt mirror passes `verifyMirror` against `state.json` | `tests/instance-lock-it.test.mjs` |
| IT-PF-001 | Project whose CLI package is `1.40.0`; `POST run {}` | `202`; run ends `status=error`, `error=PLAYWRIGHT_VERSION_UNSUPPORTED`, `errorHint` set, `preflight.ok=false`; events `run.queued`, `run.error`; marker absent (engine never spawned) | `tests/preflight-it.test.mjs` |
| IT-PF-002 | Project whose `@playwright/test` declares `playwright`, which is absent | `error=PLAYWRIGHT_DEPENDENCY_MISSING`; marker absent | `tests/preflight-it.test.mjs` |
| IT-PF-003 | Project whose config file is deleted after registration | `error=PLAYWRIGHT_CONFIG_REQUIRED`; marker absent | `tests/preflight-it.test.mjs` |
| IT-PF-004 | Complete fake 1.64.1 install; `POST run {file:"tests/ok.spec.ts"}` | run `passed`; `preflight.ok=true`; marker present; `run.command` ends with the filter | `tests/preflight-it.test.mjs` |
| IT-PF-005 | `POST run {config:"evil.ts"}`, `{project:"x"}`, `{args:["--grep","x"]}` | `400 RUN_PARAMETER_NOT_ALLOWED` with `rejected`; no run created | `tests/preflight-it.test.mjs` |
| IT-PF-006 | `POST run {file:"-x.spec.ts"}` (exists at the root) and `{file:"tests/a+b.spec.ts"}` (exists) | `400 INVALID_TEST_FILTER`; no run created | `tests/preflight-it.test.mjs` |
| IT-PF-007 | `POST run {file:"../outside.spec.ts"}` | `400` with `PATH_OUTSIDE_PROJECT` (existing check, regression) | `tests/preflight-it.test.mjs` |
| IT-RUN-001 | Existing: project without dependencies | `202`, `status=error` (unchanged contract) | `tests/api.test.mjs` |

## Boundary & Failure Cases

- The refusal and the lost-lock exits are asserted on the exit code AND on stderr. A process that dies for another reason (a busy port, a crash) cannot pass.
- The simultaneous-start test repeats 3 times and asserts exactly one winner per round.
- The kill-during-save test accepts only complete generations. A zero-length or partial file fails it.
- The damaged-state test proves the file is NOT overwritten, because a Bridge that started with an empty state would destroy the history.

A preflight failure never leaves the project locked: the run is terminal (`error`), so a second run request is accepted. The whitelist runs before the `capabilities` type check.

## Regression Scope

- `tests/migrate-regressions.test.mjs` UT-MIG-REG-014/015: refusal message, reused pid.
- `tests/execution-model-it.test.mjs` IT-EXE-006/007/011: crash recovery.
- `tests/sqlite-bridge.test.mjs`: mirror behaviour.
- `tests/api.test.mjs`: the Bridge still starts and serves.

Whole `npm test` suite (run lifecycle, cancel, recovery, env profiles, adapter negotiation).

Negative controls (`tools/ats106-probes/mutation-tests.mjs`): M5 removes the whitelist, M6 the preflight gate, M7 the route filter check; `tests/preflight-it.test.mjs` must fail for each.
