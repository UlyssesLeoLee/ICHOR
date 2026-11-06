# Technical Design: `server/control-plane/main.mjs`

Source: `server/control-plane/main.mjs`

Source-SHA256: `d074a46633de9603542b5375614c3a55c37edb224c96aff80d8c11b743b88537`

## Responsibility

Process entrypoint of the deployable control plane (`docs/21-CONTROL-PLANE-API.md` §7). It turns environment variables into a validated listen configuration, refuses unsafe configurations (non-loopback without TLS, the same port as the local Bridge, dev authentication off loopback), creates an HTTP or HTTPS (TLS 1.3 minimum) server around `createControlPlane`, and starts listening. It runs under plain Node and is never started by the Tauri shell.

## Dependencies

- Upstream: `server/control-plane/app.mjs`, `server/control-plane/auth.mjs`, `node:http`, `node:https`, `node:fs` (reads only the TLS certificate and key files named by the configuration), `node:net` (`isIP`), `node:url` and `node:path` (entrypoint detection).
- Downstream: `package.json` script `start:control-plane`; `tests/control-plane.test.mjs` UT-CP-012..014; `tests/control-plane-it.test.mjs` (spawns it as a child process, IT-CP-SETUP and IT-CP-013).

## Public Contract

- `resolveConfig(env) -> {host, port, tls: {certFile, keyFile} | null, authMode}`; throws `ConfigError` (with `exitCode = 2`) naming the variable and the reason, never a secret value. Defaults: `127.0.0.1`, `4610`, no TLS, `none`.
- `buildAuthenticator(config, env)`: `none` -> `denyAllAuthenticator()`; `dev-static` -> `staticBearerAuthenticator(parseDevTokens(env.ATS_CP_DEV_TOKENS))`.
- `startControlPlane(config, {env, readFile, createHttpServer, createHttpsServer, log})` -> `Promise<{server, app, address}>`; with TLS the HTTPS options carry `minVersion: 'TLSv1.3'`.
- `isLoopbackHost(host)`: `localhost`, `127.0.0.0/8` and `::1` are loopback; everything else (including `0.0.0.0` and `::`) is not.
- `runMain(env, {exit, stderr, ...deps})`: `resolveConfig(env)` then `startControlPlane`; a `ConfigError` (also from an invalid dev token map) writes `control-plane config error: <message>` to `stderr` and calls `exit(2)`; any other error propagates. Running the file directly calls `runMain()` with the process environment.
- The startup log contains protocol, host, port and auth mode only.

## Change Notes

New module for ATS-506. The local Bridge default port is not hardcoded here: the collision check uses `ATS_PORT` when it is set (`docs/21` §11 item 6).
