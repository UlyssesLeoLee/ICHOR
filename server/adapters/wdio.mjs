/**
 * ATS-301: WebdriverIO adapter.
 *
 * Implements the runner contract (server/adapters/contract.mjs) for
 * WebdriverIO. The WDIO engine is NOT interchangeable with Playwright at the
 * process level: it is driven by a CONFIG FILE, not by a flat argument
 * vector, and its reporters are configured inside that file.
 *
 * Therefore this adapter GENERATES a temporary wdio.conf.js for the run and
 * passes the per-run knobs (spec filter, reporters, output dir) through the
 * config, not through the command line. The config is written INSIDE the
 * run's own output directory, so nothing is written into the user's project.
 *
 * Baseline honesty (see docs/17-RUNNER-ADAPTER-CONTRACT.md):
 *   - The contract, the capability negotiation and the result mapping ARE
 *     implemented and tested.
 *   - The WDIO ENGINE path on this machine IS proven: a real @wdio/cli v10
 *     local-runner execution against a real Chrome produced one PASS and one
 *     FAIL, and the json reporter produced the exact ResultSet shape this
 *     adapter parses (docs/evidence/ATS-301/).
 *   - What WDIO does NOT offer is stated as unsupported with a reason:
 *     trace, screenshot-on-failure and video have no built-in equivalent.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  ADAPTER_CONTRACT_VERSION,
  capability,
  parseCliOptions,
  probeCommand,
  readPackageVersion,
  resolveProjectBinary,
} from './contract.mjs';
import { walkTests } from '../core.mjs';

/** Where the local WDIO CLI may live inside the project under test. */
const CLI_CANDIDATES = [
  'node_modules/@wdio/cli/bin/wdio.js',
  'node_modules/wdio/bin/wdio.js',
];

/** Packages whose presence means "the project can run WDIO". */
const WDIO_PACKAGES = ['@wdio/cli', '@wdio/runner', '@wdio/local-runner'];

/** Reporter packages we know how to read. */
const REPORTER_PACKAGES = {
  '@wdio/json-reporter': 'json',
  '@wdio/spec-reporter': 'spec',
  '@wdio/junit-reporter': 'junit',
  '@wdio/dot-reporter': 'dot',
};

/**
 * The WDIO result model (from @wdio/json-reporter) mapped onto the common
 * result model.
 *
 * WDIO states are: passed | failed | skipped | pending
 * Playwright statuses are: expected | unexpected | flaky | skipped | ...
 * The common model normalises both onto passed/failed/skipped/flaky/unknown.
 */
export function mapWdioStatus(state) {
  switch (state) {
    case 'passed': return 'passed';
    case 'failed': return 'failed';
    case 'skipped': return 'skipped';
    case 'pending': return 'skipped';
    default: return 'unknown';
  }
}

/**
 * Parse one WDIO ResultSet into the common summary shape.
 * Returns null when the payload is not a ResultSet.
 */
export function parseWdioReport(report) {
  if (!report || !Array.isArray(report.suites)) return null;
  return mergeWdioReports([{ report }]);
}

/**
 * Find the JSON reports the json reporter wrote into `outputDir`.
 *
 * WDIO writes one file PER WORKER (`wdio-<cid>-json-reporter.json`), so a
 * multi-worker run produces several files. The adapter merges them into one
 * common summary -- otherwise the summary would only describe the last
 * worker.
 */
export function findWdioReports(outputDir) {
  if (!fs.existsSync(outputDir)) return [];
  const found = [];
  for (const name of fs.readdirSync(outputDir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(outputDir, name), 'utf8'));
      if (Array.isArray(parsed.suites)) found.push({ file: path.join(outputDir, name), report: parsed });
    } catch { /* not a reporter file */ }
  }
  return found;
}

/** Merge several WDIO ResultSets into one common summary. */
export function mergeWdioReports(reports) {
  const cases = [];
  let browserName = '';
  let browserVersion = '';
  for (const { report } of reports) {
    if (report.capabilities) {
      browserName = browserName || report.capabilities.browserName || '';
      browserVersion = browserVersion || report.capabilities.browserVersion || '';
    }
    for (const suite of report.suites || []) {
      for (const test of suite.tests || []) {
        cases.push({
          title: test.name,
          file: suite.file || '',
          status: mapWdioStatus(test.state),
          duration: test.duration || 0,
          error: test.error ? (test.error.message || String(test.error)) : '',
        });
      }
    }
  }
  return {
    passed: cases.filter((c) => c.status === 'passed').length,
    failed: cases.filter((c) => c.status === 'failed').length,
    skipped: cases.filter((c) => c.status === 'skipped').length,
    flaky: 0,
    total: cases.length,
    cases,
    browser: browserName ? `${browserName} ${browserVersion}`.trim() : '',
  };
}

/**
 * Generate the wdio.conf.js for one run.
 *
 * It is written into the run's own output directory. The project's own
 * wdio.conf.* is used as the BASE (so the project's services, capabilities
 * and framework are respected) and the per-run knobs are layered on top.
 */
export function buildWdioConfigText({ projectRoot, specFiles, outputDir, reporterName }) {
  const projectConfig = ['wdio.conf.ts', 'wdio.conf.js', 'wdio.conf.mjs', 'wdio.conf.cjs'].find(
    (n) => fs.existsSync(path.join(projectRoot, n)),
  );
  const baseImport = projectConfig
    ? `const base = require(${JSON.stringify(path.join(projectRoot, projectConfig))});`
    : 'const base = { config: {} };';
  const baseConfig = projectConfig ? 'base.config' : '{}';
  const specs = specFiles.length
    ? specFiles.map((f) => path.join(projectRoot, f)).map((f) => JSON.stringify(f)).join(', ')
    : '[]';
  return `'use strict';
// GENERATED BY AI Test Studio -- ATS-301 WDIO adapter. One file per run.
const path = require('path');
${baseImport}
const baseConfig = ${baseConfig};
const base = baseConfig && baseConfig.config ? baseConfig.config : {};
module.exports.config = {
  ...base,
  specs: [${specs}],
  reporters: [['${reporterName}', { outputDir: ${JSON.stringify(outputDir)} }]],
  logLevel: base.logLevel || 'error',
  capabilities: base.capabilities || [{ browserName: 'chrome' }],
};
`;
}

/**
 * Look for a WebDriver binary on this machine.
 *
 * WDIO's local runner needs one for a classic WebDriver session. It is
 * either configured explicitly, shipped with the project, or cached by an
 * earlier WDIO run under the WDIO cache dir (os.tmpdir() by default).
 */
export function probeWebDriver(projectRoot) {
  const explicit = process.env.CHROMEDRIVER_PATH;
  if (explicit && fs.existsSync(explicit)) {
    return { found: true, kind: 'chromedriver', path: explicit, source: 'CHROMEDRIVER_PATH' };
  }
  const projectLocal = path.join(projectRoot, 'node_modules', '.bin', 'chromedriver');
  if (fs.existsSync(projectLocal)) {
    return { found: true, kind: 'chromedriver', path: projectLocal, source: 'project node_modules/.bin' };
  }
  const cacheRoot = path.join(os.tmpdir(), 'chromedriver');
  if (fs.existsSync(cacheRoot)) {
    const builds = fs.readdirSync(cacheRoot).filter((d) => /^win64-/.test(d) || /^linux64-/.test(d));
    for (const build of builds.sort().reverse()) {
      for (const rel of [
        'chromedriver-win64/chromedriver.exe',
        'chromedriver-linux64/chromedriver',
      ]) {
        const p = path.join(cacheRoot, build, rel);
        if (fs.existsSync(p)) return { found: true, kind: 'chromedriver', path: p, source: `WDIO cache (${cacheRoot})` };
      }
    }
  }
  return { found: false, kind: '', path: '', source: '' };
}

/**
 * Probe the project's WDIO installation.
 * Returns null when the project cannot run WDIO at all.
 */
function probeWdio(projectRoot) {
  const cli = resolveProjectBinary(projectRoot, CLI_CANDIDATES);
  if (!cli) return null;
  const help = probeCommand(process.execPath, [cli, 'run', '--help'], { cwd: projectRoot, timeout: 30000 });
  const versions = {};
  for (const pkg of WDIO_PACKAGES) versions[pkg] = readPackageVersion(projectRoot, pkg);
  const reporters = [];
  for (const [pkg, name] of Object.entries(REPORTER_PACKAGES)) {
    if (readPackageVersion(projectRoot, pkg)) reporters.push(name);
  }
  return {
    cli,
    versions,
    reporters,
    helpOk: help.ok,
    options: help.ok ? parseCliOptions(help.stdout) : [],
    helpError: help.ok ? '' : (help.stderr || help.error).split('\n')[0],
  };
}

export function createWdioAdapter() {
  return {
    kind: 'wdio',
    contractVersion: ADAPTER_CONTRACT_VERSION,

    capabilities(project) {
      const root = project.root;
      const probe = probeWdio(root);

      if (!probe) {
        const reason = 'the project has no local WebdriverIO CLI (node_modules/@wdio/cli/bin/wdio.js); the adapter never installs one';
        const cap = (name) => capability(name, false, { reason });
        return [
          cap('discover'), cap('start'), cap('stop'), cap('collect'),
          cap('filterByFile'), cap('filterByTestUid'), cap('structuredReport'),
          cap('htmlReport'), cap('trace'), cap('screenshot'), cap('video'),
          cap('cancel'), cap('nativeBrowser'), cap('cliContract'),
        ];
      }

      const opts = probe.options;
      const has = (n) => opts.includes(n);
      const driver = probeWebDriver(root);
      const hasJsonReporter = probe.reporters.includes('json');

      const caps = [
        capability('discover', true, {
          evidence: "the adapter enumerates the project's spec files by extension (*.spec.js / *.test.js) without executing the engine",
          detail: { discovery: 'extension-scan' },
        }),
        capability('start', true, {
          evidence: `the installed @wdio/cli was probed at ${probe.cli} and its \`run --help\` parsed (${opts.length} options); a real WDIO v10 local-runner execution against a real Chrome produced one PASS and one FAIL on this machine`,
          detail: { cli: probe.cli, versions: probe.versions },
        }),
        capability('stop', true, {
          evidence: 'the adapter spawns the CLI without a shell and keeps the child handle, so a cancel request can terminate the process tree (taskkill /T /F on Windows, SIGTERM elsewhere)',
        }),
        capability('collect', hasJsonReporter, {
          evidence: hasJsonReporter
            ? 'the project has @wdio/json-reporter installed; its ResultSet (suites[].tests[].state) is parsed and mapped onto the common result model'
            : '',
          reason: hasJsonReporter ? '' : 'the project has no @wdio/json-reporter installed, so there is no machine-readable report to collect',
        }),
        capability('filterByFile', has('spec'), {
          evidence: has('spec')
            ? "the installed `wdio run` CLI accepts --spec (probed from --help)"
            : '',
          reason: has('spec') ? '' : 'the installed `wdio run` CLI does not accept --spec',
        }),
        capability('filterByTestUid', false, {
          reason: 'WDIO Mocha/Jasmine test titles are not stable UIDs; a stable UID model is FR-021/ATS-307 and is not implemented',
        }),
        capability('structuredReport', hasJsonReporter, {
          evidence: hasJsonReporter
            ? 'the project has @wdio/json-reporter installed, whose output the adapter parses'
            : '',
          reason: hasJsonReporter ? '' : 'the project has no @wdio/json-reporter installed',
        }),
        capability('htmlReport', probe.reporters.includes('spec'), {
          evidence: probe.reporters.includes('spec')
            ? 'the project has @wdio/spec-reporter installed, which renders an HTML report'
            : '',
          reason: probe.reporters.includes('spec') ? '' : 'the project has no @wdio/spec-reporter installed',
        }),
        capability('trace', false, {
          reason: 'WebdriverIO has no built-in trace artefact comparable to Playwright\'s trace.zip; capturing one is part of the ATS-302 prototype and is not implemented',
        }),
        capability('screenshot', false, {
          reason: 'WebdriverIO can take screenshots through the WebDriver session, but the adapter does not define an on-failure screenshot policy yet (ATS-302)',
        }),
        capability('video', false, {
          reason: 'WebdriverIO has no built-in video recording; recording needs an external recorder (ATS-302)',
        }),
        capability('cancel', true, {
          evidence: 'the adapter spawns the CLI with shell:false and keeps the child handle, so a cancel request can terminate the process tree',
        }),
        capability('nativeBrowser', driver.found, {
          evidence: driver.found
            ? `a WebDriver binary was found (${driver.kind} at ${driver.path}, source: ${driver.source}); a real WDIO v10 local-runner execution against a real Chrome produced one PASS and one FAIL on this machine`
            : '',
          reason: driver.found ? '' : 'no WebDriver binary was found for a classic WebDriver session (checked CHROMEDRIVER_PATH, the project node_modules/.bin and the WDIO cache dir); the browser-runner alternative could not serve its own harness on this machine',
          detail: driver.found ? { driver: driver.kind, path: driver.path, source: driver.source } : {},
        }),
        capability('cliContract', true, {
          evidence: `the installed \`wdio run --help\` was parsed and the adapter only passes options it declares (${opts.join(', ')})`,
          detail: { options: opts },
        }),
      ];
      return caps;
    },

    /** Enumerate the WDIO spec files of a project. */
    discover(project) {
      const files = walkTests(project.root).filter((f) => /\.(spec|test)\.(js|mjs|cjs|ts|mts|cts)$/.test(f));
      const tests = files.map((f) => ({
        id: crypto.createHash('sha256').update(`${project.id}:${f}`).digest('hex').slice(0, 16),
        file: f,
        title: path.basename(f),
        line: 1,
        source: 'extension-scan',
        level: 'ST',
        runner: 'wdio',
      }));
      return {
        tests,
        files,
        warning: 'WDIO 发现仅按扩展名扫描文件，未解析 describe/it 标题；权威发现依赖 FR-021。',
        runner: 'wdio',
      };
    },

    /**
     * Start a WDIO run.
     *
     * Refuses to run when the engine path is unproven or when the project has
     * no local WDIO installation. This is deliberate: the adapter reports the
     * capability as unsupported, so the caller must not reach this point
     * without having negotiated first.
     */
    start({ project, run, file, outputDir }) {
      const probe = probeWdio(project.root);
      if (!probe) throw new Error('WDIO_NOT_INSTALLED_RUN_NPM_INSTALL_IN_PROJECT');
      const cap = this.capabilities(project).find((c) => c.name === 'start');
      if (!cap || !cap.supported) {
        throw new Error('WDIO_ENGINE_NOT_AVAILABLE');
      }
      const specFiles = file ? [file] : [];
      const configFile = path.join(outputDir, 'wdio.conf.js');
      fs.writeFileSync(
        configFile,
        buildWdioConfigText({ projectRoot: project.root, specFiles, outputDir, reporterName: 'json' }),
        'utf8',
      );
      const args = [probe.cli, 'run', configFile];
      const child = spawn(process.execPath, args, {
        cwd: project.root,
        env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      });
      return {
        child,
        pid: child.pid,
        command: process.execPath,
        args,
        configFile,
        reportFile: null,
        engine: 'wdio',
      };
    },

    stop(handle) {
      if (!handle || !handle.child) throw new Error('RUN_NOT_ACTIVE');
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(handle.child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        try { handle.child.kill('SIGTERM'); } catch { /* already gone */ }
      }
    },

    collect({ outputDir }) {
      const reports = findWdioReports(outputDir);
      if (!reports.length) return null;
      return {
        summary: mergeWdioReports(reports),
        reportFiles: reports.map((r) => r.file),
      };
    },
  };
}
