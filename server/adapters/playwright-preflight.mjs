/**
 * ATS-106: the environment preflight of a Playwright run.
 *
 * The preflight runs BEFORE the engine is spawned and answers one question
 * from the file system alone: can the project's local Playwright
 * installation run? Every problem it finds carries a DETERMINISTIC code and
 * a hint the operator can act on, instead of a run that dies somewhere inside
 * the CLI with an exit code nobody can interpret.
 *
 * It never spawns a process, never touches the network and never installs
 * anything (FR-009: the CLI comes from the project, it is not downloaded).
 *
 * Design: docs/26-RUNNER-PREFLIGHT.md §2.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PLAYWRIGHT_CLI_CANDIDATES } from './playwright-cli.mjs';

/**
 * The Playwright versions this product has been verified against.
 *
 * The lower bound is the lowest version the repository actually ran
 * (`examples/sample-playwright` declares ^1.58.0 and docs/22 ran 1.58.x; every
 * other run used 1.64.1). The upper bound excludes the next, unverified major.
 * Widening the range needs new evidence, not a new guess.
 */
export const SUPPORTED_PLAYWRIGHT_RANGE = Object.freeze({ min: '1.58.0', maxExclusive: '2.0.0' });

export const PREFLIGHT_CODE = Object.freeze({
  CONFIG_REQUIRED: 'PLAYWRIGHT_CONFIG_REQUIRED',
  NOT_INSTALLED: 'PLAYWRIGHT_NOT_INSTALLED_RUN_NPM_INSTALL_IN_PROJECT',
  VERSION_UNSUPPORTED: 'PLAYWRIGHT_VERSION_UNSUPPORTED',
  NODE_UNSUPPORTED: 'PLAYWRIGHT_NODE_UNSUPPORTED',
  DEPENDENCY_MISSING: 'PLAYWRIGHT_DEPENDENCY_MISSING',
  VERSION_UNKNOWN: 'PLAYWRIGHT_VERSION_UNKNOWN',
  BROWSERS_UNVERIFIED: 'PLAYWRIGHT_BROWSERS_UNVERIFIED',
  BROWSERS_NOT_INSTALLED: 'PLAYWRIGHT_BROWSERS_NOT_INSTALLED',
});

const HINT = Object.freeze({
  [PREFLIGHT_CODE.CONFIG_REQUIRED]: 'Add a playwright.config.ts (or .js/.mjs/.cjs/.mts/.cts) to the project root.',
  [PREFLIGHT_CODE.NOT_INSTALLED]: 'Run `npm install` in the project directory so that @playwright/test is installed locally.',
  [PREFLIGHT_CODE.VERSION_UNSUPPORTED]: 'Install a supported version in the project: `npm install -D @playwright/test@^1.58`.',
  [PREFLIGHT_CODE.NODE_UNSUPPORTED]: 'Upgrade Node.js to the version the installed Playwright requires, or install a Playwright that supports this Node.js.',
  [PREFLIGHT_CODE.DEPENDENCY_MISSING]: 'Reinstall the project dependencies: `npm ci` (or delete node_modules and run `npm install`).',
  [PREFLIGHT_CODE.VERSION_UNKNOWN]: 'Reinstall @playwright/test with `npm install`; its package.json is missing or unreadable.',
  [PREFLIGHT_CODE.BROWSERS_UNVERIFIED]: 'Install the complete @playwright/test package (`npm install`) so that playwright-core is present.',
  [PREFLIGHT_CODE.BROWSERS_NOT_INSTALLED]: 'Run `npx playwright install` in the project directory (the Bridge does not download browsers).',
});

/** The browsers Playwright installs by default and a UI test needs. */
const DEFAULT_BROWSERS = Object.freeze(['chromium', 'chromium-headless-shell', 'firefox', 'webkit']);

const CONFIG_FILE = /^playwright\.config\.[cm]?[jt]s$/;

/** `1.64.1` / `v1.64.1` / `1.64.1-beta.2` -> [1, 64, 1]; anything else -> null. */
export function parseVersion(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(text ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Compare two parsed versions: -1, 0 or 1. */
export function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * The directory of an installed package, resolved the way Node resolves it
 * from `fromDir`. Returns null when it cannot be found.
 *
 * A package that does not export its package.json is still PRESENT: the
 * resolution error says so, and the directory is then found by walking up
 * the node_modules chain.
 */
function packageDir(fromDir, name) {
  const req = createRequire(path.join(fromDir, '__ats_preflight__.js'));
  try {
    return path.dirname(req.resolve(`${name}/package.json`));
  } catch (e) {
    if (e && e.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') return null;
    for (let dir = fromDir; ; dir = path.dirname(dir)) {
      const candidate = path.join(dir, 'node_modules', ...name.split('/'));
      if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
      if (path.dirname(dir) === dir) return null;
    }
  }
}

const isPlaywrightPackage = (name) => name === 'playwright' || name.startsWith('playwright-') || name.startsWith('@playwright/');

/**
 * The registry directory Playwright looks for browsers in, computed from
 * the environment the CHILD process will receive (docs/26 §2.2).
 */
export function browserRegistryDir({ env = {}, platform = process.platform, homedir = os.homedir(), coreDir = null, projectRoot = process.cwd() } = {}) {
  const defined = env.PLAYWRIGHT_BROWSERS_PATH;
  let dir;
  if (defined === '0') {
    dir = path.join(coreDir || projectRoot, '.local-browsers');
  } else if (defined) {
    dir = defined;
  } else {
    let cache;
    if (platform === 'linux') cache = env.XDG_CACHE_HOME || path.join(homedir, '.cache');
    else if (platform === 'darwin') cache = path.join(homedir, 'Library', 'Caches');
    else cache = env.LOCALAPPDATA || path.join(homedir, 'AppData', 'Local');
    dir = path.join(cache, 'ms-playwright');
  }
  return path.isAbsolute(dir) ? dir : path.resolve(projectRoot, dir);
}

/** The host platform key Playwright uses for `revisionOverrides` (mac only). */
function macPlatformKey(release = os.release(), arch = process.arch) {
  const major = Number(String(release).split('.')[0]);
  // Darwin 23 = macOS 14, Darwin 24 = macOS 15, ...
  const mac = Number.isFinite(major) && major >= 20 ? major - 9 : 10.15;
  return `mac${mac}${arch === 'arm64' ? '-arm64' : ''}`;
}

/** The folder of one browser inside the registry, or null when it is unknown. */
export function browserFolder(descriptor, platform, hostKey) {
  const override = platform === 'darwin' ? (descriptor.revisionOverrides || {})[hostKey] : undefined;
  const revision = override || descriptor.revision;
  if (!revision) return null;
  const prefix = override ? `${descriptor.name}_${hostKey}_special` : descriptor.name;
  return `${prefix.replace(/-/g, '_')}-${revision}`;
}

/**
 * Run the preflight for one project.
 *
 * @param {string} projectRoot  the registered project root
 * @param {object} [opts]
 * @param {object} [opts.env]          the SEALED environment of the child
 * @param {string} [opts.platform]
 * @param {string} [opts.homedir]      the home directory the child resolves
 * @param {string} [opts.nodeVersion]  the Node.js version that runs the CLI
 * @param {string} [opts.macHostKey]   override of the mac platform key
 */
export function preflightPlaywright(projectRoot, opts = {}) {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const homedir = opts.homedir ?? (platform === 'win32' ? (env.USERPROFILE || os.homedir()) : (env.HOME || os.homedir()));
  const nodeVersion = opts.nodeVersion ?? process.versions.node;
  const errors = [];
  const warnings = [];
  const checks = [];
  const report = { ok: false, cli: null, version: null, registry: null, errors, warnings, checks };
  const fail = (name, code, detail = {}) => { errors.push({ code, hint: HINT[code], detail }); checks.push({ name, status: 'failed' }); };
  const warn = (name, code, detail = {}) => { warnings.push({ code, hint: HINT[code], detail }); checks.push({ name, status: 'warning' }); };
  const pass = (name) => checks.push({ name, status: 'ok' });
  const skip = (...names) => names.forEach((name) => checks.push({ name, status: 'skipped' }));

  // 1. config
  let entries = [];
  try { entries = fs.readdirSync(projectRoot); } catch { entries = []; }
  if (entries.some((n) => CONFIG_FILE.test(n))) pass('config');
  else fail('config', PREFLIGHT_CODE.CONFIG_REQUIRED, { projectRoot });

  // 2. the local CLI
  const rel = PLAYWRIGHT_CLI_CANDIDATES.find((c) => fs.existsSync(path.join(projectRoot, c)));
  if (!rel) {
    fail('cli', PREFLIGHT_CODE.NOT_INSTALLED, { candidates: [...PLAYWRIGHT_CLI_CANDIDATES] });
    skip('version', 'node', 'dependencies', 'browsers');
    report.ok = errors.length === 0;
    return report;
  }
  const cli = path.join(projectRoot, rel);
  const cliDir = path.dirname(cli);
  report.cli = cli;
  pass('cli');

  // 3. version of the package that owns the CLI
  const pkg = readJson(path.join(cliDir, 'package.json'));
  const version = pkg && typeof pkg.version === 'string' ? pkg.version : null;
  const parsed = parseVersion(version);
  report.version = version;
  const supported = `>=${SUPPORTED_PLAYWRIGHT_RANGE.min} <${SUPPORTED_PLAYWRIGHT_RANGE.maxExclusive}`;
  if (!parsed) {
    warn('version', PREFLIGHT_CODE.VERSION_UNKNOWN, { package: pkg?.name || rel, version, supported });
  } else if (compareVersions(parsed, parseVersion(SUPPORTED_PLAYWRIGHT_RANGE.min)) < 0
    || compareVersions(parsed, parseVersion(SUPPORTED_PLAYWRIGHT_RANGE.maxExclusive)) >= 0) {
    fail('version', PREFLIGHT_CODE.VERSION_UNSUPPORTED, { package: pkg?.name || rel, version, supported });
  } else {
    pass('version');
  }

  // 4. the Node.js the CLI requires (only the `>=N[.M[.P]]` form is read)
  const engine = pkg?.engines?.node;
  const floor = typeof engine === 'string' ? /^\s*>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(engine) : null;
  if (!floor) {
    skip('node');
  } else {
    const required = [Number(floor[1]), Number(floor[2] || 0), Number(floor[3] || 0)];
    const current = parseVersion(nodeVersion);
    if (current && compareVersions(current, required) < 0) fail('node', PREFLIGHT_CODE.NODE_UNSUPPORTED, { required: engine, node: nodeVersion });
    else pass('node');
  }

  // 5. the Playwright-family dependencies the CLI package declares
  let coreDir = pkg?.name === 'playwright-core' ? cliDir : null;
  if (!pkg || !pkg.dependencies) {
    skip('dependencies');
  } else {
    const missing = [];
    const queue = [{ dir: cliDir, deps: pkg.dependencies, from: pkg.name || rel }];
    const seen = new Set();
    while (queue.length) {
      const { dir, deps, from } = queue.shift();
      for (const name of Object.keys(deps).filter(isPlaywrightPackage)) {
        if (seen.has(name)) continue;
        seen.add(name);
        const found = packageDir(dir, name);
        if (!found) { missing.push({ package: name, requiredBy: from }); continue; }
        if (name === 'playwright-core') coreDir = found;
        const child = readJson(path.join(found, 'package.json'));
        if (child && child.dependencies) queue.push({ dir: found, deps: child.dependencies, from: name });
      }
    }
    if (missing.length) fail('dependencies', PREFLIGHT_CODE.DEPENDENCY_MISSING, { missing });
    else pass('dependencies');
  }

  // 6. the browsers, in the registry the child will use
  const browsers = coreDir ? readJson(path.join(coreDir, 'browsers.json')) : null;
  if (!browsers || !Array.isArray(browsers.browsers)) {
    warn('browsers', PREFLIGHT_CODE.BROWSERS_UNVERIFIED, { reason: coreDir ? 'browsers.json is missing or unreadable' : 'playwright-core was not found' });
  } else {
    const registry = browserRegistryDir({ env, platform, homedir, coreDir, projectRoot });
    report.registry = registry;
    const hostKey = opts.macHostKey ?? macPlatformKey();
    const missingBrowsers = [];
    for (const descriptor of browsers.browsers) {
      if (!DEFAULT_BROWSERS.includes(descriptor.name) || !descriptor.installByDefault) continue;
      const folder = browserFolder(descriptor, platform, hostKey);
      if (!folder || !fs.existsSync(path.join(registry, folder, 'INSTALLATION_COMPLETE'))) missingBrowsers.push({ browser: descriptor.name, folder });
    }
    if (missingBrowsers.length) warn('browsers', PREFLIGHT_CODE.BROWSERS_NOT_INSTALLED, { registry, missing: missingBrowsers });
    else pass('browsers');
  }

  report.ok = errors.length === 0;
  return report;
}
