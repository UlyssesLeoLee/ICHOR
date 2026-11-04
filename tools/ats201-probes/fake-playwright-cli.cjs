'use strict';
/**
 * A test double for the Playwright CLI, used by tools/ats201-probes/uid-e2e.mjs.
 *
 * It is NOT Playwright and it never runs a browser. It models the SHAPE of
 * the real JSON report, which is what the UID scheme depends on:
 *
 *   * `config.rootDir` is the resolved `testDir` of the project config, and
 *     `spec.file` is relative to it -- not to the project root;
 *   * `spec.line` is the line of the `test(` call itself;
 *   * a retried case is one entry whose `results[]` holds one element per
 *     retry;
 *   * `results[].retry` carries the retry index.
 *
 * The model is checked against the real Playwright by
 * tools/ats201-probes/attempt-binding-real-pw.mjs.
 *
 * It is installed into the fixture as `node_modules/@playwright/test/cli.js`
 * so that the bridge resolves it exactly like a real installation.
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const out = process.env.PLAYWRIGHT_JSON_OUTPUT_FILE;
const projectDir = process.cwd();

const target = args.find((a) => !a.startsWith('--') && a.endsWith('.spec.ts')) || 'tests/login.spec.ts';

// The rootDir of a real run is the resolved `testDir` of the project config.
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
  // The line of the `test(` call itself.
  const line = src.slice(0, m.index + m[0].length).split('\n').length;
  const body = src.slice(m.index + m[0].length);
  const failed = /register/.test(body);
  specs.push({
    title: m[2],
    line,
    file: relativeFile,
    tests: [{
      status: failed ? 'unexpected' : 'expected',
      results: [{ duration: failed ? 22 : 11, retry: 0, ...(failed ? { error: { message: 'boom' } } : {}) }]
    }]
  });
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({
  config: { rootDir: rootDir.split(path.sep).join('/') },
  suites: [{ file: relativeFile, specs }]
}));
console.log('fake-cli: report written for ' + target + ' (' + specs.length + ' specs)');
