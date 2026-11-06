// ATS-106: unit tests of the Playwright preflight and of the argument safety
// baseline (docs/26-RUNNER-PREFLIGHT.md). Every tree below is a FAKE
// installation built under os.tmpdir(); the host's own Playwright, browsers
// and environment are never consulted (env/platform/homedir are explicit).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PREFLIGHT_CODE, SUPPORTED_PLAYWRIGHT_RANGE, browserFolder, browserRegistryDir, compareVersions, parseVersion, preflightPlaywright,
} from '../server/adapters/playwright-preflight.mjs';
import { assertSafePlaywrightArgv, assertSafeTestFilter, buildPlaywrightArgs } from '../server/adapters/playwright-cli.mjs';
import { safeRunArgs } from '../server/core.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ats106-ut-'));
let seq = 0;
const BROWSERS = [
  { name: 'chromium', revision: '1248', installByDefault: true },
  { name: 'chromium-headless-shell', revision: '1248', installByDefault: true },
  { name: 'firefox', revision: '1555', installByDefault: true },
  { name: 'webkit', revision: '2370', installByDefault: true, revisionOverrides: { mac14: '2251' } },
  { name: 'ffmpeg', revision: '1013', installByDefault: true },
  { name: 'android', revision: '1001', installByDefault: false },
];
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const json = (file, value) => write(file, JSON.stringify(value));

/** A fake project. Every piece can be left out to provoke one finding. */
function project({
  config = true, cli = true, version = '1.64.1', pkgJson, engines = { node: '>=20' }, playwright = true, core = true, browsersJson = true, installed = BROWSERS.map((b) => b.name),
} = {}) {
  const root = path.join(tmp, `p${++seq}`);
  const registry = path.join(tmp, `r${seq}`);
  fs.mkdirSync(root, { recursive: true });
  if (config) write(path.join(root, 'playwright.config.ts'), 'export default {}');
  const nm = path.join(root, 'node_modules');
  if (cli) {
    write(path.join(nm, '@playwright', 'test', 'cli.js'), '');
    if (pkgJson !== undefined) write(path.join(nm, '@playwright', 'test', 'package.json'), pkgJson);
    else if (version !== null) json(path.join(nm, '@playwright', 'test', 'package.json'), { name: '@playwright/test', version, engines, dependencies: { playwright: version } });
  }
  if (playwright) json(path.join(nm, 'playwright', 'package.json'), { name: 'playwright', version, dependencies: { 'playwright-core': version } });
  if (core) {
    json(path.join(nm, 'playwright-core', 'package.json'), { name: 'playwright-core', version });
    if (browsersJson) json(path.join(nm, 'playwright-core', 'browsers.json'), { browsers: BROWSERS });
  }
  for (const b of BROWSERS.filter((x) => installed.includes(x.name))) {
    write(path.join(registry, `${b.name.replace(/-/g, '_')}-${b.revision}`, 'INSTALLATION_COMPLETE'), '');
  }
  return { root, env: { PLAYWRIGHT_BROWSERS_PATH: registry }, registry };
}
const run = (p, extra = {}) => preflightPlaywright(p.root, { env: p.env, platform: 'win32', homedir: tmp, nodeVersion: '22.1.0', ...extra });
const codes = (list) => list.map((x) => x.code);

test('UT-PF-001: a complete installation passes every check', () => {
  const p = project();
  const r = run(p);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.version, '1.64.1');
  assert.equal(r.registry, p.registry);
  assert.ok(r.cli.endsWith(path.join('@playwright', 'test', 'cli.js')));
  assert.deepEqual(r.checks.map((c) => `${c.name}:${c.status}`), ['config:ok', 'cli:ok', 'version:ok', 'node:ok', 'dependencies:ok', 'browsers:ok']);
});

test('UT-PF-002: a missing config is a blocking error with a hint', () => {
  const r = run(project({ config: false }));
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r.errors), [PREFLIGHT_CODE.CONFIG_REQUIRED]);
  assert.match(r.errors[0].hint, /playwright\.config/);
});

test('UT-PF-003: a missing CLI blocks and skips every check that needs it', () => {
  const r = run(project({ cli: false }));
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r.errors), ['PLAYWRIGHT_NOT_INSTALLED_RUN_NPM_INSTALL_IN_PROJECT']);
  assert.match(r.errors[0].hint, /npm install/);
  assert.deepEqual(r.checks.filter((c) => c.status === 'skipped').map((c) => c.name), ['version', 'node', 'dependencies', 'browsers']);
  assert.equal(run({ root: path.join(tmp, 'does-not-exist'), env: {} }).errors[0].code, PREFLIGHT_CODE.CONFIG_REQUIRED);
});

test('UT-PF-004: a version outside the supported range blocks', () => {
  for (const version of ['1.57.9', '2.0.0', '0.9.0']) {
    const r = run(project({ version }));
    assert.equal(r.ok, false, version);
    assert.deepEqual(codes(r.errors), [PREFLIGHT_CODE.VERSION_UNSUPPORTED], version);
    assert.equal(r.errors[0].detail.version, version);
    assert.equal(r.errors[0].detail.supported, `>=${SUPPORTED_PLAYWRIGHT_RANGE.min} <${SUPPORTED_PLAYWRIGHT_RANGE.maxExclusive}`);
    assert.match(r.errors[0].hint, /@playwright\/test@\^1\.58/);
  }
});

test('UT-PF-005: the range is inclusive below and exclusive above', () => {
  for (const version of ['1.58.0', '1.99.99']) assert.equal(run(project({ version })).ok, true, version);
});

test('UT-PF-006: an unreadable version is a warning, not a pass and not a block', () => {
  for (const opts of [{ version: null }, { version: 'banana' }, { pkgJson: '{not json' }]) {
    const r = run(project(opts));
    assert.equal(r.ok, true);
    assert.ok(codes(r.warnings).includes(PREFLIGHT_CODE.VERSION_UNKNOWN));
    assert.equal(r.checks.find((c) => c.name === 'version').status, 'warning');
  }
});

test('UT-PF-007: the Node.js floor of the CLI package is enforced', () => {
  const r = run(project({ engines: { node: '>=24' } }));
  assert.deepEqual(codes(r.errors), [PREFLIGHT_CODE.NODE_UNSUPPORTED]);
  assert.equal(r.errors[0].detail.node, '22.1.0');
  assert.equal(run(project({ engines: { node: '>= 20.5.1' } })).ok, true);
  assert.equal(run(project({ engines: { node: '^20 || ^22' } })).checks.find((c) => c.name === 'node').status, 'skipped');
});

test('UT-PF-008: a missing Playwright dependency blocks and names the package', () => {
  const a = run(project({ playwright: false }));
  assert.deepEqual(codes(a.errors), [PREFLIGHT_CODE.DEPENDENCY_MISSING]);
  assert.deepEqual(a.errors[0].detail.missing, [{ package: 'playwright', requiredBy: '@playwright/test' }]);
  const b = run(project({ core: false }));
  assert.deepEqual(b.errors[0].detail.missing, [{ package: 'playwright-core', requiredBy: 'playwright' }]);
  assert.match(b.errors[0].hint, /npm ci/);
});

test('UT-PF-009: without browsers.json the browsers are reported as unverified', () => {
  const r = run(project({ browsersJson: false }));
  assert.equal(r.ok, true);
  assert.deepEqual(codes(r.warnings), [PREFLIGHT_CODE.BROWSERS_UNVERIFIED]);
  // A test double without package.json declares no dependency: no core either.
  const d = run(project({ version: null, playwright: false, core: false }));
  assert.equal(d.ok, true);
  assert.deepEqual(codes(d.warnings), [PREFLIGHT_CODE.VERSION_UNKNOWN, PREFLIGHT_CODE.BROWSERS_UNVERIFIED]);
  assert.equal(d.warnings[1].detail.reason, 'playwright-core was not found');
});

test('UT-PF-010: missing browsers are a warning that lists them', () => {
  const none = run(project({ installed: [] }));
  assert.equal(none.ok, true);
  assert.deepEqual(codes(none.warnings), [PREFLIGHT_CODE.BROWSERS_NOT_INSTALLED]);
  assert.deepEqual(none.warnings[0].detail.missing.map((m) => m.browser), ['chromium', 'chromium-headless-shell', 'firefox', 'webkit']);
  assert.match(none.warnings[0].hint, /npx playwright install/);
  const p = project({ installed: ['chromium', 'chromium-headless-shell', 'webkit'] });
  fs.mkdirSync(path.join(p.registry, 'firefox-1555'), { recursive: true }); // folder without the marker
  assert.deepEqual(run(p).warnings[0].detail.missing, [{ browser: 'firefox', folder: 'firefox-1555' }]);
});

test('UT-PF-011: the registry directory follows the child environment', () => {
  const home = path.join(tmp, 'home');
  const core = path.join(tmp, 'core');
  const root = path.join(tmp, 'root');
  assert.equal(browserRegistryDir({ env: {}, platform: 'win32', homedir: home }), path.join(home, 'AppData', 'Local', 'ms-playwright'));
  assert.equal(browserRegistryDir({ env: { LOCALAPPDATA: path.join(tmp, 'lad') }, platform: 'win32', homedir: home }), path.join(tmp, 'lad', 'ms-playwright'));
  assert.equal(browserRegistryDir({ env: {}, platform: 'linux', homedir: home }), path.join(home, '.cache', 'ms-playwright'));
  assert.equal(browserRegistryDir({ env: { XDG_CACHE_HOME: path.join(tmp, 'xdg') }, platform: 'linux', homedir: home }), path.join(tmp, 'xdg', 'ms-playwright'));
  assert.equal(browserRegistryDir({ env: {}, platform: 'darwin', homedir: home }), path.join(home, 'Library', 'Caches', 'ms-playwright'));
  assert.equal(browserRegistryDir({ env: { PLAYWRIGHT_BROWSERS_PATH: '0' }, coreDir: core, projectRoot: root }), path.join(core, '.local-browsers'));
  assert.equal(browserRegistryDir({ env: { PLAYWRIGHT_BROWSERS_PATH: path.join(tmp, 'abs') } }), path.join(tmp, 'abs'));
  assert.equal(browserRegistryDir({ env: { PLAYWRIGHT_BROWSERS_PATH: 'rel/b' }, projectRoot: root }), path.join(root, 'rel', 'b'));
  // The host's own variables are NOT used when the child env lacks them.
  assert.equal(run(project(), { env: {} }).registry, path.join(tmp, 'AppData', 'Local', 'ms-playwright'));
});

test('UT-PF-012: mac revision overrides select the special folder', () => {
  const webkit = BROWSERS.find((b) => b.name === 'webkit');
  assert.equal(browserFolder(webkit, 'darwin', 'mac14'), 'webkit_mac14_special-2251');
  assert.equal(browserFolder(webkit, 'darwin', 'mac15'), 'webkit-2370');
  assert.equal(browserFolder(webkit, 'win32', 'mac14'), 'webkit-2370');
  assert.equal(browserFolder({ name: 'x' }, 'win32', ''), null);
  const p = project({ installed: ['chromium', 'chromium-headless-shell', 'firefox'] });
  write(path.join(p.registry, 'webkit_mac14_special-2251', 'INSTALLATION_COMPLETE'), '');
  assert.equal(run(p, { platform: 'darwin', macHostKey: 'mac14' }).warnings.length, 0);
  assert.equal(run(p, { platform: 'darwin', macHostKey: 'mac15' }).warnings[0].detail.missing[0].folder, 'webkit-2370');
});

test('UT-PF-013: versions are parsed strictly and compared numerically', () => {
  assert.deepEqual(parseVersion('1.64.1'), [1, 64, 1]);
  assert.deepEqual(parseVersion('v1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseVersion('1.2.3-beta.1'), [1, 2, 3]);
  assert.equal(parseVersion('1.2'), null);
  assert.equal(parseVersion('x'), null);
  assert.equal(parseVersion(undefined), null);
  assert.equal(compareVersions([1, 9, 0], [1, 10, 0]), -1);
  assert.equal(compareVersions([1, 10, 0], [1, 9, 9]), 1);
  assert.equal(compareVersions([1, 2, 3], [1, 2, 3]), 0);
});

test('UT-PF-014: several blocking problems are all reported, in check order', () => {
  const r = run(project({ config: false, version: '1.40.0', playwright: false }));
  assert.deepEqual(codes(r.errors), [PREFLIGHT_CODE.CONFIG_REQUIRED, PREFLIGHT_CODE.VERSION_UNSUPPORTED, PREFLIGHT_CODE.DEPENDENCY_MISSING]);
});

test('UT-PF-015: a dependency that does not export package.json still counts as present', () => {
  const p = project();
  json(path.join(p.root, 'node_modules', 'playwright', 'package.json'), { name: 'playwright', version: '1.64.1', exports: { '.': './index.js' }, dependencies: { 'playwright-core': '1.64.1' } });
  assert.equal(run(p).ok, true);
});

test('UT-ARG-001: a plain relative filter is accepted and normalised', () => {
  assert.equal(assertSafeTestFilter('tests/a.spec.ts'), 'tests/a.spec.ts');
  assert.equal(assertSafeTestFilter('tests\\sub\\b.test.ts'), 'tests/sub/b.test.ts');
  assert.equal(assertSafeTestFilter('e2e/x-y_z@1.spec.mjs'), 'e2e/x-y_z@1.spec.mjs');
  assert.equal(assertSafeTestFilter('a'.repeat(500)), 'a'.repeat(500));
});

const refused = (value, reason) => assert.throws(() => assertSafeTestFilter(value), (e) => e.code === 'INVALID_TEST_FILTER' && e.message === 'INVALID_TEST_FILTER' && reason.test(e.reason), String(value));

test('UT-ARG-002: a filter that would be read as an option is refused', () => {
  for (const f of ['-x.spec.ts', '--config=evil.ts', '--project']) refused(f, /CLI option/);
});

test('UT-ARG-003: traversal is refused', () => {
  for (const f of ['../outside.spec.ts', 'tests/../../x.spec.ts', '..\\x.spec.ts']) refused(f, /\.\./);
});

test('UT-ARG-004: absolute paths and line filters are refused', () => {
  refused('/etc/x.spec.ts', /absolute/);
  refused('C:/x.spec.ts', /absolute/);
  refused('tests/a.spec.ts:12', /absolute/);
});

test('UT-ARG-005: regular expression metacharacters are refused', () => {
  for (const f of ['tests/a|b.spec.ts', 'tests/.*.spec.ts', 'tests/(a).spec.ts', 'tests/a+.spec.ts', 'tests/[a].spec.ts', 'tests/^a$.spec.ts', 'tests/a{2}.spec.ts', 'tests/a?.spec.ts']) refused(f, /metacharacter/);
});

test('UT-ARG-006: empty, oversized, non-string and control-character filters are refused', () => {
  refused('', /1 to 500/);
  refused('a'.repeat(501), /1 to 500/);
  refused(42, /1 to 500/);
  refused('tests/a\u0000.spec.ts', /control/);
  refused('tests/a\n.spec.ts', /control/);
});

const CLI = path.join(tmp, 'node_modules', '@playwright', 'test', 'cli.js');
const OUT = path.join(tmp, 'out');
const ALL = ['reporter', 'output', 'trace', 'workers'];

test('UT-ARG-007: the vectors the builder produces pass the whole-vector check', () => {
  const full = buildPlaywrightArgs({ cli: CLI, options: ALL, outputDir: OUT, testFile: 'tests\\a.spec.ts' });
  assert.deepEqual(full, [CLI, 'test', '--reporter=line,json,html', '--output', path.join(OUT, 'results'), '--trace', 'on', '--workers', '1', 'tests/a.spec.ts']);
  assert.deepEqual(buildPlaywrightArgs({ cli: CLI, options: [], outputDir: OUT, testFile: null }), [CLI, 'test']);
  assert.equal(assertSafePlaywrightArgv(full, { cli: CLI }), full);
});

test('UT-ARG-008: any option the Bridge does not emit is refused', () => {
  const base = [CLI, 'test'];
  const bad = [
    [...base, '--config', 'x'], [...base, '-c', 'x'], [...base, '--project=chromium'], [...base, '--grep', 'x'],
    [...base, '--workers', '1', '--workers', '1'], [...base, '--workers', '4'], [...base, '--trace', 'off'],
    [...base, '--output', 'relative'], [...base, '--output'], ['/other/cli.js', 'test'], [CLI, 'show-report'], [CLI],
    [...base, 'tests/a.spec.ts', 'tests/b.spec.ts'], [...base, 'tests/a|b.spec.ts'], [...base, 'x\ny'], [...base, 7], 'not-an-array',
  ];
  for (const args of bad) assert.throws(() => assertSafePlaywrightArgv(args, { cli: CLI }), (e) => e.code === 'UNSAFE_CLI_ARGUMENT' && typeof e.reason === 'string', JSON.stringify(args));
});

test('UT-ARG-009: the builder refuses an unsafe filter instead of returning a vector', () => {
  assert.throws(() => buildPlaywrightArgs({ cli: CLI, options: ALL, outputDir: OUT, testFile: '--config=evil.ts' }), { code: 'INVALID_TEST_FILTER' });
});

/** A project whose fake CLI prints a --help that declares the four options. */
function helpProject() {
  const root = path.join(tmp, `h${++seq}`);
  write(path.join(root, 'playwright.config.ts'), 'export default {}');
  write(path.join(root, 'package.json'), '{}');
  write(path.join(root, 'node_modules', '@playwright', 'test', 'cli.js'), "console.log(['Usage: playwright test [options] [test-filter...]','Options:','  --reporter <reporter>  r','  --output <dir>  o','  --trace <mode>  t','  -j, --workers <workers>  w'].join('\\n'))");
  write(path.join(root, 'tests', 'a.spec.ts'), "test('a',()=>{})");
  write(path.join(root, '-x.spec.ts'), "test('x',()=>{})");
  return { root };
}

test('UT-CORE-106-001: safeRunArgs passes the output directory the builder expects', () => {
  const p = helpProject();
  const args = safeRunArgs(p, 'tests/a.spec.ts', OUT);
  assert.equal(args[args.indexOf('--output') + 1], path.join(OUT, 'results'));
  assert.equal(args.at(-1), 'tests/a.spec.ts');
});

test('UT-CORE-106-002: safeRunArgs refuses an option-shaped filter', () => {
  assert.throws(() => safeRunArgs(helpProject(), '-x.spec.ts', OUT), { code: 'INVALID_TEST_FILTER' });
  assert.throws(() => safeRunArgs({ root: path.join(tmp, 'nothing') }, null, OUT), /PLAYWRIGHT_NOT_INSTALLED/);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
