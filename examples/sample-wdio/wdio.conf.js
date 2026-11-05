/**
 * ATS-301 fixture: a minimal WebdriverIO configuration.
 *
 * The adapter layers the per-run knobs on top of this file (it writes its own
 * generated config into the run's output directory and uses this one as the
 * base), so this file only has to declare the parts that are properties of the
 * PROJECT: the framework, the runner and the browser capability.
 *
 * `browserName: 'chrome'` with no `wdio:chromedriverOptions.binary` means
 * WDIO starts the browser through the WebDriver binary it finds. The adapter
 * probes for one and reports `nativeBrowser: false` with a reason when there
 * is none -- see server/adapters/wdio.mjs.
 */
exports.config = {
  runner: 'local',
  framework: 'mocha',
  specs: ['./tests/pass.spec.js', './tests/fail.spec.js'],
  reporters: ['spec'],
  logLevel: 'error',
  maxInstances: 1,
  capabilities: [
    {
      browserName: 'chrome',
      'goog:chromeOptions': {
        args: ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      },
    },
  ],
};
