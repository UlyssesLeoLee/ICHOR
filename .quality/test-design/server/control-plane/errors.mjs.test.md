# Test Design: `server/control-plane/errors.mjs`

Source: `server/control-plane/errors.mjs`

Source-SHA256: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`

## Test Strategy

Unit tests with `node:test` in `tests/control-plane.test.mjs` (UT-CP-008/009). The drift guard reads the JSON constraint block that follows `<!-- ats501-constraints -->` in `docs/19-REMOTE-RUNNER-PROTOCOL.md` and compares it code by code with `REMOTE_CODES`.

## Test Cases

| Case ID | Input / Setup | Expected Outcome | Test Location |
| --- | --- | --- | --- |
| TC-001 | Parse `rejection.codes` of the `docs/19` constraint block; compare with `REMOTE_CODES` (UT-CP-008) | same code set (25), same `http` and `retryable` per code; every hint is a non-empty string | `tests/control-plane.test.mjs` |
| TC-002 | `new ControlPlaneError('NOT_A_CODE')` and `errorBody('NOT_A_CODE')` (UT-CP-009) | both throw `TypeError` | `tests/control-plane.test.mjs` |
| TC-003 | `new ControlPlaneError('REMOTE_PATH_FORBIDDEN', 'path_field')` and `errorBody` of it (UT-CP-009) | `http=422`, `retryable=false`, `reason='path_field'`; body keys exactly `error`, `hint`, `retryable`; the reason is not in the body | `tests/control-plane.test.mjs` |
| TC-004 | Every code in `REMOTE_CODES` (UT-CP-008) | starts with `REMOTE_`; none equals `INVALID_SESSION`, `ORIGIN_NOT_ALLOWED`, `INVALID_HOST`, `NOT_FOUND` | `tests/control-plane.test.mjs` |

## Boundary & Failure Cases

An unknown code is a programming error and must throw rather than produce a response; the audit-only reason must never reach the response body; the table is frozen (assignment to it has no effect).

## Regression Scope

A change to the `docs/19` code table without a matching change here (or the reverse) fails UT-CP-008. The ATS-501 protocol audit is unaffected.
