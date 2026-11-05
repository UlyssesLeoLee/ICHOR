/**
 * ATS-301 unit tests: the adapter contract and capability negotiation.
 *
 * These are pure-logic tests: no engine is started, no browser is launched.
 * They pin the rules that the whole capability model rests on:
 *
 *   - an unsupported capability carries a REASON (never a silent false)
 *   - a supported capability carries EVIDENCE (never an unproven claim)
 *   - negotiation needs the PROJECT (a capability is a property of a project)
 *   - an unknown capability is reported, not thrown
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ADAPTER_CONTRACT_VERSION,
  CAPABILITY_VOCABULARY,
  REQUIRED_OPERATIONS,
  AdapterError,
  assertAdapter,
  capability,
  gaps,
  hasPositionalFilter,
  negotiate,
  parseCliOptions,
  parseCliUsage,
  probeCommand,
  readPackageVersion,
  requireCapability,
  resolveProjectBinary,
  supports,
} from '../server/adapters/contract.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats301-ut-'));
const project = { id: 'proj_ut', root: dir };

test('UT-ADP-001: contract version is 1 and the operation set is fixed', () => {
  assert.equal(ADAPTER_CONTRACT_VERSION, 1);
  assert.deepEqual([...REQUIRED_OPERATIONS], ['discover', 'start', 'stop', 'collect']);
});

test('UT-ADP-002: every vocabulary entry declares a kind', () => {
  for (const [name, spec] of Object.entries(CAPABILITY_VOCABULARY)) {
    assert.ok(['required', 'optional', 'diagnostic'].includes(spec.kind), `${name} has kind ${spec.kind}`);
    assert.ok(spec.desc.length > 0, `${name} has no description`);
  }
});

test('UT-ADP-003: an unsupported capability must carry a reason', () => {
  try {
    capability('trace', false, {});
    assert.fail('should have thrown');
  } catch (e) {
    assert.equal(e.code, 'CAPABILITY_REASON_REQUIRED');
  }
  const c = capability('trace', false, { reason: 'no built-in trace in this engine' });
  assert.equal(c.supported, false);
  assert.equal(c.reason, 'no built-in trace in this engine');
  assert.equal(c.evidence, '');
});

test('UT-ADP-004: a supported capability must carry evidence', () => {
  try {
    capability('trace', true, {});
    assert.fail('should have thrown');
  } catch (e) {
    assert.equal(e.code, 'CAPABILITY_EVIDENCE_REQUIRED');
  }
  const c = capability('trace', true, { evidence: 'probed from --help' });
  assert.equal(c.supported, true);
  assert.equal(c.evidence, 'probed from --help');
  assert.equal(c.reason, '');
});

test('UT-ADP-005: an unknown capability name is rejected', () => {
  try {
    capability('teleport', true, { evidence: 'x' });
    assert.fail('should have thrown');
  } catch (e) {
    assert.equal(e.code, 'UNKNOWN_CAPABILITY');
  }
});

test('UT-ADP-006: assertAdapter rejects an adapter missing an operation', () => {
  try {
    assertAdapter({ kind: 'x', contractVersion: 1 });
    assert.fail('should have thrown');
  } catch (e) {
    assert.equal(e.code, 'INVALID_ADAPTER');
    assert.match(e.message, /is missing discover\(\)/);
  }
  try {
    assertAdapter({ kind: 'x', contractVersion: 1, discover() {}, start() {}, stop() {} });
    assert.fail('should have thrown');
  } catch (e) {
    assert.equal(e.code, 'INVALID_ADAPTER');
    assert.match(e.message, /is missing collect\(\)/);
  }
});

test('UT-ADP-007: assertAdapter rejects a contract version mismatch', () => {
  const full = { kind: 'x', contractVersion: 99, discover() {}, start() {}, stop() {}, collect() {}, capabilities() {} };
  try {
    assertAdapter(full);
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof AdapterError);
    assert.equal(e.code, 'CONTRACT_VERSION_MISMATCH');
    assert.match(e.message, /speaks contract v99/);
  }
});

test('UT-ADP-008: a conforming adapter passes assertAdapter', () => {
  const full = { kind: 'x', contractVersion: ADAPTER_CONTRACT_VERSION, discover() {}, start() {}, stop() {}, collect() {}, capabilities() {} };
  assert.equal(assertAdapter(full), full);
});

/** A stub adapter whose capability set the test controls. */
function stubAdapter(unsupported = []) {
  return {
    kind: 'stub',
    contractVersion: ADAPTER_CONTRACT_VERSION,
    capabilities() {
      return Object.keys(CAPABILITY_VOCABULARY).map((name) => (
        unsupported.includes(name)
          ? capability(name, false, { reason: `stub refuses ${name}` })
          : capability(name, true, { evidence: `stub supports ${name}` })
      ));
    },
    discover() {}, start() {}, stop() {}, collect() {},
  };
}

test('UT-ADP-009: negotiation over supported capabilities succeeds', () => {
  const r = negotiate(stubAdapter(), project, ['discover', 'start']);
  assert.equal(r.supported, true);
  assert.equal(r.missing.length, 0);
  assert.deepEqual(r.requested, ['discover', 'start']);
  assert.equal(r.adapter, 'stub');
  assert.equal(r.contractVersion, ADAPTER_CONTRACT_VERSION);
});

test('UT-ADP-010: negotiation reports the missing capability with its reason', () => {
  const r = negotiate(stubAdapter(['trace']), project, ['discover', 'trace']);
  assert.equal(r.supported, false);
  assert.equal(r.missing.length, 1);
  assert.equal(r.missing[0].name, 'trace');
  assert.equal(r.missing[0].reason, 'stub refuses trace');
});

test('UT-ADP-011: negotiation reports a capability the adapter does not declare', () => {
  const r = negotiate(stubAdapter(), project, ['notAThing']);
  assert.equal(r.supported, false);
  assert.equal(r.missing[0].name, 'notAThing');
  assert.match(r.missing[0].reason, /does not declare this capability/);
});

test('UT-ADP-012: requireCapability throws CAPABILITY_UNSUPPORTED with the reasons', () => {
  try {
    requireCapability(stubAdapter(['video']), project, ['discover', 'video']);
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof AdapterError);
    assert.equal(e.code, 'CAPABILITY_UNSUPPORTED');
    assert.match(e.message, /video: stub refuses video/);
    assert.equal(e.details.missing.length, 1);
  }
});

test('UT-ADP-013: requireCapability returns the negotiation when everything is supported', () => {
  const r = requireCapability(stubAdapter(), project, ['discover']);
  assert.equal(r.supported, true);
});

test('UT-ADP-014: supports() and gaps() read the same capability set', () => {
  const a = stubAdapter(['trace', 'video']);
  assert.equal(supports(a, project, 'discover'), true);
  assert.equal(supports(a, project, 'trace'), false);
  assert.equal(supports(a, project, 'nope'), false);
  const g = gaps(a, project).map((c) => c.name).sort();
  assert.deepEqual(g, ['trace', 'video']);
});

test('UT-ADP-015: parseCliOptions reads EVERY alias on a help line', () => {
  // Playwright prints "-g, --grep <grep>" -- matching only the first token
  // would hide --grep and make the adapter refuse a capability the CLI has.
  const help = [
    'Usage: npx playwright test [options] [test-filter...]',
    '',
    'Options:',
    '  --add-reporter <reporter>        Reporter to add on top of the configured',
    '  -g, --grep <grep>                Only run tests matching this regex',
    '  -j, --workers <workers>           Number of concurrent workers',
    '  --reporter <reporter>            Reporter to use, comma-separated',
    '  -h, --help                       display help for command',
  ].join('\n');
  const opts = parseCliOptions(help);
  for (const k of ['grep', 'workers', 'reporter', 'help', 'add-reporter']) {
    assert.ok(opts.includes(k), `expected ${k} in ${JSON.stringify(opts)}`);
  }
});

test('UT-ADP-016: parseCliOptions does not invent options from the description column', () => {
  const help = 'Options:\n  --output <dir>   Folder for output artifacts (default: "test-results")';
  const opts = parseCliOptions(help);
  assert.deepEqual(opts, ['output']);
  assert.ok(!opts.includes('default'));
  assert.ok(!opts.includes('Folder'));
});

test('UT-ADP-017: parseCliUsage reads the usage line and detects the positional filter', () => {
  const help = 'Usage: npx playwright test [options] [test-filter...]\n\nOptions:\n  --help';
  assert.equal(parseCliUsage(help), 'npx playwright test [options] [test-filter...]');
  assert.equal(hasPositionalFilter(help), true);
  assert.equal(hasPositionalFilter('Usage: wdio.js run <configPath>'), false);
});

test('UT-ADP-017B: hasPositionalFilter accepts a BARE usage line as well as a help text', () => {
  // The adapter extracts the usage line ONCE and then asks about the
  // positional filter. Feeding that extracted line back must still work --
  // otherwise `filterByFile` is reported unsupported while `start()` passes
  // the file as a positional argument (the ATS-301 review finding C1).
  const usage = 'npx playwright test [options] [test-filter...]';
  assert.equal(hasPositionalFilter(usage), true);
  assert.equal(parseCliUsage(usage), '', 'a bare usage line has no Usage: prefix');
  // A usage line WITHOUT the positional filter must stay false.
  assert.equal(hasPositionalFilter('wdio.js run <configPath>'), false);
  assert.equal(hasPositionalFilter('npx playwright test [options]'), false);
  assert.equal(hasPositionalFilter(''), false);
});

test('UT-ADP-018: probeCommand never throws when the command is missing', () => {
  const r = probeCommand('this-command-does-not-exist-ats301', ['--help']);
  assert.equal(r.ok, false);
  assert.ok(r.error.length > 0 || r.status !== 0);
});

test('UT-ADP-019: resolveProjectBinary returns null when nothing matches', () => {
  assert.equal(resolveProjectBinary(dir, ['node_modules/nope/cli.js']), null);
});

test('UT-ADP-020: readPackageVersion reads a version and returns null when absent', () => {
  fs.mkdirSync(path.join(dir, 'node_modules', 'some-pkg'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'some-pkg', 'package.json'), JSON.stringify({ version: '1.2.3' }));
  assert.equal(readPackageVersion(dir, 'some-pkg'), '1.2.3');
  assert.equal(readPackageVersion(dir, 'absent-pkg'), null);
});

test('UT-ADP-CLEANUP: removes the generated fixture', () => {
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(fs.existsSync(dir), false);
});
