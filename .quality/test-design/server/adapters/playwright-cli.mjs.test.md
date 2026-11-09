# Test Design: `server/adapters/playwright-cli.mjs`

Source: `server/adapters/playwright-cli.mjs`

Source-SHA256: `626c98c3a9915b68db0224c3d9808f552b20bfe51f7b99b89cdb0d9558652d9f`

## Test Strategy

`node:test` unit tests in `tests/preflight.test.mjs` call the pure assertions directly and call `buildPlaywrightArgs` with a fake CLI path; the ATS-301 suites (`tests/adapters*.test.mjs`) cover option selection and must stay green.

## Test Cases

| Case ID | Input / Setup | Expected Outcome | Test Location |
| --- | --- | --- | --- |
| UT-ARG-001 | `tests/a.spec.ts`, `tests\\sub\\b.test.ts`, `e2e/x-y_z@1.spec.mjs` | accepted; backslashes normalised to `/` | `tests/preflight.test.mjs` |
| UT-ARG-002 | `-x.spec.ts`, `--config=evil.ts`, `--project` | `INVALID_TEST_FILTER` (option injection) | `tests/preflight.test.mjs` |
| UT-ARG-003 | `../outside.spec.ts`, `tests/../../x.spec.ts`, `..\\x.spec.ts` | `INVALID_TEST_FILTER` (traversal) | `tests/preflight.test.mjs` |
| UT-ARG-004 | `/etc/x.spec.ts`, `C:/x.spec.ts`, `tests/a.spec.ts:12` | `INVALID_TEST_FILTER` (absolute / line filter) | `tests/preflight.test.mjs` |
| UT-ARG-005 | `tests/a|b.spec.ts`, `tests/.*.spec.ts`, `tests/(a).spec.ts`, `tests/a+.spec.ts` | `INVALID_TEST_FILTER` (regex metacharacter) | `tests/preflight.test.mjs` |
| UT-ARG-006 | NUL or LF inside the path, `""`, 501 characters, the number `42` | `INVALID_TEST_FILTER` | `tests/preflight.test.mjs` |
| UT-ARG-007 | `assertSafePlaywrightArgv` on the vectors `buildPlaywrightArgs` produces for the full and the empty option set | accepted unchanged | `tests/preflight.test.mjs` |
| UT-ARG-008 | Vector with `--config x`, `-c x`, `--project=chromium`, `--grep x`, a duplicate `--workers`, `--workers 4`, `--trace off`, relative `--output`, wrong `args[0]`, missing `test`, two positionals | `UNSAFE_CLI_ARGUMENT` | `tests/preflight.test.mjs` |
| UT-ARG-009 | `buildPlaywrightArgs` with `testFile: "--config=evil.ts"` | throws `INVALID_TEST_FILTER`; no vector returned | `tests/preflight.test.mjs` |

## Boundary & Failure Cases

The 500-character limit is inclusive; `.` is allowed; Windows separators are normalised before the checks so `..\\x` is caught as traversal.

## Regression Scope

ATS-301 option selection (`tests/adapters.test.mjs`, `tests/adapters-it.test.mjs`, `tests/adapters-engines.test.mjs`) and the ATS-101 B-01 regression (no `--screenshot`/`--video`).

UT-ARG-008 pins the reason `the option <name> is not allowed` for `--config`, `-c`, `--project`, `--grep`, so the explicit option guard is tested even though the positional filter check would also refuse those tokens (mutation M2 of `tools/ats106-probes/mutation-tests.mjs`). M1 removes the leading `-` filter check.
