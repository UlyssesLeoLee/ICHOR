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
 * Build the CLI argument vector from the probed option set.
 *
 * Only options the installed CLI accepts are passed. Options that take a
 * value are passed as two argv entries; boolean flags as one.
 */
export function buildPlaywrightArgs({ cli, options, outputDir, testFile }) {
  const has = (name) => options.includes(name);
  const args = [cli, 'test'];
  if (has('reporter')) args.push('--reporter=line,json,html');
  if (has('output')) args.push('--output', path.join(outputDir, 'results'));
  if (has('trace')) args.push('--trace', 'on');
  if (has('workers')) args.push('--workers', '1');
  if (testFile) args.push(testFile);
  return args;
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
