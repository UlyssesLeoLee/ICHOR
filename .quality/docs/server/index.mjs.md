# Technical Design: `server/index.mjs`

Source: `server/index.mjs`

Source-SHA256: `60e7f6ea4fa3a1774f05118ba422482b1c1aa8b8ed76e5c7592a5b9e20263f47`

## Responsibility

The Bridge process: HTTP API, run orchestration and the start-up recovery. This design covers only the start-up and lifetime guard that ATS-207 owns:

- the single-instance check of the data directory;
- the periodic holder check;
- refusing a damaged state file;
- removing leftover state temp files;
- checking the SQLite mirror before the first save.

The run recovery itself (interrupted runs, event-log reconciliation) is ATS-208's and is unchanged.

The local Bridge HTTP server. ATS-106 touches two places only: the run route `POST /api/projects/:id/run` (request body field whitelist; the `file` filter goes through `assertSafeTestFilter` after `readSource`) and the run lifecycle `startRun()` (Playwright preflight between `run.queued` and `adapter.start()`).

## Dependencies

- Upstream, from `server/core.mjs`:
  - `acquireBridgeLock`, `releaseBridgeLock`, `verifyBridgeLock`, `lockPath`;
  - `lockWaitFromEnv`, `lockVerifyIntervalFromEnv`;
  - `loadState`, `saveState`, `removeStateTempFiles`, `recoverMetadataMirror`.
- Environment:
  - `ATS_DATA_DIR`, `ATS_PORT` (unchanged);
  - `ATS_LOCK_WAIT_MS`: how long a starting Bridge waits for a busy lock. Default 0, which means refuse at once.
  - `ATS_LOCK_VERIFY_MS`: the holder-check interval. Default 5000 ms, floor 50.
- Downstream: `src-tauri/src/lib.rs` starts this process. `tests/instance-lock-it.test.mjs`, `tests/migrate-regressions.test.mjs` (UT-MIG-REG-014/015) and `tools/ats207-probes/st-ats207.mjs` drive it as a real process.

- Upstream (new): `preflightPlaywright` from `server/adapters/playwright-preflight.mjs`, `assertSafeTestFilter` from `server/adapters/playwright-cli.mjs`.
- Downstream: the run API consumers (`apps/studio`, `apps/studio/public/fallback.html`), `tests/preflight-it.test.mjs`.

## Public Contract

Start-up order. Every step runs before the HTTP server listens.

1. **Take the lock.** `acquireBridgeLock(lockPath(), {waitMs: lockWaitFromEnv(ATS_LOCK_WAIT_MS)})`.
   - On `BRIDGE_ALREADY_RUNNING` the process prints the refusal to stderr and exits with code 1. The message:
     - contains `holds the data directory lock`;
     - names the lock path, the holder pid and the holder's start time, plus the time waited when `ATS_LOCK_WAIT_MS` is set;
     - states the check (`no Bridge is running`) before the recovery step (`delete the lock file`).
   - Any other error is printed and exits 1.
2. `process.on('exit')` releases the lock. Release is token-checked, so a Bridge never removes a lock it no longer holds.
3. **Load the state.** `loadState()` runs.
   - On `STATE_CORRUPT` or `UNSUPPORTED_DATABASE` the process prints:
     - the code;
     - the file;
     - the detail;
     - the reason it does not start (starting would replace the history with an empty state);
     - the recovery steps: keep a copy, restore the last good copy (the ATS-206 migration backup `state.json.bak` when present).

     It then exits 1 **without writing `state.json`** and before touching the temp files or the mirror, so everything that could help a manual recovery stays in place.
4. **Clean up.** `removeStateTempFiles()` runs. A non-empty result is reported on stderr.
5. **Check the mirror.** `recoverMetadataMirror()` runs. `quarantined`, `quarantine-failed` and `unchecked` are reported on stderr with the reason and the moved file names. `ok`, `absent` and `unavailable` are silent.
6. **Recover.** The existing ATS-208 run recovery and the first `saveState(store)` run. That save rebuilds a quarantined or missing mirror from the state.
7. **Holder check.** `setInterval(guard, lockVerifyIntervalFromEnv(ATS_LOCK_VERIFY_MS)).unref()`. Each tick calls `verifyBridgeLock()`:
   - `held`: nothing to do.
   - `absent` (the file was deleted while the Bridge runs): re-acquire with `{createDir:false}`. On success, report `re-acquired`. On failure, report `lost the data directory lock` and exit 1.
   - `unreadable`: report once and check again on the next tick. A transient read failure clears itself; a garbage file that stays is taken over by the next starter as stale, and is then reported as `taken-over`.
   - `taken-over`: report `lost the data directory lock` with the new holder pid, then exit 1. Two Bridges must never share one data directory.

Exit codes: 0 on a normal stop; 1 for a refused start (lock held, damaged state, any start-up error) and for a lost lock.

- `POST /api/projects/:id/run` accepts only `file`, `capabilities`, `runner`, `env`; any other key gives `400 { error: 'RUN_PARAMETER_NOT_ALLOWED', rejected: [...] }` before a run is created. An unsafe `file` gives `400 INVALID_TEST_FILTER`.
- `startRun()` for runner `playwright`: the preflight report is stored on `run.preflight`; when it is not ok the run gets a `run.error` event with `{ error, hint, preflight }`, `status='error'`, `error=<first blocking code>`, `errorHint`, `finishedAt`, and the engine is NOT spawned (no `pid`, no `command`). The HTTP answer stays `202 { run }`.
- Other runners are not preflighted.

## Change Notes

ATS-207 adds the following:

- the wait option on the existing lock;
- the holder check;
- the start-up handling of a damaged state, leftover temps and a damaged mirror.

The refusal message keeps the phrases the existing regression tests and the ATS-201 probes match.

The Tauri shell (`src-tauri/src/lib.rs`) discards the Bridge's stderr and does not use a single-instance plugin. A second desktop window therefore gets its Bridge refused by this check and connects to the first Bridge's port. Showing the refusal in the desktop UI is not part of this change.

ATS-106 adds the whitelist, the filter check and the preflight gate; nothing else in the file changes.
