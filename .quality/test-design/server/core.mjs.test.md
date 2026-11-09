# Test Design: `server/core.mjs`

Source: `server/core.mjs`

Source-SHA256: `703bf6c70f8b809542046a8e35ee6b1e9011f30742ee5590bc01c3cf4e650d5f`

## Test Strategy

The tests use `node --test`.

**In-process unit tests.** `tests/instance-lock.test.mjs` imports `server/core.mjs` and covers the lock and the persistence functions.
- Each test uses a private `mkdtemp` directory under `os.tmpdir()`, which is pointed at D: during evidence collection.
- Child processes stand in for other holders. Each child exports a barrier, so the race tests start every contender at the same instant.
- Failure paths that cannot be produced on a real disk are injected by replacing properties of the `node:fs` default export, which the module reads at call time: a rename that fails transiently, a filesystem without hard links, a lock that changes between judging and moving. The original function is always restored in `finally`.

**Process-level integration tests.** `tests/instance-lock-it.test.mjs` starts real `node server/index.mjs` processes on ports from `tests/helpers/free-port.mjs`. Every instance gets its own port, so a busy port can never be the reason for a refusal.

**Regression suite.** The existing `tests/migrate-regressions.test.mjs` (UT-MIG-REG-001..015) runs unchanged and pins the lock semantics that the migration tools rely on.

## Test Cases

| Case ID | Input / Setup | Expected Outcome | Test Location |
| --- | --- | --- | --- |
| TC-001 | UT-LOCK-001: `acquireBridgeLock` on a fresh file, then `verifyBridgeLock`, then `releaseBridgeLock` | record has pid, startedAt, processStartedAt and a UUID token; verify `{held:true, reason:'held'}`; release returns true; file gone; verify reason `not-acquired` (a released lock is no longer claimed); no `*.tmp` left | `tests/instance-lock.test.mjs` |
| TC-002 | UT-LOCK-002: second acquire while this live process holds the lock | throws `BRIDGE_ALREADY_RUNNING`, `reason:'held'`, `holder.pid` = own pid; lock file bytes unchanged | `tests/instance-lock.test.mjs` |
| TC-003 | UT-LOCK-003: a child process holds the lock; acquire with `waitMs:400` | throws `BRIDGE_ALREADY_RUNNING` after ≥ 400 ms with `waitedMs` ≥ 400 | `tests/instance-lock.test.mjs` |
| TC-004 | UT-LOCK-004: a child holds the lock and releases it after 500 ms; acquire with `waitMs:15000` | acquire succeeds after the release; the record carries this process's pid | `tests/instance-lock.test.mjs` |
| TC-005 | UT-LOCK-005: stale lock of a dead pid; and a lock whose pid was reused (start time mismatch) | both taken over; record is ours; no `bridge.lock.stale-*` file remains | `tests/instance-lock.test.mjs` |
| TC-006 | UT-LOCK-006: live pid without `processStartedAt`; and a garbage (non-JSON) lock file | first is HELD (`BRIDGE_ALREADY_RUNNING`); garbage is taken over | `tests/instance-lock.test.mjs` |
| TC-007 | UT-LOCK-007: 6 child processes released by one barrier call `acquireBridgeLock` on the same fresh file | exactly 1 prints WON, 5 print HELD; the file names the winner | `tests/instance-lock.test.mjs` |
| TC-008 | UT-LOCK-008: same race on a pre-existing stale lock (dead pid) | exactly 1 WON, 5 HELD; no stale aside files remain | `tests/instance-lock.test.mjs` |
| TC-009 | UT-LOCK-009: `takeOverStaleLock(file, staleText)` while the file holds a different (fresh) record; on a missing file; with `linkSync` failing `EPERM` (no hard links); with the rename failing `EIO` | returns false and the fresh record is restored byte-identical (also through the exclusive-create fallback); false for the missing file; `EIO` rethrown; no aside file remains | `tests/instance-lock.test.mjs` |
| TC-010 | UT-LOCK-010: restore of the displaced record finds a newer lock (injected: `linkSync` publishes another record first) | returns false; the newer lock is kept; aside removed | `tests/instance-lock.test.mjs` |
| TC-011 | UT-LOCK-011: filesystem without hard links (`linkSync` throws `EPERM`, then `ENOTSUP`) | acquire falls back to exclusive create; a second acquire is refused; release works | `tests/instance-lock.test.mjs` |
| TC-012 | UT-LOCK-012: the lock vanishes on every attempt (injected `linkSync` → `EEXIST` with no file); `linkSync` → `EBUSY` every time; `linkSync` → `EIO`; a stale lock whose rename aside fails with `EBUSY`, then with `EIO` | `reason:'contended'`; `EBUSY` rethrown after exactly `LOCK_MAX_ATTEMPTS` attempts; `EIO` rethrown at once; `contended`; `EIO` rethrown | `tests/instance-lock.test.mjs` |
| TC-013 | UT-LOCK-013: `releaseBridgeLock` on a foreign record (other token / other pid) and on a missing file; `verifyBridgeLock` on a foreign record, on garbage, on a never-acquired file | release returns false and the foreign file stays; verify reasons `taken-over`, `unreadable`, `not-acquired` | `tests/instance-lock.test.mjs` |
| TC-014 | UT-LOCK-014: `lockWaitFromEnv` / `lockVerifyIntervalFromEnv` with `undefined`, `''`, `'-1'`, `'abc'`, `'1.5'`, `'250'`, `'10'`; acquire on a held lock with `waitMs` of `-5`, `'abc'`, `true`, `null`, `' '`, and with `waitMs:'120', pollMs:0` | defaults 0 / 5000 for invalid input, 250 accepted, interval floor 50; invalid options refuse at once; the numeric string waits ≥ 120 ms | `tests/instance-lock.test.mjs` |
| TC-015 | UT-LOCK-015: `acquireBridgeLock(file, {createDir:false})` in a missing directory | throws `ENOENT`; the directory is not created | `tests/instance-lock.test.mjs` |
| TC-016 | UT-DATA-001: `loadState` on a non-JSON file, a zero-length file, `null`, `{"schema":2}` | `STATE_CORRUPT` (with `file` and `detail`) for the first two; `UNSUPPORTED_DATABASE` for the last two; the file is unchanged | `tests/instance-lock.test.mjs` |
| TC-017 | UT-DATA-002: `saveState` with recording wrappers on `fs.fsyncSync` and `fs.renameSync` | fsync of the temp descriptor happens before the rename; the temp is `state.json.<pid>.tmp`; no temp remains; content round-trips | `tests/instance-lock.test.mjs` |
| TC-018 | UT-DATA-003: rename fails twice with `EPERM` then succeeds; rename always fails with `EBUSY`; rename fails with `ENOSPC` | first succeeds after retries; second and third rethrow, the old `state.json` is byte-identical and the temp is removed | `tests/instance-lock.test.mjs` |
| TC-019 | UT-DATA-004: leftover `state.json.tmp` and `state.json.4242.tmp` with torn content plus an unrelated `state.json.bak` | `removeStateTempFiles` removes exactly the two temps; `state.json` and `.bak` unchanged; `loadState` returns the committed state | `tests/instance-lock.test.mjs` |
| TC-020 | UT-DATA-005: `syncDirectory(dir,'win32')`, `syncDirectory(dir,process.platform)`, `syncDirectory(missing,'linux')` | `false` for win32 and for the missing dir; no throw in any case | `tests/instance-lock.test.mjs` |
| TC-021 | UT-WAL-001: `recoverMetadataMirror` on a missing file and on a healthy mirror written by `saveState` | `absent`; `ok` with the files untouched | `tests/instance-lock.test.mjs` |
| TC-022 | UT-WAL-002: mirror replaced by non-database bytes (with `-wal`/`-shm` siblings present) | `quarantined`; the damaged file is moved to `metadata.db.corrupt-*` together with any `-wal`/`-shm` that still exist (SQLite may already have discarded them when it opened the damaged file); no `metadata.db`, `-wal` or `-shm` remains; the next `saveState` rebuilds a mirror that `verifyMirror` accepts | `tests/instance-lock.test.mjs` |
| TC-023 | UT-WAL-003: mirror with an overwritten b-tree page | `quick_check` problems → `quarantined` with the problem text in `reason` | `tests/instance-lock.test.mjs` |
| TC-024 | UT-WAL-004: mirror whose `schema_version` is in the future; a `metadata.db` path that is a directory; rename of a damaged file fails (injected `EBUSY`) | `ok` and kept (a newer schema is not damage); `unchecked` and left alone; `quarantine-failed` with the reason | `tests/instance-lock.test.mjs` |
| TC-026 | UT-MOB-315: `authoritativeCatalog` with a synthetic listing; a web case and a scenario deleted in discovery 2, same-fingerprint new cases in discovery 3; a retitled scenario | the new cases do not receive the deleted uids; the merged cell drops the deleted entries after discovery 2 and holds one entry per uid with the newest title | `tests/mobile-import.test.mjs` |
| TC-027 | UT-MOB-312/313/314 and IT-ATS602-API-012/013/014: the explicit token census and the collision rule through `discoverStatic` and the HTTP API | no duplicate uid in any catalogue; see `.quality/test-design/server/discovery/mobile-import.mjs.test.md` | `tests/mobile-import*.test.mjs` |
| TC-025 | IT-LOCK-001..006, IT-DATA-001..002, IT-WAL-001..002: real Bridge processes (second instance refused while the first serves, simultaneous start, hard kill and takeover with an interrupted run, wait for the lock, taken-over lock stops the Bridge, deleted lock re-acquired, damaged state refused, kill during saves, WAL replay after a kill mid-transaction, damaged mirror rebuilt) | see `.quality/test-design/server/index.mjs.test.md` | `tests/instance-lock-it.test.mjs` |

## Boundary & Failure Cases

- A pid of `2147483647` stands for a dead process.
- A start time of `2001-01-01T00:00:00.0000000Z` stands for a reused pid.
- The race tests assert the exact count of winners (1), not "at least one".
- Every failure injection restores the original `fs` function in `finally`, so one failing test cannot poison the next.
- The WAL test kills the writer while it prints `IN-TX` inside an open transaction, never after a sleep, so the kill point is deterministic.
- A power cut differs from a process kill: a kill does not drop the OS page cache. So the fsync-before-rename ordering is asserted directly (TC-017), not inferred from the kill tests.

## Regression Scope

- `tests/migrate-regressions.test.mjs` (lock semantics used by the migrations).
- `tests/migrate-state.test.mjs` (the CLI refuses with exit 3 while a Bridge holds the lock).
- `tests/sqlite-bridge.test.mjs` (mirror retry behaviour).
- `tests/execution-model-it.test.mjs` (crash recovery to `interrupted`).
- The full `npm test` at `--test-concurrency=2`.
