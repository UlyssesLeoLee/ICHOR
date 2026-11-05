# Test Design: `server/control-plane/auth.mjs`

Source: `server/control-plane/auth.mjs`

Source-SHA256: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`

## Test Strategy

Unit tests with `node:test` in `tests/control-plane.test.mjs` (UT-CP-010/011). Requests are plain objects with a `headers` map; no server is started.

## Test Cases

| Case ID | Input / Setup | Expected Outcome | Test Location |
| --- | --- | --- | --- |
| TC-001 | `denyAllAuthenticator()` with no header and with `Authorization: Bearer x` (UT-CP-010) | `{ok:false, reason:'missing_user_token'}` and `{ok:false, reason:'unknown_user_token'}` | `tests/control-plane.test.mjs` |
| TC-002 | `staticBearerAuthenticator({<32+ char token>: 'ten_a'})` with the right token, a wrong token of equal length, a shorter token, `Basic ...`, no header (UT-CP-010) | ok with `tenantId='ten_a'` and subject `dev:` + 8 hex; `unknown_user_token` for the wrong/short token; `missing_user_token` for Basic and none | `tests/control-plane.test.mjs` |
| TC-003 | `staticBearerAuthenticator` with `{}`, an array, a 31-character token, tenant `tenant1`, tenant `ten_` + 65 characters (UT-CP-011) | each throws `TypeError`; the message does not contain the token | `tests/control-plane.test.mjs` |
| TC-004 | `parseDevTokens` with invalid JSON, `null`, a valid JSON map (UT-CP-011) | `TypeError` for the first two; the parsed map for the third | `tests/control-plane.test.mjs` |

## Boundary & Failure Cases

Token length exactly 32 accepted and 31 rejected; tenant id length 64 accepted and 65 rejected; the comparison works for tokens of different lengths without throwing (digest comparison); header lookup is case-insensitive as delivered by Node (lower-case keys).

## Regression Scope

`app.mjs` maps every non-ok result to `401 REMOTE_UNAUTHENTICATED`; UT-CP-020 and IT-CP-002 cover the HTTP side. ATS-507 will replace the authenticator without changing this contract.
