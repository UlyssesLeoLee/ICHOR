/**
 * ATS-301: Playwright CLI probing and argument-vector construction.
 *
 * This module exists so that there is EXACTLY ONE place in the product that
 * decides which Playwright CLI options get passed. It is deliberately free of
 * any dependency on `server/core.mjs` and on the adapter objects, so both
 * `core.mjs` (the v0.1-compatible helper) and `adapters/playwright.mjs` (the
 * contract implementation) can use it without an import cycle.
 *
 * The rule it implements, and the reason for it:
 *
 *   ATS-101 defect B-01 -- the Bridge passed a hand-written argument vector
 *   containing `--screenshot` and `--video`, two options `playwright test`
 *   does not have. The CLI rejected the WHOLE vector and every real browser
 *   run died during argument parsing (summary=null, artifacts=[]).
 *
 *   The fix is not "remove those two options" but "never guess": the option
 *   set of the INSTALLED CLI is the contract. An option is only passed when
 *   the installed CLI declares it in its own --help output.
 */
import path from 'node:path';
import fs from 'node:fs';
import { parseCliOptions, parseCliUsage, probeCommand, resolveProjectBinary } from './contract.mjs';

/** Where the local Playwright CLI may live inside the project under test. */
export const PLAYWRIGHT_CLI_CANDIDATES = Object.freeze([
  'node_modules/@playwright/test/cli.js',
  'node_modules/playwright/cli.js',
  'node_modules/playwright-core/cli.js',
]);

/**
 * Probe the INSTALLED Playwright CLI.
 * Returns null when the project has no local Playwright CLI at all.
 */
export function probePlaywrightCli(projectRoot) {
  const cli = resolveProjectBinary(projectRoot, PLAYWRIGHT_CLI_CANDIDATES);
  if (!cli) return null;
  const help = probeCommand(process.execPath, [cli, 'test', '--help'], { cwd: projectRoot });
  return {
    cli,
    helpOk: help.ok,
    options: help.ok ? parseCliOptions(help.stdout) : [],
    usage: help.ok ? parseCliUsage(help.stdout) : '',
    helpError: help.ok ? '' : (help.stderr || help.error).split('\n')[0],
  };
}

/**
 * ATS-106: the argument safety baseline (docs/26-RUNNER-PREFLIGHT.md §3).
 *
 * The test file filter is the ONLY user input that can reach the argument
 * vector. Playwright reads a positional argument as a case-insensitive
 * regular expression over the test file paths, and a `path:line` suffix as a
 * line filter -- so a filter is accepted only when it is a plain relative
 * path: no leading `-` (it would be read as an option), no `..` segment, no
 * absolute path or `:`, no regular expression metacharacter except `.`, no
 * control character.
 */
const FILTER_METACHARACTERS = /[\^$*+?()[\]{}|]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function refuse(code, reason) {
  const error = new Error(code);
  error.code = code;
  error.reason = reason;
  return error;
}

export function assertSafeTestFilter(file) {
  const bad = (reason) => refuse('INVALID_TEST_FILTER', reason);
  if (typeof file !== 'string' || file.length === 0 || file.length > 500) throw bad('the filter must be a string of 1 to 500 characters');
  if (CONTROL_CHARACTERS.test(file)) throw bad('the filter contains a control character');
  const filter = file.replace(/\\/g, '/');
  if (filter.startsWith('-')) throw bad('the filter starts with "-" and would be read as a CLI option');
  if (filter.startsWith('/') || filter.includes(':')) throw bad('the filter is absolute or carries a ":" (line filter / drive letter)');
  if (filter.split('/').includes('..')) throw bad('the filter contains a ".." segment');
  if (FILTER_METACHARACTERS.test(filter)) throw bad('the filter contains a regular expression metacharacter');
  return filter;
}

/**
 * The whole vector, checked before it leaves this module: exactly the CLI,
 * `test`, the four options the Bridge itself emits (each at most once, with
 * its fixed value) and at most one safe filter. Anything else -- `--config`,
 * `--project`, `--grep`, a second positional -- is refused, so a future
 * change that wires user input into the vector is stopped here.
 */
export function assertSafePlaywrightArgv(args, { cli }) {
  const bad = (reason) => refuse('UNSAFE_CLI_ARGUMENT', reason);
  if (!Array.isArray(args) || args.length < 2) throw bad('the vector is too short');
  if (args.some((a) => typeof a !== 'string' || CONTROL_CHARACTERS.test(a))) throw bad('an argument is not a string or contains a control character');
  if (args[0] !== cli) throw bad('the first argument is not the project-local CLI');
  if (args[1] !== 'test') throw bad('the second argument is not "test"');
  const seen = new Set();
  const once = (name) => { if (seen.has(name)) throw bad(`the option ${name} appears twice`); seen.add(name); };
  let positional = 0;
  for (let i = 2; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--reporter=line,json,html') once('--reporter');
    else if (a === '--output') { once('--output'); i += 1; if (!path.isAbsolute(args[i] ?? '')) throw bad('--output must be followed by an absolute path'); }
    else if (a === '--trace') { once('--trace'); i += 1; if (args[i] !== 'on') throw bad('--trace must be "on"'); }
    else if (a === '--workers') { once('--workers'); i += 1; if (args[i] !== '1') throw bad('--workers must be "1"'); }
    else if (a.startsWith('-')) throw bad(`the option ${a.split('=')[0]} is not allowed`);
    else {
      positional += 1;
      if (positional > 1) throw bad('more than one test filter');
      try { assertSafeTestFilter(a); } catch (e) { throw bad(`unsafe test filter: ${e.reason}`); }
    }
  }
  return args;
}

/**
 * Build the CLI argument vector from the probed option set.
 *
 * Only options the installed CLI accepts are passed. Options that take a
 * value are passed as two argv entries; boolean flags as one. The test file
 * filter and the finished vector go through the ATS-106 assertions above.
 */
export function buildPlaywrightArgs({ cli, options, outputDir, testFile }) {
  const has = (name) => options.includes(name);
  const args = [cli, 'test'];
  if (has('reporter')) args.push('--reporter=line,json,html');
  if (has('output')) args.push('--output', path.join(outputDir, 'results'));
  if (has('trace')) args.push('--trace', 'on');
  if (has('workers')) args.push('--workers', '1');
  if (testFile) args.push(assertSafeTestFilter(testFile));
  return assertSafePlaywrightArgv(args, { cli });
}

/**
 * The Playwright result model mapped onto the common result model.
 *
 * Playwright reports a test status of expected | unexpected | flaky |
 * skipped | timedOut. The common model is passed | failed | skipped |
 * flaky | unknown -- the SAME model the WDIO adapter produces.
 *
 * This mapping lives here, in the adapter, and not in core.mjs: the core
 * parseReport() helper is the v0.1 code path and its own consumers read the
 * raw Playwright status. The adapter's job is to produce the common model.
 */
export function mapPlaywrightStatus(status) {
  switch (status) {
    case 'expected': return 'passed';
    case 'unexpected': return 'failed';
    case 'flaky': return 'flaky';
    case 'skipped': return 'skipped';
    default: return 'unknown';
  }
}

/** The report file the CLI writes when PLAYWRIGHT_JSON_OUTPUT_FILE is set. */
export function playwrightReportFile(outputDir) {
  return path.join(outputDir, 'report.json');
}

/** The directory the HTML reporter writes into. */
export function playwrightHtmlDir(outputDir) {
  return path.join(outputDir, 'html');
}

/** True when the project root looks like a directory we can scan. */
export function isDirectory(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
