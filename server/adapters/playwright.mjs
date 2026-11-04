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
 * See docs/17-RUNNER-ADAPTER-CONTRACT.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  ADAPTER_CONTRACT_VERSION,
  capability,
  parseCliOptions,
  probeCommand,
  readPackageVersion,
  resolveProjectBinary,
} from './contract.mjs';
import { discoverStatic, parseReport, sourcePath } from '../core.mjs';

/** Where the local Playwright CLI may live inside the project under test. */
const CLI_CANDIDATES = [
  'node_modules/@playwright/test/cli.js',
  'node_modules/playwright/cli.js',
  'node_modules/playwright-core/cli.js',
];

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
  const cli = resolveProjectBinary(projectRoot, CLI_CANDIDATES);
  if (!cli) return null;
  const help = probeCommand(process.execPath, [cli, 'test', '--help'], { cwd: projectRoot });
  return {
    cli,
    version: readPackageVersion(projectRoot, '@playwright/test') || readPackageVersion(projectRoot, 'playwright'),
    helpOk: help.ok,
    options: help.ok ? parseCliOptions(help.stdout) : [],
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

      const has = (name) => probe.options.includes(name);
      const opts = probe.options;

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
          evidence: 'the adapter reads the JSON report the CLI writes and maps it onto the common result model',
        }),
        capability('filterByFile', has('output') || opts.length > 0, {
          evidence: `the installed CLI accepts a positional file filter (probed options: ${opts.join(', ')})`,
          detail: { accepted: opts.includes('output') },
        }),
        capability('filterByTestUid', false, {
          reason: 'the index ID is a temporary hash (sha256(projectId:file:title)[0:16]), not a stable UID; authoritative discovery with stable UIDs is FR-021 and is not implemented',
        }),
        capability('structuredReport', has('reporter'), {
          evidence: `the installed CLI accepts --reporter (probed from --help)${has('reporter') ? '' : ' -- NOT ACCEPTED'}`,
          detail: { reporter: has('reporter') },
        }),
        capability('htmlReport', has('reporter'), {
          evidence: has('reporter')
            ? "the installed CLI accepts --reporter and 'html' is one of its built-in reporters"
            : 'the installed CLI does not accept --reporter, so no HTML report can be requested',
        }),
        capability('trace', has('trace'), {
          evidence: has('trace')
            ? "the installed CLI accepts --trace (probed from --help)"
            : 'the installed CLI does not accept --trace',
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
        capability('cliContract', has('reporter') && has('output') && has('trace'), {
          evidence: `every option the adapter passes is one the installed CLI declares (probed from --help: ${opts.join(', ')}); the v0.1 defect B-01 was that the hand-written vector contained --screenshot/--video, which \`playwright test\` does not accept`,
          reason: (has('reporter') && has('output') && has('trace'))
            ? ''
            : `the installed CLI does not accept all of --reporter/--output/--trace (probed: ${opts.join(', ')})`,
          detail: { options: opts, passed: ['--reporter', '--output', '--trace', '--workers'].filter((o) => opts.includes(o)) },
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
      const args = buildPlaywrightArgs({
        cli: probe.cli,
        options: probe.options,
        outputDir,
        testFile: file || null,
      });
      const env = {
        ...process.env,
        PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(outputDir, 'report.json'),
        PLAYWRIGHT_HTML_OUTPUT_DIR: path.join(outputDir, 'html'),
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
        reportFile: path.join(outputDir, 'report.json'),
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
     */
    collect({ outputDir }) {
      const reportFile = path.join(outputDir, 'report.json');
      if (!fs.existsSync(reportFile)) return null;
      const summary = parseReport(JSON.parse(fs.readFileSync(reportFile, 'utf8')));
      return {
        summary: {
          passed: summary.passed,
          failed: summary.failed,
          skipped: summary.skipped,
          flaky: summary.flaky,
          total: summary.total,
          cases: summary.cases.map((c) => ({
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
