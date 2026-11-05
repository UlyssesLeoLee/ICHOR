# Test Design: `server/control-plane/app.mjs`

Source: `server/control-plane/app.mjs`

Source-SHA256: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`

## Test Strategy

Two levels. UT (`tests/control-plane.test.mjs`, UT-CP-015..030): the handler from `createControlPlane` is mounted on an in-process `http.Server` bound to `127.0.0.1:0` with a static-bearer authenticator for two tenants; requests are sent with `node:http` so the raw request target (including `..` segments) reaches the handler unchanged. IT (`tests/control-plane-it.test.mjs`, IT-CP-001..012): the real entrypoint and the real local Bridge run as child processes side by side.

## Test Cases

| Case ID | Input / Setup | Expected Outcome | Test Location |
| --- | --- | --- | --- |
| TC-001 | `GET /cp/v1/health` without credentials (UT-CP-015) | 200, `plane='control-plane'`, `api='cp/v1'`; body has no `pid`, path or version of the host | `tests/control-plane.test.mjs` |
| TC-002 | Any route with `X-ATS-Token` (with and without a valid Bearer) (UT-CP-016) | 401 `REMOTE_UNAUTHENTICATED`; audit reason `local_credential_presented` | `tests/control-plane.test.mjs` |
| TC-003 | `Origin: https://x.example` on health (UT-CP-017) | 403 `REMOTE_POLICY_REJECTED` | `tests/control-plane.test.mjs` |
| TC-004 | `GET /api/session`, `GET /cp/v1/unknown`, `DELETE /cp/v1/projects`, `GET /` (UT-CP-018) | 403 `REMOTE_POLICY_REJECTED` | `tests/control-plane.test.mjs` |
| TC-005 | `GET /cp/v1/projects/C%3A%5Cx`, `/cp/v1/projects/..%2F..%2Fapi`, raw `/cp/v1/../api/session`, `?root=/etc`, `?x=%2Fhome%2Fa`, `/cp/v1/projects/%E0%A4%A` (UT-CP-019) | 422 `REMOTE_PATH_FORBIDDEN` for the first five; 403 `REMOTE_POLICY_REJECTED` for the malformed encoding | `tests/control-plane.test.mjs` |
| TC-006 | `GET /cp/v1/projects` without Authorization, with an unknown Bearer (UT-CP-020) | 401 `REMOTE_UNAUTHENTICATED`, identical bodies; audit reasons `missing_user_token` / `unknown_user_token` | `tests/control-plane.test.mjs` |
| TC-007 | Authenticator returning no tenant; `X-ATS-Tenant` / `?tenantId=` / body `tenantId` of another tenant (UT-CP-021) | 403 `REMOTE_TENANT_REQUIRED`; 403 `REMOTE_TENANT_MISMATCH` for each mismatch | `tests/control-plane.test.mjs` |
| TC-008 | POST with `text/plain`; 65 KiB body; `not json`; `[1]` (UT-CP-022) | 403; 413 `REMOTE_PAYLOAD_TOO_LARGE`; 403; 403 | `tests/control-plane.test.mjs` |
| TC-009 | POST `{displayName:'Checkout'}`, then GET list, GET by UID, GET unknown `prj_` UID, GET `/cp/v1/projects/abc` (UT-CP-023) | 201 with `projectUid` matching `^prj_[0-9a-f-]{36}$`; list of 1; 200; 404 `REMOTE_RESOURCE_NOT_FOUND` twice | `tests/control-plane.test.mjs` |
| TC-010 | Tenant B reads tenant A's project by UID (UT-CP-024) | 404 `REMOTE_RESOURCE_NOT_FOUND`, same body as a missing UID; B's list is empty | `tests/control-plane.test.mjs` |
| TC-011 | POST with `displayName` `''`, 121 characters, containing `\u0007`, `42`; extra field `branch` (UT-CP-025) | 403 `REMOTE_POLICY_REJECTED` each | `tests/control-plane.test.mjs` |
| TC-012 | Store entry injected with `displayName='C:\\leak'`, then GET it (UT-CP-026) | 500 `REMOTE_INTERNAL`; response text has no `leak`; audit reason `egress_boundary_blocked` | `tests/control-plane.test.mjs` |
| TC-013 | `newProjectUid` that throws `Error('boom at C:\\secret')` (UT-CP-027) | 500 `REMOTE_INTERNAL`, retryable true; body has no `boom` and no path | `tests/control-plane.test.mjs` |
| TC-014 | `GET /cp/v1/contract` (UT-CP-030) | 200, `tauriRequired=false`, `localBridgeReachable=false`, `errorNamespace='REMOTE_'`, `credential.localCredentialAccepted=false` | `tests/control-plane.test.mjs` |
| TC-015 | POST bodies with `path`, `root`, `repositoryUrl`, `displayName:'/home/a'`, `token`, a 48-hex value (UT-CP-025 and IT-CP-006..008) | 422 `REMOTE_PATH_FORBIDDEN` / 422 `REMOTE_SECRET_INLINE_FORBIDDEN` | `tests/control-plane.test.mjs` |
| TC-016 | Process-level: local Bridge + control plane, every control-plane response collected (IT-CP-001..012) | see the IT catalog in `docs/08-IT-TEST-DESIGN.md`; no response contains the local data directory, a local project path or the local session token | `tests/control-plane-it.test.mjs` |

## Boundary & Failure Cases

Body of exactly 65536 bytes accepted and 65537 rejected; audit capped at 1000 entries; the raw request target is used for the segment scan so `..` is never normalised away; every error body has exactly the keys `error`, `hint`, `retryable`; a HEAD/PUT on a known path is `REMOTE_POLICY_REJECTED`.

## Regression Scope

Local Bridge tests (`tests/api.test.mjs`, `tests/agent-api.test.mjs`, `tests/runner.test.mjs`) must stay green: the control plane shares no module or port with the Bridge. IT-CP-012 re-checks that the Bridge still registers projects by path.
