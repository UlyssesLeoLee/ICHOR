# Technical Design: `server/control-plane/main.mjs`

Source: `server/control-plane/main.mjs`

Source-SHA256: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`

## Responsibility

Process entrypoint of the deployable control plane (`docs/21-CONTROL-PLANE-API.md` §7). It turns environment variables into a validated listen configuration, refuses unsafe configurations (non-loopback without TLS, the same port as the local Bridge, dev authentication off loopback), creates an HTTP or HTTPS (TLS 1.3 minimum) server around `createControlPlane`, and starts listening. It runs under plain Node and is never started by the Tauri shell.

## Dependencies

- Upstream: `server/control-plane/app.mjs`, `server/control-plane/auth.mjs`, `node:http`, `node:https`, `node:fs` (reads only the TLS certificate and key files named by the configuration), `node:net` (`isIP`), `node:url` and `node:path` (entrypoint detection).
- Downstream: `package.json` script `start:control-plane`; `tests/control-plane.test.mjs` UT-CP-012..014; `tests/control-plane-it.test.mjs` (spawns it as a child process, IT-CP-SETUP and IT-CP-013).

## Public Contract

- `resolveConfig(env) -> {host, port, tls: {certFile, keyFile} | null, authMode}`; throws `ConfigError` (with `exitCode = 2`) naming the variable and the reason, never a secret value. Defaults: `127.0.0.1`, `4610`, no TLS, `none`.
- `buildAuthenticator(config, env)`: `none` -> `denyAllAuthenticator()`; `dev-static` -> `staticBearerAuthenticator(parseDevTokens(env.ATS_CP_DEV_TOKENS))`.
- `startControlPlane(config, {env, readFile, createHttpServer, createHttpsServer, log})` -> `Promise<{server, app, address}>`; with TLS the HTTPS options carry `minVersion: 'TLSv1.3'`.
- Running the file directly calls `resolveConfig(process.env)` and `startControlPlane`; a `ConfigError` prints `control-plane config error: <message>` to stderr and exits with code 2.
- The startup log contains protocol, host, port and auth mode only.

## Change Notes

New module for ATS-506. The local Bridge default port is not hardcoded here: the collision check uses `ATS_PORT` when it is set (`docs/21` §11 item 6).
