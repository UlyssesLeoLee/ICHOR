/**
 * ATS-202: the NATIVE INDEX ADAPTER -- `playwright test --list`.
 *
 * The v0.1 index (`discoverStatic` in `server/core.mjs`) is a HEURISTIC: it
 * reads the source files and recognises the literal `test('...')` calls. It
 * cannot see a dynamically generated case, a parameterised case, a case
 * declared by a helper, or a case whose title is built at runtime. The
 * Playwright CLI CAN: it loads the project, evaluates the test files and
 * reports the cases it would really run.
 *
 * This module is the adapter around that command. It:
 *
 *   1. runs the PROJECT'S OWN Playwright CLI with `--list --reporter=json`
 *      (never a global binary, never `npx`, and it never installs anything);
 *   2. parses the JSON report into a normalised case list;
 *   3. reports every failure mode DISTINCTLY, because they mean different
 *      things to the caller:
 *
 *      | outcome                          | meaning                                  |
 *      |----------------------------------|------------------------------------------|
 *      | `OK`                             | the listing succeeded                    |
 *      | `PLAYWRIGHT_NOT_INSTALLED`       | the project has no local CLI             |
 *      | `PLAYWRIGHT_LIST_FAILED`          | the CLI failed (see `errors[]`)          |
 *      | `PLAYWRIGHT_LIST_TIMEOUT`        | the listing did not finish in time       |
 *
 * TRUST (this is the reason the module is separate from the rest):
 * `playwright test --list` is NOT a read-only operation. It LOADS the project
 * config (executing its top level) and it EVALUATES the test files (executing
 * their top level) in order to collect the cases. Running it on a repository
 * the user has not vouched for is therefore equivalent to running that
 * repository's code -- the same trust boundary as `playwright test` itself
 * (ADR-005, docs/11-SECURITY-RISK.md). The trust decision lives in
 * `server/discovery/trust.mjs` and is enforced by the CALLER
 * (`discoverTests` in `server/core.mjs`); this module only reports what it
 * found.
 *
 * The facts this module relies on are MEASURED, not assumed -- see
 * `tools/ats202-probes/list-ground-truth.mjs` and
 * `docs/evidence/ATS-202/01-list-ground-truth.log`:
 *
 *   * the JSON reporter writes `{config, suites, errors, stats}`;
 *   * `config.rootDir` is the resolved `testDir`, and `spec.file` is relative
 *     to THAT, not to the project root;
 *   * `spec.id` is `<20 hex>-<20 hex>`: the file half and the test half. It is
 *     deterministic, it survives a body edit and it survives a line shift, and
 *     it changes on a file rename, a retitle and a new `describe` wrapper;
 *   * the `describe` path is reported through the SUITE nesting, and the spec
 *     title is the LEAF title without that path;
 *   * a project matrix reports the same logical case once per Playwright
 *     project, with a different `spec.id` each time.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { PLAYWRIGHT_CLI_CANDIDATES } from '../adapters/playwright-cli.mjs';
import { readPackageVersion, resolveProjectBinary } from '../adapters/contract.mjs';

/** The outcome of a listing. Every value is a stable, machine-readable code. */
export const LIST_OUTCOME = Object.freeze({
  OK: 'OK',
  NO_CLI: 'PLAYWRIGHT_NOT_INSTALLED',
  FAILED: 'PLAYWRIGHT_LIST_FAILED',
  TIMEOUT: 'PLAYWRIGHT_LIST_TIMEOUT',
});

/** The default time budget of one listing. */
export const DEFAULT_LIST_TIMEOUT_MS = 120000;

/**
 * True when `child` is inside `root`.
 *
 * A local copy rather than an import from `server/core.mjs`: the core imports
 * this module, and the dependency has to stay one-way.
 */
function isInside(root, child) {
  const rel = path.relative(root, child);
  return rel !== '' && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel);
}

/**
 * The project-relative path of a file the CLI reported.
 *
 * The CLI spells the file relative to its own `rootDir` (the resolved
 * `testDir`), which is usually NOT the project root. The path is resolved
 * against that `rootDir` and then made relative to the project root -- the
 * same normalisation the UID registry uses, so that a discovered case and a
 * reported case can be compared.
 *
 * Returns null when the file is OUTSIDE the project: a config whose
 * `testDir` points outside the repository would otherwise make the index
 * report files the user cannot reach through the product.
 *
 * The check is made on the RESOLVED path, not on the spelling: a relative
 * path that climbs out of the rootDir (`../a.spec.ts`) resolves to a
 * directory outside the project only when the rootDir is the project's own
 * subdirectory. A path that stays inside after the resolution is inside the
 * project, whatever it looked like before.
 */
export function projectRelativeFile(rawFile, { rootDir = null, projectRoot = null } = {}) {
  if (!rawFile || !projectRoot) return null;
  const raw = String(rawFile);
  let absolute;
  if (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) {
    absolute = path.resolve(raw);
  } else {
    const base = rootDir ? path.resolve(rootDir) : path.resolve(projectRoot);
    absolute = path.resolve(base, raw);
  }
  if (!isInside(projectRoot, absolute)) return null;
  return path.relative(projectRoot, absolute).replace(/\\/g, '/');
}

/**
 * Parses the JSON report of `playwright test --list` into the normalised
 * case list.
 *
 * The report is a tree of suites. The ROOT suite carries no file; the suite
 * below it that carries a file is the FILE suite (its title is the file name
 * and its line is 0); the suites below that are the `describe` blocks. The
 * `describe` path of a case is therefore the chain of suite titles BELOW the
 * file suite -- the file name is not part of it.
 *
 * A logical case is `{file, describePath, title, line}`. The Playwright
 * project matrix reports the same logical case once per project, with a
 * different `spec.id` each time, so the rows are MERGED into one case that
 * carries the per-project spec ids.
 *
 * `skipped` collects the cases the CLI reported for a file OUTSIDE the
 * project. They are reported, never silently dropped.
 */
export function parseListReport(report, { projectRoot = null } = {}) {
  const rootDir = report?.config?.rootDir ?? null;
  const errors = (Array.isArray(report?.errors) ? report.errors : []).map((e) => ({
    message: typeof e === 'string' ? e : String(e?.message ?? e),
    location: e?.location ?? null,
  }));

  /** @type {Map<string, any>} */
  const byKey = new Map();
  const files = new Set();
  const skipped = [];

  const addSpec = (spec, describePath, suiteFile) => {
    const rawFile = spec.file ?? suiteFile ?? '';
    const file = projectRelativeFile(rawFile, { rootDir, projectRoot });
    if (!file) {
      skipped.push({
        file: String(rawFile),
        title: spec.title ?? '',
        reason: 'the CLI reported a file outside the project root',
      });
      return;
    }
    files.add(file);
    const path_ = describePath.filter((p) => typeof p === 'string' && p.length > 0);
    const title = String(spec.title ?? '');
    const line = Number.isInteger(spec.line) ? spec.line : null;
    const key = `${file}\x00${path_.join('\x00')}\x00${title}\x00${line ?? ''}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        file,
        title,
        line,
        column: Number.isInteger(spec.column) ? spec.column : null,
        describePath: path_,
        ok: spec.ok !== false,
        tags: Array.isArray(spec.tags) ? spec.tags : [],
        projects: [],
      };
      byKey.set(key, entry);
    }
    // One spec row per Playwright project.
    for (const t of spec.tests ?? []) {
      const name = t.projectName || t.projectId || '';
      entry.projects.push({
        name,
        specId: spec.id ?? null,
        expectedStatus: t.expectedStatus ?? null,
        annotations: Array.isArray(t.annotations) ? t.annotations : [],
      });
    }
    if (entry.projects.length === 0) {
      entry.projects.push({ name: '', specId: spec.id ?? null, expectedStatus: null, annotations: [] });
    }
  };

  const walk = (suite, describePath) => {
    for (const spec of suite.specs ?? []) addSpec(spec, describePath, suite.file);
    for (const sub of suite.suites ?? []) {
      // The FILE suite is the one whose line is 0: its title is the file name
      // and it is not part of the describe path.
      const isFileSuite = Boolean(sub.file) && sub.line === 0;
      const nextPath = isFileSuite ? describePath : [...describePath, String(sub.title ?? '')];
      walk(sub, nextPath);
    }
  };
  for (const suite of report?.suites ?? []) walk(suite, []);

  const tests = [...byKey.values()].sort((a, b) =>
    a.file === b.file
      ? (a.line ?? 0) - (b.line ?? 0) || a.title.localeCompare(b.title)
      : a.file.localeCompare(b.file)
  );
  return {
    tests,
    files: [...files].sort(),
    rootDir,
    errors,
    skipped,
    version: report?.config?.version ?? null,
  };
}

/**
 * Runs `playwright test --list --reporter=json` in the project and returns
 * the normalised result.
 *
 * The report is written to a TEMPORARY file (never into the project) through
 * `PLAYWRIGHT_JSON_OUTPUT_FILE`, which is how the JSON reporter is told where
 * to write; `--reporter=json` selects the reporter.
 *
 * The child is spawned WITHOUT a shell, with the project's root as the
 * working directory -- the same trust boundary the run path has.
 */
export function listTests(project, { timeoutMs = DEFAULT_LIST_TIMEOUT_MS } = {}) {
  const prep = prepareListing(project, timeoutMs);
  if (prep.error) return prep.error;
  const r = spawnSync(process.execPath, [prep.cli, 'test', '--list', '--reporter=json'], {
    cwd: prep.root,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      PLAYWRIGHT_JSON_OUTPUT_FILE: prep.reportFile,
      CI: '1',
      FORCE_COLOR: '0',
    },
  });
  prep.durationMs = Date.now() - prep.started;
  return finishListing(prep, r);
}

/**
 * The asynchronous variant of `listTests`.
 *
 * WHY IT EXISTS
 * -------------
 * The listing is a CHILD PROCESS that runs the PROJECT'S OWN CODE: it loads
 * the config (executing its top level) and it evaluates the test files. A
 * project whose config takes four seconds therefore takes four seconds.
 *
 * The synchronous variant blocks the CALLER for those four seconds -- and
 * the caller is the Bridge's request handler, so the whole Bridge stops
 * answering: the health check, the catalogue of another project, and the
 * STOP BUTTON of a running test all wait for the listing to finish. A user
 * who opens a catalogue cannot stop the test they are watching.
 *
 * The asynchronous variant awaits the child instead, so the event loop keeps
 * turning and the Bridge keeps answering while a project is listed.
 *
 * The two variants build the SAME answer: the parsing, the failure modes
 * and the report normalisation are shared, so the two cannot drift apart.
 */
export async function listTestsAsync(project, { timeoutMs = DEFAULT_LIST_TIMEOUT_MS } = {}) {
  const prep = prepareListing(project, timeoutMs);
  if (prep.error) return prep.error;
  const r = await spawnAsync(process.execPath, [prep.cli, 'test', '--list', '--reporter=json'], {
    cwd: prep.root,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      PLAYWRIGHT_JSON_OUTPUT_FILE: prep.reportFile,
      CI: '1',
      FORCE_COLOR: '0',
    },
  });
  prep.durationMs = Date.now() - prep.started;
  return finishListing(prep, r);
}

/**
 * Spawns a child process and resolves with its result.
 *
 * The result has the same shape as the one `spawnSync` returns, so the two
 * listing variants can share the parsing.
 *
 * The timeout is enforced HERE rather than by the operating system: a
 * child that ignores the timeout is KILLED, and the outcome is the same
 * `PLAYWRIGHT_LIST_TIMEOUT` the synchronous variant reports.
 */
function spawnAsync(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = options.timeout > 0
      ? setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill('SIGKILL'); } catch { /* the child is already gone */ }
        resolve({
          error: Object.assign(new Error(`spawnSync ${command} ETIMEDOUT`), { code: 'ETIMEDOUT' }),
          stdout,
          stderr,
          status: null,
          signal: 'SIGKILL'
        });
      }, options.timeout)
      : null;

    child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ error, stdout, stderr, status: null, signal: null });
    });
    child.on('close', (status, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ error: undefined, stdout, stderr, status, signal });
    });
  });
}

/**
 * The shared preparation of a listing: the CLI, the report file and the
 * failure answers that do not need a child process at all.
 */
function prepareListing(project, timeoutMs) {
  const root = project?.root;
  const empty = (outcome, reason, extra = {}) => ({
    ok: false,
    outcome,
    reason,
    cli: null,
    version: null,
    rootDir: null,
    tests: [],
    files: [],
    errors: [],
    skipped: [],
    exitCode: null,
    durationMs: 0,
    ...extra,
  });

  if (!root) return { error: empty(LIST_OUTCOME.NO_CLI, 'the project has no root directory') };
  const cli = resolveProjectBinary(root, PLAYWRIGHT_CLI_CANDIDATES);
  if (!cli) {
    return {
      error: empty(
        LIST_OUTCOME.NO_CLI,
        'the project has no local Playwright CLI (node_modules/@playwright/test/cli.js); the adapter never installs one'
      )
    };
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ats202-list-'));
  return {
    root,
    cli,
    work,
    reportFile: path.join(work, 'list.json'),
    timeoutMs,
    started: Date.now(),
    durationMs: 0,
    error: null
  };
}

/**
 * The shared completion of a listing: the report is read, parsed and turned
 * into the normalised result, and the temporary directory is removed.
 */
function finishListing(prep, r) {
  const { cli, root, reportFile, work } = prep;
  const durationMs = prep.durationMs;
  const empty = (outcome, reason, extra = {}) => ({
    ok: false,
    outcome,
    reason,
    cli: null,
    version: null,
    rootDir: null,
    tests: [],
    files: [],
    errors: [],
    skipped: [],
    exitCode: null,
    durationMs: 0,
    ...extra,
  });
  try {
    if (r.error && /ETIMEDOUT|timed out/i.test(String(r.error.message))) {
      return empty(LIST_OUTCOME.TIMEOUT, `the listing did not finish within ${prep.timeoutMs ?? DEFAULT_LIST_TIMEOUT_MS}ms`, {
        cli, durationMs, exitCode: r.status ?? null,
      });
    }
    if (r.error && r.error.code === 'ENOENT') {
      return empty(LIST_OUTCOME.NO_CLI, `the Playwright CLI could not be started: ${r.error.message}`, {
        cli, durationMs, exitCode: r.status ?? null,
      });
    }

    const reportExists = fs.existsSync(reportFile);
    if (!reportExists) {
      // The CLI died before it could write a report -- a broken project config
      // is the usual cause. Its own message is the only useful diagnosis.
      const stderr = String(r.stderr || '').trim();
      return empty(LIST_OUTCOME.FAILED, 'the Playwright CLI could not list the project', {
        cli,
        durationMs,
        exitCode: r.status ?? null,
        errors: stderr ? [{ message: stderr.split('\n')[0], location: null }] : [],
      });
    }

    let report = null;
    try {
      report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    } catch (e) {
      return empty(LIST_OUTCOME.FAILED, 'the Playwright CLI wrote a report that is not valid JSON', {
        cli, durationMs, exitCode: r.status ?? null,
        errors: [{ message: String(e.message), location: null }],
      });
    }

    const parsed = parseListReport(report, { projectRoot: root });
    const version = parsed.version
      ?? readPackageVersion(root, '@playwright/test')
      ?? readPackageVersion(root, 'playwright');

    // The CLI exits non-zero when it could not enumerate the project -- a
    // broken config, a duplicate title, a project with no tests. The report
    // then carries the reason in `errors[]`. A listing that produced errors
    // is NOT a usable index: it is reported as a failure.
    if (parsed.errors.length > 0) {
      return {
        ok: false,
        outcome: LIST_OUTCOME.FAILED,
        reason: 'the Playwright CLI could not enumerate the project',
        cli,
        version,
        rootDir: parsed.rootDir,
        tests: parsed.tests,
        files: parsed.files,
        errors: parsed.errors,
        skipped: parsed.skipped,
        exitCode: r.status ?? null,
        durationMs,
      };
    }

    return {
      ok: true,
      outcome: LIST_OUTCOME.OK,
      reason: '',
      cli,
      version,
      rootDir: parsed.rootDir,
      tests: parsed.tests,
      files: parsed.files,
      errors: [],
      skipped: parsed.skipped,
      exitCode: r.status ?? null,
      durationMs,
    };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
