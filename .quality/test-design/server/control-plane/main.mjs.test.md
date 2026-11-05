# Test Design: `server/control-plane/main.mjs`

Source: `server/control-plane/main.mjs`

Source-SHA256: `d074a46633de9603542b5375614c3a55c37edb224c96aff80d8c11b743b88537`

## Test Strategy

UT in `tests/control-plane.test.mjs` call `resolveConfig`, `buildAuthenticator` and `startControlPlane` in-process with injected server factories and file reader (UT-CP-012..014), so the HTTPS branch is covered without real certificates. The static guards (UT-CP-028/029) read the control-plane sources and `src-tauri/src/lib.rs` as text. IT in `tests/control-plane-it.test.mjs` spawn the file as a real process (IT-CP-SETUP, IT-CP-013).

## Test Cases

| Case ID | Input / Setup | Expected Outcome | Test Location |
| --- | --- | --- | --- |
| TC-001 | `resolveConfig({})` (UT-CP-012) | `{host:'127.0.0.1', port:4610, tls:null, authMode:'none'}` | `tests/control-plane.test.mjs` |
| TC-002 | host `0.0.0.0` without TLS; port equal to `ATS_PORT`; port `0`, `70000`, `abc`; only `ATS_CP_TLS_CERT`; `ATS_CP_AUTH=oidc`; `dev-static` on `0.0.0.0` with TLS; `dev-static` without tokens (UT-CP-013) | each throws `ConfigError` with `exitCode=2`; messages name the variable and never contain token values | `tests/control-plane.test.mjs` |
| TC-003 | host `::1` and `localhost` without TLS; `0.0.0.0` with both TLS files (UT-CP-012) | accepted | `tests/control-plane.test.mjs` |
| TC-004 | `startControlPlane` with TLS config, fake `readFile` and a recording `createHttpsServer` (UT-CP-014) | HTTPS factory called with `minVersion:'TLSv1.3'` and the read key/cert; HTTP factory not called | `tests/control-plane.test.mjs` |
| TC-005 | `startControlPlane` without TLS on port 0 with `dev-static` tokens; a second start on an occupied port; `runMain` with `ATS_CP_HOST=0.0.0.0`, with a free port, and with a throwing server factory (UT-CP-014) | listens, `address.port > 0`, health returns `auth:'dev-static'`, the log has no token; `EADDRINUSE` rejects; exit(2) with `control-plane config error: ATS_CP_HOST: ...`; starts on the given port; the factory error propagates | `tests/control-plane.test.mjs` |
| TC-006 | Static scan of `server/control-plane/*.mjs` imports and text (UT-CP-028) | imports only `node:http`, `node:https`, `node:crypto`, `node:fs` (main only), `node:net`, `node:url`, `node:path` and `./*.mjs`; no `child_process`, `@tauri-apps`, `../`, `ATS_DATA_DIR`, `/api/` endpoint literals | `tests/control-plane.test.mjs` |
| TC-007 | Static scan of `src-tauri/src/lib.rs` and `apps/studio` sources (UT-CP-029) | `generate_handler!` lists only `local_bridge_status`; lib.rs has no `control-plane`, `cp/v1`, `ATS_CP_`; no `@tauri-apps` import in `apps/studio` | `tests/control-plane.test.mjs` |
| TC-009 | `isLoopbackHost` on `127.0.0.1`, `127.1.2.3`, `::1`, `localhost`, `0.0.0.0`, `10.0.0.1`, `::`, `example.com` (UT-CP-012) | true for the first four, false for the rest | `tests/control-plane.test.mjs` |
| TC-008 | Spawn `node server/control-plane/main.mjs` with `ATS_CP_PORT` equal to `ATS_PORT` (IT-CP-013) | exit code 2; stderr names `ATS_CP_PORT` | `tests/control-plane-it.test.mjs` |

## Boundary & Failure Cases

Port 1 and 65535 accepted, 0 and 65536 rejected; IPv6 loopback recognised; `ATS_PORT` unset disables the collision check; the TLS pair must be complete; unknown auth modes fail closed.

## Regression Scope

`package.json` gains `start:control-plane`; existing scripts are unchanged. The Tauri shell is untouched; UT-CP-029 guards that it keeps hosting only the local Bridge.
