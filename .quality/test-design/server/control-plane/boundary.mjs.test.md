# Test Design: `server/control-plane/boundary.mjs`

Source: `server/control-plane/boundary.mjs`

Source-SHA256: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`

## Test Strategy

Unit tests with `node:test` in `tests/control-plane.test.mjs` (catalog IDs UT-CP-001..007). The module is pure, so every case calls the exported function directly with literal inputs; no filesystem, network or process fixture is needed. Coverage is measured with `node --test --experimental-test-coverage` (LCOV) and must exceed 90% of lines.

## Test Cases

| Case ID | Input / Setup | Expected Outcome | Test Location |
| --- | --- | --- | --- |
| TC-001 | `detectLocalPath` on `C:\repo`, `c:/x`, `C:`, `see D:\x`, `\\srv\share`, `\\?\C:\x`, `//srv/s`, `/home/a`, `/`, `at /Users/b/x`, `file:///C:/x`, `~/r`, `~`, `%USERPROFILE%\r`, `$HOME/r`, `${HOME}/r`, `a/../b`, `..`, `git@github.com:o/r.git`, `ssh://h/r`, `https://h/o/r.git` (UT-CP-001) | the matching rule name for each | `tests/control-plane.test.mjs` |
| TC-002 | `detectLocalPath` on `https://example.com/a`, `prj_` + UUID, 40-hex SHA, `a/b`, `Login / Logout`, `ns:name`, `TCP/IP`, `ratio 3:/x`, `''`, number `42`, `null` (UT-CP-002) | `null` for every value | `tests/control-plane.test.mjs` |
| TC-003 | `detectLocalPath('C%3A%5Crepo')`, `'%2Fhome%2Fa'`, malformed `'%E0%A4%A'` (UT-CP-003) | `windows_drive_path`, `posix_absolute_path`, `null` (malformed text is checked raw only) | `tests/control-plane.test.mjs` |
| TC-004 | `inspectValue` on `{a:[{b:'C:\\x'}]}`, `{'C:\\k':1}`, `{ok:'x', list:['y']}` (UT-CP-004) | finding `{code:'REMOTE_PATH_FORBIDDEN', pointer:'/a/0/b'}`, key finding with pointer `/C:\k` replaced by its index form, `null`; the finding never contains the value | `tests/control-plane.test.mjs` |
| TC-005 | `classifyField` on `path`, `Project_Root`, `repository-url`, `cloneUrl`, `token`, `X-ATS-Token`, `apiKey`, `displayName` (UT-CP-005) | path/repository fields -> `REMOTE_PATH_FORBIDDEN`; credential fields -> `REMOTE_SECRET_INLINE_FORBIDDEN`; `displayName` -> `null` | `tests/control-plane.test.mjs` |
| TC-006 | `isLocalSessionTokenShape` on 48-hex, 48-hex upper case, 40-hex, 64-hex, 47-hex, non-hex; `inspectValue({note: <48-hex>})` (UT-CP-006) | true only for 48 hex; body finding `REMOTE_SECRET_INLINE_FORBIDDEN` kind `local_session_token_shape` | `tests/control-plane.test.mjs` |
| TC-007 | `inspectValue` on a 33-level nested object with default depth, and on a 32-level one (UT-CP-007) | first -> `REMOTE_POLICY_REJECTED` kind `depth_exceeded`; second -> `null` | `tests/control-plane.test.mjs` |

## Boundary & Failure Cases

Drive letter preceded by a letter (`http:` scheme, `Fix:/x`) must not match; a lone `/` is a POSIX absolute path; depth exactly 32 passes and 33 fails; 47/48/49 hex characters around the token shape; percent-decoding failure falls back to the raw text instead of throwing; non-string and non-object inputs return `null` and never throw.

## Regression Scope

The local Bridge is not affected (it does not import this module). `app.mjs` relies on the rule names and codes; a rule change is caught by the in-process HTTP cases UT-CP-019/026 and by IT-CP-006..008.
