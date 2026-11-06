# Test Design: `server/index.mjs`

Source: `server/index.mjs`

Source-SHA256: `c8055b7bb9773c45f7cca6c9f0dfc6f3f8fbb02eab9eb236d7cd2147ed074f10`

## Test Strategy

**Integration tests.** `tests/instance-lock-it.test.mjs` starts real `node server/index.mjs` processes.
- Each process gets its own `ATS_DATA_DIR` under a `mkdtemp` directory and its own port from `freePort()`. No port literal is used.
- Readiness is `GET /api/health` returning 200.
- A refusal is the process exiting by itself with code 1, plus the stderr text.
- A hard kill is `SIGKILL` on POSIX and `taskkill /PID <pid> /T /F` on Windows. Both leave the lock file behind, exactly as a crash does.
- The holder-check tests set `ATS_LOCK_VERIFY_MS=100`, so a tick happens within the test's time budget.

**System test.** `tools/ats207-probes/st-ats207.mjs` runs the same guard end to end with a real Playwright run. It is executed separately, and its output is the ST evidence.

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

## Boundary & Failure Cases

- The refusal and the lost-lock exits are asserted on the exit code AND on stderr. A process that dies for another reason (a busy port, a crash) cannot pass.
- The simultaneous-start test repeats 3 times and asserts exactly one winner per round.
- The kill-during-save test accepts only complete generations. A zero-length or partial file fails it.
- The damaged-state test proves the file is NOT overwritten, because a Bridge that started with an empty state would destroy the history.

## Regression Scope

- `tests/migrate-regressions.test.mjs` UT-MIG-REG-014/015: refusal message, reused pid.
- `tests/execution-model-it.test.mjs` IT-EXE-006/007/011: crash recovery.
- `tests/sqlite-bridge.test.mjs`: mirror behaviour.
- `tests/api.test.mjs`: the Bridge still starts and serves.
