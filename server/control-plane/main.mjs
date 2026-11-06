/**
 * Process entrypoint of the deployable control plane (ATS-506).
 *
 *   node server/control-plane/main.mjs        (npm run start:control-plane)
 *
 * It runs under plain Node: the Tauri shell never starts it and it needs no
 * Tauri command ("禁止仅依赖 Tauri 特权 API"). The configuration rules are
 * docs/21-CONTROL-PLANE-API.md §7:
 *
 *   - a non-loopback host requires TLS (HTTPS, TLS 1.3 minimum);
 *   - the port must differ from the local Bridge port ATS_PORT when that is
 *     set (HB-7: no shared endpoint). The Bridge's default port is not
 *     hardcoded here;
 *   - dev-static authentication is only allowed on a loopback host.
 *
 * A configuration error ends the process with exit code 2. Neither the error
 * nor the startup log ever prints a token.
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createControlPlane } from './app.mjs';
import { denyAllAuthenticator, parseDevTokens, staticBearerAuthenticator } from './auth.mjs';

export const DEFAULT_PORT = 4610;
const AUTH_MODES = ['none', 'dev-static'];

export class ConfigError extends Error {
  constructor(variable, message) {
    super(`${variable}: ${message}`);
    this.name = 'ConfigError';
    this.variable = variable;
    this.exitCode = 2;
  }
}

export function isLoopbackHost(host) {
  if (host === 'localhost') return true;
  const family = net.isIP(host);
  if (family === 4) return host.startsWith('127.');
  if (family === 6) return host === '::1';
  return false;
}

function parsePort(variable, raw) {
  const text = String(raw).trim();
  const n = /^\d{1,5}$/.test(text) ? Number(text) : NaN;
  if (!(n >= 1 && n <= 65535)) throw new ConfigError(variable, 'must be an integer between 1 and 65535');
  return n;
}

const isSet = (value) => value !== undefined && value !== null && String(value).trim() !== '';

/** Turn environment variables into a validated listen configuration. */
export function resolveConfig(env = {}) {
  const host = isSet(env.ATS_CP_HOST) ? String(env.ATS_CP_HOST).trim() : '127.0.0.1';
  const port = isSet(env.ATS_CP_PORT) ? parsePort('ATS_CP_PORT', env.ATS_CP_PORT) : DEFAULT_PORT;
  if (isSet(env.ATS_PORT) && Number(String(env.ATS_PORT).trim()) === port) {
    throw new ConfigError('ATS_CP_PORT', 'must differ from the local Bridge port ATS_PORT (HB-7: no shared endpoint)');
  }
  const certFile = isSet(env.ATS_CP_TLS_CERT) ? String(env.ATS_CP_TLS_CERT) : null;
  const keyFile = isSet(env.ATS_CP_TLS_KEY) ? String(env.ATS_CP_TLS_KEY) : null;
  if (Boolean(certFile) !== Boolean(keyFile)) {
    throw new ConfigError(certFile ? 'ATS_CP_TLS_KEY' : 'ATS_CP_TLS_CERT', 'ATS_CP_TLS_CERT and ATS_CP_TLS_KEY must be set together');
  }
  const tls = certFile ? { certFile, keyFile } : null;
  const loopback = isLoopbackHost(host);
  if (!tls && !loopback) throw new ConfigError('ATS_CP_HOST', 'a non-loopback host requires TLS (ATS_CP_TLS_CERT and ATS_CP_TLS_KEY)');
  const authMode = isSet(env.ATS_CP_AUTH) ? String(env.ATS_CP_AUTH).trim() : 'none';
  if (!AUTH_MODES.includes(authMode)) throw new ConfigError('ATS_CP_AUTH', `must be one of ${AUTH_MODES.join(', ')}`);
  if (authMode === 'dev-static') {
    if (!loopback) throw new ConfigError('ATS_CP_AUTH', 'dev-static is only allowed on a loopback host');
    if (!isSet(env.ATS_CP_DEV_TOKENS)) throw new ConfigError('ATS_CP_DEV_TOKENS', 'required when ATS_CP_AUTH=dev-static');
  }
  return { host, port, tls, authMode };
}

/** Select the user-side authenticator for the configuration. */
export function buildAuthenticator(config, env = {}) {
  if (config.authMode !== 'dev-static') return denyAllAuthenticator();
  try {
    return staticBearerAuthenticator(parseDevTokens(env.ATS_CP_DEV_TOKENS));
  } catch (e) {
    throw new ConfigError('ATS_CP_DEV_TOKENS', e.message);
  }
}

/** Create the HTTP/HTTPS server around the control-plane handler and listen. */
export async function startControlPlane(config, {
  env = process.env,
  readFile = fs.readFileSync,
  createHttpServer = http.createServer,
  createHttpsServer = https.createServer,
  log = console.log,
} = {}) {
  const app = createControlPlane({ authenticate: buildAuthenticator(config, env), authMode: config.authMode });
  const listener = (req, res) => { app.handler(req, res); };
  const server = config.tls
    ? createHttpsServer({ key: readFile(config.tls.keyFile), cert: readFile(config.tls.certFile), minVersion: 'TLSv1.3' }, listener)
    : createHttpServer(listener);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  log(`AI Test Studio control plane: ${config.tls ? 'https' : 'http'}://${config.host}:${address.port} (auth=${config.authMode})`);
  return { server, app, address };
}

/** Resolve the configuration from `env` and start; a ConfigError exits with code 2. */
export async function runMain(env = process.env, { exit = process.exit, stderr = process.stderr, ...deps } = {}) {
  try {
    return await startControlPlane(resolveConfig(env), { env, ...deps });
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    stderr.write(`control-plane config error: ${e.message}\n`);
    exit(e.exitCode);
    return null;
  }
}

const invokedDirectly = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await runMain();
