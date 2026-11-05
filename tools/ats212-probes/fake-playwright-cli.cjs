'use strict';
/**
 * A test double for the Playwright CLI that RECORDS the environment it was
 * given (ATS-212).
 *
 * It is the shape of tools/ats201-probes/fake-playwright-cli.cjs -- it
 * writes a report the bridge can read -- with one addition: it also writes
 * the environment it was handed to a side file. That side file is how the
 * test can make an assertion about what the child process RECEIVED, which
 * is the property the acceptance criterion is about: the runner gets the
 * profile's variables, and it does NOT get the host's environment.
 *
 * The environment is written to the file named by ATS_ENV_CAPTURE, which
 * the adapter passes on as an EXTRA variable of its own -- so the capture
 * path cannot be forged by a profile. When that variable is absent the
 * capture lands next to the report instead.
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const out = process.env.PLAYWRIGHT_JSON_OUTPUT_FILE;
const projectDir = process.cwd();
// Where the captured environment goes. The adapter passes ATS_ENV_CAPTURE
// as its OWN variable, so the capture path cannot be forged by a profile.
// When it is absent (the LISTING path does not need one) the capture lands
// next to the report -- so the probe still records what it was handed.
const capture = process.env.ATS_ENV_CAPTURE || (out ? out + '.env.json' : null);

// The captured environment: the variables of the child process, minus the
// ones the capture itself needs.
const captured = {};
for (const [key, value] of Object.entries(process.env)) {
  if (key === 'ATS_ENV_CAPTURE') continue;
  captured[key] = value;
}
if (capture) {
  fs.mkdirSync(path.dirname(capture), { recursive: true });
  fs.writeFileSync(capture, JSON.stringify(captured, null, 2));
}

const target = args.find((a) => !a.startsWith('--') && a.endsWith('.spec.ts')) || 'tests/login.spec.ts';

let rootDir = projectDir;
try {
  const cfg = fs.readFileSync(path.join(projectDir, 'playwright.config.ts'), 'utf8');
  const m = cfg.match(/testDir\s*:\s*['"]([^'"]+)['"]/);
  if (m) rootDir = path.resolve(projectDir, m[1]);
} catch {}

const specPath = path.resolve(projectDir, target);
const relativeFile = path.relative(rootDir, specPath).split(path.sep).join('/');

const src = fs.readFileSync(specPath, 'utf8');
const specs = [];
const re = /(?:^|\n)[ \t]*(?:test|it)[ \t]*\(\s*(['"`])([^\n]*?)\1/g;
let m;
while ((m = re.exec(src)) !== null) {
  const line = src.slice(0, m.index + m[0].length).split('\n').length;
  const body = src.slice(m.index + m[0].length);
  const failed = /register/.test(body);
  specs.push({
    title: m[2],
    line,
    file: relativeFile,
    tests: [{
      status: failed ? 'unexpected' : 'expected',
      results: [{ duration: failed ? 22 : 11, retry: 0, ...(failed ? { error: { message: 'boom' } } : {}) }],
    }],
  });
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({
  config: { rootDir: rootDir.split(path.sep).join('/') },
  suites: [{ file: relativeFile, specs }],
}));
console.log('fake-cli: report written for ' + target + ' (' + specs.length + ' specs)');
