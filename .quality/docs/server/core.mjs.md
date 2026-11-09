# Technical Design: `server/core.mjs`

Source: `server/core.mjs`

Source-SHA256: `703bf6c70f8b809542046a8e35ee6b1e9011f30742ee5590bc01c3cf4e650d5f`

## Responsibility

The Bridge's shared core. This design covers the two sections ATS-207 owns. The rest of the module (discovery, source editing, run folders) is unchanged.

1. **The data directory lock** (`bridge.lock`). This is the single-instance guarantee of the data directory. Exactly one process holds it: a Bridge for its whole lifetime, or an offline migration (ATS-206 `tools/migrate_state.mjs`, ATS-201 `tools/migrate_uids.mjs`) for its whole duration.
2. **Durable state persistence**:
   - `state.json` is written so that a crash or power cut at any instant leaves either the previous or the new complete file.
   - A damaged `state.json` is reported instead of being replaced with an empty state.
   - A damaged SQLite metadata mirror (`metadata.db`, ATS-205) is quarantined at start-up and rebuilt from `state.json`.

## Dependencies

- Upstream:
  - `node:fs`, `node:path`, `node:crypto`, `node:child_process` (`processStartTime`).
  - `server/sqlite/db.mjs`: `openDatabase`, `closeDatabase`.
  - `server/sqlite/store.mjs`: `storeState`.
- Downstream:
  - `server/index.mjs`: start-up lock, periodic holder check, state load, temp-file clean-up, mirror check.
  - `server/migration/apply.mjs`, `tools/migrate_state.mjs`, `tools/migrate_uids.mjs`: the same lock with the same error code.
  - `tests/instance-lock.test.mjs`, `tests/instance-lock-it.test.mjs`, `tests/migrate-regressions.test.mjs`.

## Public Contract

### Data directory lock

- **`lockPath(dir)`**: unchanged, `<dir>/bridge.lock`.
- **Lock record**: `{pid, startedAt, processStartedAt, token}`.
  - `token` is a random UUID per acquisition. It is what makes a holder verifiable by itself: the pid can be reused by the OS, the token cannot.
  - Records written by older versions have no token and stay readable.
- **`readBridgeLock(file)`**: unchanged semantics. It returns `null` when the lock is free:
  - the file is missing or unparsable;
  - the pid is dead;
  - the pid was reused, i.e. the recorded `processStartedAt` differs from the live process's start time.

  Otherwise it returns the record. A live pid without `processStartedAt` is HELD.
- **`acquireBridgeLock(file, {waitMs = 0, pollMs = 100, createDir = true})`**: returns `file`.
  - **Atomic publication.** The complete record is first written to a private temp file (`bridge.lock.<pid>.<uuid>.tmp`). It is then published with `fs.linkSync(temp, file)`, which fails with `EEXIST` when the lock exists. The lock file therefore never exists empty or half-written, and two simultaneous starters cannot both succeed: exactly one link wins.
  - **Fallback.** On a filesystem without hard links (`EPERM`, `ENOTSUP`, `ENOSYS`, `EXDEV`, `EINVAL`), it falls back to an exclusive create (`flag 'wx'`).
  - **Stale takeover.** When the existing lock is stale, it is renamed to a unique `bridge.lock.stale-<pid>-<uuid>` name. The renamed bytes are compared with the bytes that were judged stale:
    - identical: the stale file is deleted and publication is retried;
    - different: a live process published a fresh lock in between. That lock is put back with `linkSync`, which never overwrites, and the acquirer treats the lock as held.

    No acquirer ever deletes a lock it did not judge stale.
  - **Error code.** When a live process holds the lock, it throws `Error('BRIDGE_ALREADY_RUNNING')`. The error has:
    - `code = 'BRIDGE_ALREADY_RUNNING'`;
    - `holder` (the record);
    - `waitedMs`;
    - `reason`: `'held'`, or `'contended'` after the bounded retry budget (`LOCK_MAX_ATTEMPTS`) is used up by a lock that keeps changing.
  - **`waitMs`.** With `waitMs > 0`, the acquirer re-checks every `pollMs` (synchronous sleep) until the lock frees or `waitMs` has elapsed.
  - **Invalid options.** Invalid `waitMs` / `pollMs` values (negative, NaN, non-numeric, boolean, `null`, blank) are treated as `0` and the default. `pollMs` has a floor of 1 ms.
  - **Holder start time.** A waiting acquirer reads each holder's start time once per acquisition (on Windows each read spawns PowerShell); its own start time is read once per process (`ownProcessStartTime`).
  - **`createDir: false`.** The acquirer does not recreate a missing data directory and throws `ENOENT` instead.
- **`verifyBridgeLock(file)`**: returns `{held, reason, holder}`. `held` is true only when the file holds the token this process published. `reason` is one of:
  - `'held'`
  - `'absent'` (the file is gone)
  - `'taken-over'` (the file carries another token or another pid)
  - `'unreadable'`
  - `'not-acquired'` (this process never acquired that file)
- **`releaseBridgeLock(file)`**: returns `boolean`. It deletes the file only when it carries this process's token, or, for a token-less legacy record, this process's pid. It never removes another holder's lock.
- **`ownProcessStartTime()`**: the memoised `processStartTime(process.pid)`, so that repeated acquisitions do not spawn PowerShell again.
- **`lockWaitFromEnv(value)`** and **`lockVerifyIntervalFromEnv(value)`**: parse `ATS_LOCK_WAIT_MS` and `ATS_LOCK_VERIFY_MS`.
  - A non-negative integer string is accepted.
  - Anything else yields the default: `0` for the wait, `5000` for the interval.
  - The interval has a floor of `50` ms.
- **`takeOverStaleLock(file, staleText)`**: exported for the race tests only. It returns `true` when the stale lock was removed and `false` when the file was not the judged one.

### Durable state persistence

- **`writeFileDurably(file, text)`**:
  1. Writes `<file>.<pid>.tmp`. The temp name is per process, so two writers never share a temp file.
  2. Calls `fs.fsyncSync` on its descriptor.
  3. Closes it.
  4. Renames it over `file`.
  5. Syncs the directory (`syncDirectory`).
  - The rename is retried up to 5 times on the transient Windows codes `EPERM` / `EBUSY` / `EACCES` (antivirus or indexer handles).
  - On final failure the temp file is removed and the error is rethrown. `file` keeps its previous content.
- **`syncDirectory(dir, platform = process.platform)`**:
  - On POSIX it opens the directory and fsyncs it, so the rename itself is durable, and returns `true`.
  - On `win32` it returns `false` without action: a directory cannot be opened for fsync there, and NTFS journals the rename metadata.
  - Errors return `false`.
- **`saveState(v)`**: `writeFileDurably(state.json)`, then the best-effort mirror (unchanged).
- **`loadState()`**:
  - A missing file yields the empty state (unchanged).
  - A file that is not JSON (including a zero-length file) throws `Error('STATE_CORRUPT')` with `code`, `file` and `detail`.
  - A JSON value that is not a supported state object (`null`, a wrong `schema`, a missing `projects` / `runs` array) throws `Error('UNSUPPORTED_DATABASE')` with `code` and `file`.
- **`removeStateTempFiles(dir = dataDir())`**: deletes leftover `state.json.tmp` and `state.json.<digits>.tmp` files and returns their names. It is called only by the lock holder, before the first save, so the files cannot belong to a live writer. `state.json` itself is never touched.
- **`recoverMetadataMirror(file = metadataPath())`**:
  1. Opens the mirror with `migrate: false` and the mirror's short busy timeout. Opening the database applies the committed WAL frames; that is SQLite's own crash recovery.
  2. Runs `PRAGMA quick_check`.
  3. Returns `{status, file, reason?, moved?}`, where `status` is one of:
     - `'absent'`: no mirror file.
     - `'ok'`: `quick_check` returned exactly `ok`.
     - `'quarantined'`: `quick_check` reported problems, or opening failed with `SQLITE_CORRUPT` (11) / `SQLITE_NOTADB` (26). `metadata.db`, `-wal` and `-shm` are renamed together to `metadata.db.corrupt-<stamp>[-wal|-shm]`, so a stale WAL can never be replayed into a new database. The next `saveState` rebuilds the mirror from `state.json`.
     - `'unchecked'`: any other error, such as a lock held by another process or a path that is not a file. This is not corruption, so the file is kept. A newer schema version is not damage either: the check opens the mirror without migrating, so such a mirror reports `'ok'`, and the next save reports the version conflict as before.
     - `'unavailable'`: no `node:sqlite`.
     - `'quarantine-failed'`: a rename failed, e.g. a handle held by another process. The file stays and the reason is reported.

### Invariants

- At most one live process holds `bridge.lock`.
- A crashed holder never blocks the next one.
- `state.json` is never zero-length or partial after a crash of the writer.
- The Bridge never starts on a state it could not parse.
- The mirror is derived data. The state file is never rebuilt from it automatically.

### Catalogue identity merge (ATS-602)

The catalogue of a project holds the cases of both engines, and its registry cell is ONE cell.

- **`discoverMobile(project)`**: maps the Flow files of the project (`mapProjectFlows`) and returns `{mapped, files, imports, unsupported, errors}`. It does NOT resolve identities: the catalogue resolves them once, over the whole catalogue, so the live registry is read exactly once per discovery and never mutated by a preliminary pass.
- **Explicit token census** (`explicitTokenCensus(webCases, mobileCases)`): one pass over every title of both engines yields `{duplicated, claimed}`: the tokens more than one case declares, and the tokens any case declares. Both resolvers receive both sets (`duplicateExplicitUids`, `claimedExplicitUids`), so a token declared anywhere in the catalogue is reserved everywhere in it.
- **Static path** (`discoverStatic`): unchanged shape. The mobile cases are resolved first, then handed to `resolveIdentities` as `extraCandidates`, so one merge and one pruning (scope = spec files plus Flow files) produce the cell.
- **Authoritative path** (`authoritativeCatalog`, exported for tests): the cell the authoritative resolver returns is already pruned over the spec files. The mobile entries are merged into THAT cell with `mergeMobileRegistry(resolvedCell.entries, mobileResolved, new Set(flowFiles))`: existing entries are updated by uid (newest position wins), new ones added, and entries of Flow files that no mobile case claims are dropped. The previous cell is never used as the base, so an entry the authoritative resolver pruned does not come back.

Invariants:

- No two cases of a catalogue share a uid, on either path.
- A case deleted from a file that the discovery covered does not hand its uid to a later case with the same fingerprint, on either path.

## Change Notes

ATS-602 round 3 (review findings N1, N2-cross, N3): the catalogue identity merge above. `discoverMobile` no longer returns a `registry` (unused); `authoritativeCatalog` is exported; `mergeRegistryCells` is replaced by `mergeMobileRegistry` over the pruned cell.

ATS-207 hardens the lock that ATS-201/ATS-206 introduced.

- **Unchanged for existing callers:** the file name, the record fields, the `BRIDGE_ALREADY_RUNNING` code, the "no `processStartedAt` means HELD" rule, and the zero-argument call form.
- **Lock defect fixed:** the check-then-write race. `readBridgeLock` followed by `writeFileSync`, with a PowerShell spawn in between, let two simultaneous starters both "acquire".
- **Persistence defects fixed:**
  - a `saveState` without fsync, whose temp file was shared by every writer;
  - `loadState` crashing with a raw `SyntaxError` / `TypeError` on a damaged file.
- **Out of scope:** the migration backup and rollback (`state.json.bak`, the journal) remain ATS-206's. The Tauri shell's own single-instance window handling is not part of this module.
