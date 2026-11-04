/**
 * ATS-301: Playwright adapter.
 *
 * Implements the runner contract (server/adapters/contract.mjs) on top of the
 * project's own local Playwright CLI. It never installs anything and never
 * falls back to a global binary -- the same trust boundary the Bridge has
 * always had.
 *
 * The one thing this adapter adds over the v0.1 code path is that its
 * argument vector is built from the NEGOTIATED capability set: an option is
 * only passed when the INSTALLED CLI actually accepts it. The v0.1 path built
 * the vector by hand, which is how `--screenshot` / `--video` -- options that
 * `playwright test` does not have -- reached the CLI (baseline defect B-01).
 *
 * MEASURED FACTS (see docs/evidence/ATS-301/01-playwright-ground-truth.log,
 * produced by tools/ats301-probes/playwright-ground-truth.mjs against
 * @playwright/test 1.64.1 on this machine):
 *
 *   - `playwright test --help` accepts --reporter / --output / --trace /
 *     --workers / --grep / --project / --list. It does NOT accept
 *     --screenshot or --video: those are `use` options of the project's
 *     playwright.config, not CLI options.
 *   - The test file is a POSITIONAL argument (`[test-filter...]` in the
 *     usage line), not an option.
 *   - The JSON report arrives through PLAYWRIGHT_JSON_OUTPUT_FILE with the
 *     shape { config, suites, errors, stats }; a suite carries `file`, a spec
 *     carries `title`/`file`, and a test carries `status` ('expected' |
 *     'unexpected' | 'flaky' | 'skipped') plus `results[]`.
 *   - A run with one failing case exits with code 1.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  ADAPTER_CONTRACT_VERSION,
  capability,
  hasPositionalFilter,
  parseCliOptions,
  parseCliUsage,
  probeCommand,
  readPackageVersion,
  resolveProjectBinary,
} from './contract.mjs';
import {
  PLAYWRIGHT_CLI_CANDIDATES,
  buildPlaywrightArgs,
  mapPlaywrightStatus,
  playwrightHtmlDir,
  playwrightReportFile,
  probePlaywrightCli,
} from './playwright-cli.mjs';
import { discoverStatic, parseReport, sourcePath } from '../core.mjs';

/**
 * Read the `use` block of the project's playwright config to find out whether
 * the PROJECT ITSELF produces screenshots / video / trace.
 *
 * This matters because the Playwright CLI has no --screenshot / --video option:
 * those are `use` options of playwright.config.ts. So the honest answer to
 * "can this project produce screenshots?" is a property of the project, not of
 * the CLI -- which is exactly what a per-project capability matrix is for.
 */
function readProjectUseOptions(projectRoot) {
  const candidates = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs', 'playwright.config.mts', 'playwright.config.cts'];
  for (const name of candidates) {
    const p = path.join(projectRoot, name);
    if (!fs.existsSync(p)) continue;
    let text = '';
    try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
    return {
      configFile: name,
      screenshot: /\bscreenshot\s*:\s*['"`]/.test(text),
      video: /\bvideo\s*:\s*['"`]/.test(text),
      trace: /\btrace\s*:\s*['"`]/.test(text),
      retries: /\bretries\s*:\s*(\d+)/.exec(text)?.[1] ?? null,
    };
  }
  return null;
}

/**
 * Probe the INSTALLED CLI for the options it accepts.
 * Returns null when the project has no local Playwright CLI at all.
 */
function probeCli(projectRoot) {
  const probe = probePlaywrightCli(projectRoot);
  if (!probe) return null;
  return {
    ...probe,
    version: readPackageVersion(projectRoot, '@playwright/test') || readPackageVersion(projectRoot, 'playwright'),
  };
}

/**
 * The options the adapter is allowed to pass when the installed CLI's --help
 * could not be parsed.
 *
 * This is a FALLBACK, not a guess: when the help output is unreadable the
 * adapter cannot know the option set, and passing nothing would silently
 * change the run (no --output => no artefacts, no --reporter => no report).
 * The vector below is the one the product has always used and that every
 * Playwright version from 1.x accepts, so it is the conservative choice.
 *
 * The fallback is NOT used to claim a capability: `cliContract` and the
 * option-derived capabilities stay `supported: false` when the help could not
 * be parsed, because "the CLI declares it" was not proven.
 */
export const FALLBACK_PLAYWRIGHT_OPTIONS = Object.freeze([
  'reporter',
  'output',
  'trace',
  'workers',
]);

export function createPlaywrightAdapter() {
  return {
    kind: 'playwright',
    contractVersion: ADAPTER_CONTRACT_VERSION,

    /**
     * Capability matrix for one project.
     * Every entry is either proven on this machine or carries a reason.
     */
    capabilities(project) {
      const root = project.root;
      const probe = probeCli(root);
      const use = readProjectUseOptions(root);

      if (!probe) {
        const reason = 'the project has no local Playwright CLI (node_modules/@playwright/test/cli.js); the adapter never installs one';
        const cap = (name) => capability(name, false, { reason });
        return [
          cap('discover'), cap('start'), cap('stop'), cap('collect'),
          cap('filterByFile'), cap('filterByTestUid'), cap('structuredReport'),
          cap('htmlReport'), cap('trace'), cap('screenshot'), cap('video'),
          cap('cancel'), cap('nativeBrowser'), cap('cliContract'),
        ];
      }

      const opts = probe.options;
      // When the help output could not be parsed the adapter cannot PROVE
      // that the CLI accepts an option. It may still PASS the conservative
      // fallback vector so the run behaves as it always has, but the
      // capability itself stays unsupported -- an unproven claim is a lie.
      const helpReadable = probe.helpOk && opts.length > 0;
      const effective = helpReadable ? opts : [...FALLBACK_PLAYWRIGHT_OPTIONS];
      const has = (name) => effective.includes(name);
      const declared = (name) => opts.includes(name);
      const positional = hasPositionalFilter(probe.usage);

      const unsupportedBecauseUnproven = 'the installed CLI\'s --help output could not be parsed, so it was not proven that the CLI accepts this option';

      const caps = [
        capability('discover', true, {
          evidence: 'the adapter enumerates *.spec/*.test files and test()/it() titles of the project (the same static index the v0.1 /tests endpoint returns)',
          detail: { discovery: 'static-heuristic', engine: 'playwright' },
        }),
        capability('start', true, {
          evidence: `the installed CLI ${probe.version || '?'} was probed at ${probe.cli} and its --help parsed (${opts.length} options)`,
          detail: { cli: probe.cli, version: probe.version },
        }),
        capability('stop', true, {
          evidence: 'the adapter terminates the spawned child process (taskkill /T /F on Windows, SIGTERM elsewhere), the same mechanism the v0.1 path uses',
        }),
        capability('collect', true, {
          evidence: 'the adapter reads the JSON report the CLI writes (PLAYWRIGHT_JSON_OUTPUT_FILE) and maps it onto the common result model',
        }),
        capability('filterByFile', positional, {
          evidence: positional
            ? `the installed CLI takes the test file as a positional argument (usage: ${probe.usage})`
            : '',
          reason: positional ? '' : 'the installed CLI declares no positional test-filter argument in its usage line',
          detail: { usage: probe.usage },
        }),
        capability('filterByTestUid', false, {
          reason: 'the index ID is a temporary hash (sha256(projectId:file:title)[0:16]), not a stable UID; authoritative discovery with stable UIDs is FR-021 and is not implemented',
        }),
        capability('structuredReport', declared('reporter'), {
          evidence: declared('reporter')
            ? 'the installed CLI accepts --reporter (probed from --help)'
            : '',
          reason: declared('reporter') ? '' : (helpReadable ? 'the installed CLI does not accept --reporter' : unsupportedBecauseUnproven),
        }),
        capability('htmlReport', declared('reporter'), {
          evidence: declared('reporter')
            ? "the installed CLI accepts --reporter and 'html' is one of its built-in reporters (measured: the html reporter wrote index.html and a trace/ viewer under PLAYWRIGHT_HTML_OUTPUT_DIR)"
            : '',
          reason: declared('reporter') ? '' : (helpReadable ? 'the installed CLI does not accept --reporter, so no HTML report can be requested' : unsupportedBecauseUnproven),
        }),
        capability('trace', declared('trace'), {
          evidence: declared('trace')
            ? 'the installed CLI accepts --trace (probed from --help); the measured run wrote trace.zip per test under the --output directory'
            : '',
          reason: declared('trace') ? '' : (helpReadable ? 'the installed CLI does not accept --trace' : unsupportedBecauseUnproven),
        }),
        capability('screenshot', Boolean(use && use.screenshot), {
          evidence: use && use.screenshot
            ? `the project's ${use.configFile} declares a use.screenshot option`
            : '',
          reason: use && use.screenshot ? '' : 'the Playwright CLI has no --screenshot option; screenshots come from the project\'s own use.screenshot config, which this project does not set (injecting it is ATS-106)',
          detail: use ? { configFile: use.configFile, projectDeclares: use.screenshot } : {},
        }),
        capability('video', Boolean(use && use.video), {
          evidence: use && use.video
            ? `the project's ${use.configFile} declares a use.video option`
            : '',
          reason: use && use.video ? '' : 'the Playwright CLI has no --video option; video comes from the project\'s own use.video config, which this project does not set (injecting it is ATS-106)',
          detail: use ? { configFile: use.configFile, projectDeclares: use.video } : {},
        }),
        capability('cancel', true, {
          evidence: 'the adapter spawns the CLI without a shell and keeps the child handle, so a cancel request can terminate the process tree',
        }),
        capability('nativeBrowser', true, {
          evidence: 'the adapter runs the project\'s own @playwright/test CLI, which launches a real browser; no stub or double is involved',
        }),
        capability('cliContract', declared('reporter') && declared('output') && declared('trace'), {
          evidence: `every option the adapter passes is one the installed CLI declares (probed from --help: ${opts.join(', ')}); the v0.1 defect B-01 was that the hand-written vector contained --screenshot/--video, which \`playwright test\` does not accept`,
          reason: (declared('reporter') && declared('output') && declared('trace'))
            ? ''
            : (helpReadable
              ? `the installed CLI does not accept all of --reporter/--output/--trace (probed: ${opts.join(', ')})`
              : unsupportedBecauseUnproven),
          detail: { options: opts, passed: ['--reporter', '--output', '--trace', '--workers'].filter((o) => effective.includes(o)) },
        }),
      ];
      return caps;
    },

    /** Enumerate the test cases of a project (the common TestDefinition shape). */
    discover(project) {
      const result = discoverStatic(project);
      return {
        tests: result.tests.map((t) => ({ ...t, runner: 'playwright' })),
        files: result.files,
        warning: result.warning,
        runner: 'playwright',
      };
    },

    /**
     * Start a run.
     * Returns a handle the runtime can stream logs from and stop.
     */
    start({ project, run, file, outputDir }) {
      const probe = probeCli(project.root);
      if (!probe) throw new Error('PLAYWRIGHT_NOT_INSTALLED_RUN_NPM_INSTALL_IN_PROJECT');
      if (file) sourcePath(project, file); // rejects anything outside the project
      // The RUN uses the effective option set (the probed one, or the
      // conservative fallback when the help could not be read). The
      // CAPABILITY report uses the probed one only -- see capabilities().
      const helpReadable = probe.helpOk && probe.options.length > 0;
      const options = helpReadable ? probe.options : [...FALLBACK_PLAYWRIGHT_OPTIONS];
      const args = buildPlaywrightArgs({
        cli: probe.cli,
        options,
        outputDir,
        testFile: file || null,
      });
      const env = {
        ...process.env,
        PLAYWRIGHT_JSON_OUTPUT_FILE: playwrightReportFile(outputDir),
        PLAYWRIGHT_HTML_OUTPUT_DIR: playwrightHtmlDir(outputDir),
        PLAYWRIGHT_HTML_OPEN: 'never',
        CI: '1',
        FORCE_COLOR: '0',
      };
      const child = spawn(process.execPath, args, {
        cwd: project.root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false,
      });
      return {
        child,
        pid: child.pid,
        command: process.execPath,
        args,
        reportFile: playwrightReportFile(outputDir),
        engine: 'playwright',
      };
    },

    /** Stop a run that is already in flight. */
    stop(handle) {
      if (!handle || !handle.child) throw new Error('RUN_NOT_ACTIVE');
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(handle.child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        try { handle.child.kill('SIGTERM'); } catch { /* already gone */ }
      }
    },

    /**
     * Collect the results of a finished run and map them onto the common
     * result model. Returns null when the engine produced no report.
     *
     * The counts are recomputed from the MAPPED statuses, so the summary and
     * the per-case statuses cannot drift apart.
     */
    collect({ outputDir }) {
      const reportFile = playwrightReportFile(outputDir);
      if (!fs.existsSync(reportFile)) return null;
      const raw = parseReport(JSON.parse(fs.readFileSync(reportFile, 'utf8')));
      const cases = raw.cases.map((c) => ({ ...c, status: mapPlaywrightStatus(c.status) }));
      return {
        summary: {
          passed: cases.filter((c) => c.status === 'passed').length,
          failed: cases.filter((c) => c.status === 'failed').length,
          skipped: cases.filter((c) => c.status === 'skipped').length,
          flaky: cases.filter((c) => c.status === 'flaky').length,
          total: cases.length,
          cases: cases.map((c) => ({
            title: c.title,
            file: c.file,
            status: c.status,
            duration: c.duration,
            error: c.error,
          })),
        },
      };
    },
  };
}
